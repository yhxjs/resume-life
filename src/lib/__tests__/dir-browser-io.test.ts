import fs from "node:fs";
import io from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_file, _args, _options, callback) => callback(null, "C:\\\r\n")),
}));
import { listDirectory } from "../repo-scanner/dir-browser";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-browser-io-")); });
afterEach(() => {
  vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-browser-io-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("目录浏览的异步读盘与取消", () => {
  it("目标和子目录不使用同步文件系统读取", async () => {
    const child = path.join(directory, "child");
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(child, "package.json"), "{}");
    const stat = vi.spyOn(fs, "statSync").mockImplementation(() => { throw new Error("不允许同步读取目录"); });
    const read = vi.spyOn(fs, "readdirSync").mockImplementation(() => { throw new Error("不允许同步读取目录"); });
    const response = await listDirectory(directory);
    expect(response.entries).toEqual([{ name: "child", path: child, isDirectory: true, hasMarkers: true }]);
    expect(stat).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("取消的请求不再读取目录", async () => {
    const controller = new AbortController();
    controller.abort();
    const stat = vi.spyOn(io, "stat");
    const read = vi.spyOn(io, "readdir");
    await expect(listDirectory(directory, controller.signal)).rejects.toMatchObject({ status: 499, message: "请求已取消" });
    expect(stat).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("慢目标读取等待期间，事件循环仍能处理其他工作", async () => {
    const original = io.readdir;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = vi.spyOn(io, "readdir").mockImplementation((async (...args: Parameters<typeof io.readdir>) => {
      if (String(args[0]) === directory) { started.resolve(); await release.promise; }
      return original(...args);
    }) as typeof io.readdir);
    const pending = listDirectory(directory);
    try {
      // 兼容旧实现没有发起异步读取，以明确断言失败而不是等待到测试超时。
      await Promise.race([started.promise, pending]);
      expect(read).toHaveBeenCalled();
      let workRan = false;
      await new Promise<void>(resolve => setImmediate(() => { workRan = true; resolve(); }));
      expect(workRan).toBe(true);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("找到工程标识后立即关闭子目录，不再读取后续名称", async () => {
    const child = path.join(directory, "child");
    fs.mkdirSync(child);
    const read = vi.fn().mockResolvedValueOnce({ name: "package.json" }).mockRejectedValue(new Error("不应再读取后续名称"));
    const close = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(io, "opendir").mockResolvedValue({ read, close } as unknown as fs.Dir);
    const fullRead = vi.spyOn(io, "readdir");
    const result = await listDirectory(directory);
    expect(result.entries).toMatchObject([{ path: child, hasMarkers: true }]);
    expect(read).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(fullRead.mock.calls.map(([requested]) => String(requested))).toEqual([directory]);
  });

  it("标识探测读取异常仍关闭句柄，且保留父目录条目", async () => {
    fs.mkdirSync(path.join(directory, "child"));
    const close = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(io, "opendir").mockResolvedValue({ read: vi.fn().mockRejectedValue(new Error("合成读取失败")), close } as unknown as fs.Dir);
    expect((await listDirectory(directory)).entries).toMatchObject([{ name: "child", hasMarkers: false }]);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([false, true])("子目录探测限制四路并发，取消后不再打开余下目录（cancel=%s）", async cancel => {
    for (let index = 0; index < 12; index++) fs.mkdirSync(path.join(directory, `child-${index}`));
    const controller = new AbortController();
    const release = Promise.withResolvers<void>();
    const reads = vi.fn().mockResolvedValue(null);
    const close = vi.fn();
    let active = 0;
    let peak = 0;
    const open = vi.spyOn(io, "opendir").mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await release.promise;
      return { read: reads, close: async () => { active--; close(); } } as unknown as fs.Dir;
    });
    const pending = listDirectory(directory, controller.signal);
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    try {
      await expect.poll(() => open.mock.calls.length).toBe(4);
      if (cancel) controller.abort();
      release.resolve();
      const settled = await outcome;
      expect(peak).toBe(4);
      expect(active).toBe(0);
      if (cancel) {
        expect(settled).toMatchObject({ error: { status: 499 } });
        expect(open).toHaveBeenCalledTimes(4);
        expect(close).toHaveBeenCalledTimes(4);
        expect(reads).not.toHaveBeenCalled();
      } else {
        expect(settled).toMatchObject({ value: { entries: expect.any(Array) } });
        expect("value" in settled && settled.value.entries).toHaveLength(12);
        expect(open).toHaveBeenCalledTimes(12);
        expect(close).toHaveBeenCalledTimes(12);
      }
    } finally {
      controller.abort(); release.resolve(); await outcome;
    }
  });

  it("目标stat等待期间取消，不继续列目录", async () => {
    const actual = await io.stat(directory);
    const release = Promise.withResolvers<typeof actual>();
    vi.spyOn(io, "stat").mockReturnValue(release.promise);
    const read = vi.spyOn(io, "readdir");
    const controller = new AbortController();
    const pending = listDirectory(directory, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ status: 499 });
    controller.abort();
    release.resolve(actual);
    await rejected;
    expect(read).not.toHaveBeenCalled();
  });

  it("并发回包先后不改变同一列表的名称排序与标识优先级", async () => {
    for (const name of ["child-10", "child-2", "child-1"]) fs.mkdirSync(path.join(directory, name));
    const gates = new Map<string, ReturnType<typeof Promise.withResolvers<fs.Dir>>>();
    vi.spyOn(io, "opendir").mockImplementation(async requested => {
      const gate = Promise.withResolvers<fs.Dir>();
      gates.set(path.basename(String(requested)), gate);
      return gate.promise;
    });
    const pending = listDirectory(directory);
    const handle = (marker: boolean) => ({
      read: vi.fn().mockResolvedValueOnce(marker ? { name: "README.md" } : null).mockResolvedValue(null),
      close: vi.fn().mockResolvedValue(undefined),
    }) as unknown as fs.Dir;
    try {
      await expect.poll(() => gates.size).toBe(3);
      gates.get("child-10")!.resolve(handle(false));
      gates.get("child-2")!.resolve(handle(true));
      gates.get("child-1")!.resolve(handle(false));
      expect((await pending).entries.map(entry => entry.name)).toEqual(["child-2", "child-1", "child-10"]);
    } finally {
      for (const gate of gates.values()) gate.resolve(handle(false));
      await pending;
    }
  });
});
