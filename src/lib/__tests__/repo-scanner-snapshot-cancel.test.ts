import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import io from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectRepoSourceSnapshot } from "../repo-scanner/source-snapshot";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-snapshot-cancel-"));
  fs.writeFileSync(path.join(directory, "README.md"), "SYNTHETIC_SOURCE_MUST_NOT_BE_RETURNED_AFTER_CANCEL");
});
afterEach(() => {
  vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-snapshot-cancel-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});

const phases = ["root-realpath", "readdir", "lstat", "file-realpath", "open", "stat", "read", "close"] as const;
type Phase = typeof phases[number];

describe("源码快照异步 I/O 取消", () => {
  it.each(phases)("%s 等待期间取消，不开始下一步 I/O，不返回成功且释放句柄", async phase => {
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: Phase[] = [];
    const handles: Awaited<ReturnType<typeof io.open>>[] = [];
    async function checkpoint<T>(step: Phase, value: T): Promise<T> {
      events.push(step);
      if (step === phase) { ready.resolve(); await release.promise; }
      return value;
    }
    const realpath = io.realpath.bind(io);
    const readdir = io.readdir.bind(io);
    const lstat = io.lstat.bind(io);
    const open = io.open.bind(io);
    vi.spyOn(io, "realpath").mockImplementation(async (...args) => checkpoint(args[0] === directory ? "root-realpath" : "file-realpath", await realpath(...args)));
    vi.spyOn(io, "readdir").mockImplementation(async (...args) => checkpoint("readdir", await readdir(...args)));
    vi.spyOn(io, "lstat").mockImplementation(async (...args) => checkpoint("lstat", await lstat(...args)));
    vi.spyOn(io, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      handles.push(handle);
      const stat = handle.stat.bind(handle);
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async (...args) => checkpoint("stat", await stat(...args)));
      vi.spyOn(handle, "read").mockImplementation(async (...args) => checkpoint("read", await read(...args)));
      vi.spyOn(handle, "close").mockImplementation(async () => { await close(); await checkpoint("close", undefined); });
      return checkpoint("open", handle);
    });

    const reason = new Error("SYNTHETIC_CANCELLED_SNAPSHOT");
    const snapshot = collectRepoSourceSnapshot([{ path: directory }], controller.signal);
    const rejected = expect(snapshot).rejects.toBe(reason);
    try {
      await ready.promise;
      controller.abort(reason);
    } finally { release.resolve(); }
    await rejected;
    const expected = phases.slice(0, phases.indexOf(phase) + 1) as Phase[];
    if (handles.length && phase !== "close") expected.push("close");
    expect(events).toEqual(expected);
    for (const handle of handles) expect(handle.close).toHaveBeenCalledOnce();
  });

  it("开始前取消时不调用文件系统", async () => {
    const realpath = vi.spyOn(io, "realpath");
    const controller = new AbortController();
    controller.abort();
    await expect(collectRepoSourceSnapshot([{ path: directory }], controller.signal)).rejects.toBe(controller.signal.reason);
    expect(realpath).not.toHaveBeenCalled();
  });

  it("空目录列表等待期间取消，也不能绕过循环检查返回成功", async () => {
    fs.unlinkSync(path.join(directory, "README.md"));
    const controller = new AbortController();
    const reason = new Error("SYNTHETIC_EMPTY_DIRECTORY_CANCEL");
    const readdir = io.readdir.bind(io);
    vi.spyOn(io, "readdir").mockImplementation(async (...args) => {
      const entries = await readdir(...args);
      controller.abort(reason);
      return entries;
    });
    await expect(collectRepoSourceSnapshot([{ path: directory }], controller.signal)).rejects.toBe(reason);
  });

  it("普通读盘失败仍向调用方传播并关闭已打开文件", async () => {
    const failure = new Error("SYNTHETIC_DISK_FAILURE");
    const open = io.open.bind(io);
    const handles: Awaited<ReturnType<typeof io.open>>[] = [];
    vi.spyOn(io, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      handles.push(handle);
      vi.spyOn(handle, "read").mockRejectedValue(failure);
      vi.spyOn(handle, "close");
      return handle;
    });
    await expect(collectRepoSourceSnapshot([{ path: directory }])).rejects.toBe(failure);
    expect(handles).toHaveLength(1);
    expect(handles[0]!.close).toHaveBeenCalledOnce();
  });
});
