import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: calls.exec }));
import { getAvailableDrives } from "../repo-scanner/dir-browser";

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  calls.exec.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("Windows 逻辑盘符枚举", () => {
  it("不探测网络盘根目录，固定命令异步枚举并规范化盘符", async () => {
    const exists = vi.spyOn(fs, "existsSync").mockImplementation(() => { throw new Error("不能探测根目录"); });
    calls.exec.mockImplementation((_file, _args, _options, callback) => callback(null, "D:\\\r\nc:\\\r\nD:\\\r\n无效输出\r\n"));
    expect(await getAvailableDrives()).toEqual(["C:\\", "D:\\"]);
    expect(exists).not.toHaveBeenCalled();
    expect(calls.exec).toHaveBeenCalledWith("powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[System.IO.Directory]::GetLogicalDrives()"],
      { windowsHide: true, timeout: 5_000, maxBuffer: 4_096, encoding: "utf8" }, expect.any(Function));
  });

  it("枚举等待时不阻塞调用栈，回包后才提供盘符", async () => {
    let finish!: (error: Error | null, stdout: string) => void;
    calls.exec.mockImplementation((_file, _args, _options, callback) => { finish = callback; });
    let finished = false;
    const pending = getAvailableDrives().then(drives => { finished = true; return drives; });
    await Promise.resolve();
    expect(finished).toBe(false);
    finish(null, "E:\\\r\n");
    expect(await pending).toEqual(["E:\\"]);
  });

  it.each([new Error("进程超时或不可用"), null])("枚举失败或空输出时降级为主目录盘符：%s", async error => {
    calls.exec.mockImplementation((_file, _args, _options, callback) => callback(error, ""));
    expect(await getAvailableDrives()).toEqual([path.parse(os.homedir()).root]);
  });

  it("非 Windows 环境只提供根目录且不启动子进程", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(await getAvailableDrives()).toEqual(["/"]);
    expect(calls.exec).not.toHaveBeenCalled();
  });

  it("取消信号传给枚举子进程，取消不伪装成成功降级", async () => {
    const controller = new AbortController();
    let finish!: (error: Error | null, stdout: string) => void;
    calls.exec.mockImplementation((_file, _args, _options, callback) => { finish = callback; });
    const pending = getAvailableDrives(controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ status: 499, message: "请求已取消" });
    expect(calls.exec.mock.calls[0]![2].signal).toBe(controller.signal);
    controller.abort();
    finish(new Error("进程已取消"), "");
    await rejected;
  });
});
