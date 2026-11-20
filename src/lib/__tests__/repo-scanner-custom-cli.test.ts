import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseCliSelection, parseCustomCliArgs, parseCustomCliConfig } from "../repo-scanner/cli-config";

const childProcess = process.getBuiltinModule("child_process");
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function mockExecutableLookup(platform: "win32" | "linux", paths: string[]) {
  // process.platform 不会切换 node:path 的宿主机实现，路径语义与文件检查须一起隔离。
  const isAbsolute = (platform === "win32" ? path.win32 : path.posix).isAbsolute;
  vi.spyOn(path, "isAbsolute").mockImplementation(isAbsolute);
  const normalize = (value: string) => platform === "win32" ? path.win32.normalize(value).toLowerCase() : value;
  vi.spyOn(fs, "stat").mockImplementation(async file => {
    if (!paths.some(candidate => normalize(candidate) === normalize(String(file)))) throw new Error("Synthetic file not found");
    return { isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>;
  });
  vi.spyOn(fs, "access").mockResolvedValue(undefined);
  Object.defineProperty(process, "platform", { value: platform });
  if (platform === "win32") {
    vi.spyOn(process, "cwd").mockReturnValue("C:\\synthetic-server");
    vi.stubEnv("PATH", [...new Set(paths.map(value => path.win32.dirname(value)))].join(";"));
    vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD");
  }
  const exec = vi.spyOn(childProcess, "execFile");
  const lookup = vi.fn().mockResolvedValue({ stdout: paths.join("\n") + "\n", stderr: "" });
  Object.defineProperty(exec, promisify.custom, { value: lookup });
  return lookup;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", originalPlatform);
  vi.resetModules();
});

describe("自定义客户端配置与程序查找", () => {
  it("命令名称、空格路径与静态参数保持独立，空参数和字面量不被 shell 拆分", () => {
    const args = ["C:/SDK client/bridge.mjs", "", "a & b", 'a"b', "$(literal)"];
    expect(parseCliSelection("custom", { command: " node ", args })).toEqual({ preferredCli: "custom", customCli: { command: "node", args } });
    expect(parseCustomCliConfig({ command: "C:\\Program Files\\SDK\\client.exe" })).toEqual({ command: "C:\\Program Files\\SDK\\client.exe", args: [] });
    expect(parseCustomCliArgs("  ")).toEqual([]);
    expect(() => parseCustomCliArgs("--text")).toThrow("JSON");
  });

  it.each(["client --text", '"C:\\SDK client\\client.exe"', "./client", "../client", "client;whoami", "-flag", "node\n", "client\0"])("拒绝命令行、相对路径或控制字符：%s", command => {
    expect(() => parseCustomCliConfig({ command })).toThrow();
  });

  it.each([null, "--text", [42], ["a\nb"], ["a\0b"], Array(65).fill("--text"), ["a".repeat(4097)], Array(5).fill("a".repeat(4096))])("拒绝无效或超预算的参数 %j", args => {
    expect(() => parseCustomCliConfig({ command: "client", args })).toThrow();
  });

  it.each(["%PATH%", 'a" & echo injected', "bad\r\nflag"])("批处理拒绝不能安全引用的参数 %s", arg => {
    expect(() => parseCustomCliConfig({ command: "D:/custom/client.CMD", args: [arg] })).toThrow();
  });

  it("批处理路径也拒绝环境变量展开，命令行保留 Windows 长度上限", () => {
    expect(() => parseCustomCliConfig({ command: "D:/%CLIENT%/client.cmd" })).toThrow("安全引用");
    expect(() => parseCustomCliConfig({ command: "D:/client.bat", args: ["a".repeat(4000), "b".repeat(4000)] })).toThrow("过长");
  });

  it.each(["cmd", "BAT"])(".%s 拒绝末尾反斜杠，避免转发时合并或改写参数", extension => {
    for (const directory of ["C:\\SDK config\\", "C:\\SDK config\\\\", "C:\\"]) {
      expect(() => parseCustomCliConfig({ command: `D:/client.${extension}`, args: ["--config-dir", directory, "--text"] })).toThrow("反斜杠");
    }
    const args = ["--config-dir", "C:/SDK config/", "--text"];
    expect(parseCustomCliConfig({ command: `D:/client.${extension}`, args }).args).toEqual(args);
  });

  it("原生程序仍可使用末尾反斜杠参数", () => {
    const args = ["--config-dir", "C:\\SDK config\\", "--text", "C:\\SDK config\\\\"];
    expect(parseCustomCliConfig({ command: "D:/client.exe", args }).args).toEqual(args);
  });

  it("原生程序绝对路径无需探测 PATH，配置错误不启动子进程", async () => {
    const exec = vi.spyOn(childProcess, "execFile");
    const { resolveCustomCli } = await import("../repo-scanner/custom-cli");
    expect(await resolveCustomCli({ command: process.execPath, args: ["--text"] })).toEqual({ command: process.execPath, args: ["--text"] });
    await expect(resolveCustomCli({ command: "node --text" })).rejects.toThrow("参数");
    await expect(resolveCustomCli({ command: process.cwd() })).rejects.toThrow("未找到");
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux"] as const)("%s 从 PATH 解析自定义程序并保留固定参数", async platform => {
    const executable = platform === "win32" ? "C:\\synthetic\\synthetic-sdk-client.exe" : "/synthetic/synthetic-sdk-client";
    const lookup = mockExecutableLookup(platform, [executable]);
    const { resolveCustomCli } = await import("../repo-scanner/custom-cli");
    expect(await resolveCustomCli({ command: "synthetic-sdk-client", args: ["--text"] })).toEqual({ command: executable, args: ["--text"] });
    if (platform === "win32") expect(lookup).not.toHaveBeenCalled();
    else expect(lookup).toHaveBeenCalledWith("which", ["synthetic-sdk-client"], expect.objectContaining({ windowsHide: true, timeout: 5000 }));
    expect(fs.stat).toHaveBeenCalledWith(executable);
    expect(fs.access).toHaveBeenCalledWith(executable, fs.constants.X_OK);
  });

  it.each(["CMD", "bat", "com", "exe"])("Windows 保留 PATH 中首个 .%s 程序的优先级", async extension => {
    const executable = `C:\\first\\synthetic.${extension}`;
    mockExecutableLookup("win32", ["C:\\first\\synthetic", executable, "D:\\later\\synthetic.exe", "D:\\later\\synthetic.com"]);
    const { resolveCustomCli } = await import("../repo-scanner/custom-cli");
    const result = await resolveCustomCli({ command: "synthetic", args: ["--text"] });
    expect(result.command.toLowerCase()).toBe(executable.toLowerCase());
    expect(result.args).toEqual(["--text"]);
    expect(fs.stat).not.toHaveBeenCalledWith("D:\\later\\synthetic.exe");
  });

  it("PATH 查找失败保留可读错误，取消不会伪装成未安装", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const exec = vi.spyOn(childProcess, "execFile");
    const lookup = vi.fn().mockRejectedValue(new Error("PRIVATE_PATH_LOOKUP_FAILURE"));
    Object.defineProperty(exec, promisify.custom, { value: lookup });
    const { resolveCustomCli } = await import("../repo-scanner/custom-cli");
    await expect(resolveCustomCli({ command: "synthetic" })).rejects.toThrow("未找到可运行");
    const controller = new AbortController();
    lookup.mockImplementationOnce(async () => { controller.abort(new Error("synthetic canceled")); throw new Error("late lookup"); });
    await expect(resolveCustomCli({ command: "synthetic" }, controller.signal)).rejects.toThrow("synthetic canceled");
    lookup.mockClear();
    await expect(resolveCustomCli({ command: "synthetic" }, controller.signal)).rejects.toThrow("synthetic canceled");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    { arg: "%PATH%", error: "安全引用" },
    { arg: "C:\\SDK config\\", error: "反斜杠" },
    { arg: "C:\\SDK config\\\\", error: "反斜杠" },
  ])("解析到 .cmd 后同样拒绝不能透传的参数 $arg", async ({ arg, error }) => {
    mockExecutableLookup("win32", ["C:\\synthetic\\synthetic.cmd", "D:\\later\\synthetic.exe"]);
    const { resolveCustomCli } = await import("../repo-scanner/custom-cli");
    await expect(resolveCustomCli({ command: "synthetic", args: [arg, "--text"] })).rejects.toThrow(error);
  });

  it("Windows 查找保留中文路径、带引号的 PATH 和 PATHEXT 顺序", async () => {
    const command = "C:\\中文 工具\\synthetic.cmd";
    const lookup = mockExecutableLookup("win32", [command, "C:\\中文 工具\\synthetic.exe"]);
    vi.stubEnv("PATH", '"C:\\中文 工具"');
    vi.stubEnv("PATHEXT", ".CMD;.EXE");
    const { resolveCustomCli } = await import("../repo-scanner/custom-cli");
    expect(await resolveCustomCli({ command: "synthetic", args: [] })).toEqual({ command, args: [] });
    expect(await resolveCustomCli({ command: "synthetic.cmd", args: [] })).toEqual({ command, args: [] });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("Windows 忽略同名目录，找不到普通文件时返回配置错误", async () => {
    mockExecutableLookup("win32", ["C:\\first\\synthetic.exe"]);
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => false } as Awaited<ReturnType<typeof fs.stat>>);
    const { resolveCustomCli } = await import("../repo-scanner/custom-cli");
    await expect(resolveCustomCli({ command: "synthetic", args: [] })).rejects.toThrow("未找到可运行");
  });

  it.each(["cancel", "timeout"])("Windows PATH 读取遇到 %s 时立即结束，迟到结果不继续查找", async action => {
    mockExecutableLookup("win32", ["C:\\first\\synthetic.exe"]);
    const { resolveCustomCli } = await import("../repo-scanner/custom-cli");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof fs.stat>>>();
    vi.mocked(fs.stat).mockImplementationOnce(() => pending.promise);
    const controller = new AbortController();
    const result = resolveCustomCli({ command: "synthetic", args: [] }, controller.signal);
    const rejected = expect(result).rejects.toThrow(action === "cancel" ? "Synthetic canceled" : "未找到可运行");
    if (action === "cancel") controller.abort(new Error("Synthetic canceled"));
    else await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    pending.resolve({ isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>);
    await vi.advanceTimersByTimeAsync(0);
    expect(fs.stat).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each((["win32", "linux"] as const).flatMap(platform =>
    (["absolute-stat", "resolved-stat", "access"] as const).flatMap(stage =>
      (["cancel", "timeout"] as const).map(action => ({ platform, stage, action }))
    )
  ))("$platform 的 $stage 遇到 $action 时立即结束，迟到读取不继续执行", async ({ platform, stage, action }) => {
    const executable = platform === "win32" ? "C:\\synthetic\\client.exe" : "/synthetic/client";
    mockExecutableLookup(platform, [executable]);
    const { resolveCustomCli } = await import("../repo-scanner/custom-cli");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    if (stage === "access") {
      vi.mocked(fs.access).mockImplementationOnce(() => { entered.resolve(); return pending.promise; });
    } else {
      const stat = vi.mocked(fs.stat).getMockImplementation()!;
      let matchingReads = 0;
      vi.mocked(fs.stat).mockImplementation(async file => {
        if (String(file) === executable && ++matchingReads === (stage === "resolved-stat" && platform === "win32" ? 2 : 1)) {
          entered.resolve();
          await pending.promise;
        }
        return stat(file);
      });
    }
    const controller = new AbortController();
    const canceled = new Error("Synthetic canceled");
    let settled = false;
    let failure: unknown;
    const completed = resolveCustomCli({ command: stage === "resolved-stat" ? "client" : executable, args: [] }, controller.signal)
      .then(() => { settled = true; }, error => { settled = true; failure = error; });
    try {
      await entered.promise;
      if (action === "cancel") controller.abort(canceled);
      else await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      if (action === "cancel") expect(failure).toBe(canceled);
      else expect(failure).toMatchObject({ message: expect.stringContaining("未找到可运行") });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pending.resolve();
      await completed;
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(fs.access).toHaveBeenCalledTimes(stage === "access" ? 1 : 0);
  });

  it("PATH 查找与最终权限检查共享五秒截止时间", async () => {
    const executable = "C:\\synthetic\\client.exe";
    mockExecutableLookup("win32", [executable]);
    const { resolveCustomCli } = await import("../repo-scanner/custom-cli");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const lookup = Promise.withResolvers<Awaited<ReturnType<typeof fs.stat>>>();
    const stat = vi.mocked(fs.stat).getMockImplementation()!;
    let lookupStarted = false;
    vi.mocked(fs.stat).mockImplementation(file => {
      if (String(file) === executable && !lookupStarted) {
        lookupStarted = true;
        return lookup.promise;
      }
      return stat(file);
    });
    const enteredAccess = Promise.withResolvers<void>();
    const access = Promise.withResolvers<void>();
    vi.mocked(fs.access).mockImplementationOnce(() => { enteredAccess.resolve(); return access.promise; });
    let settled = false;
    let failure: unknown;
    const completed = resolveCustomCli({ command: "client", args: [] })
      .then(() => { settled = true; }, error => { settled = true; failure = error; });
    try {
      await vi.advanceTimersByTimeAsync(4500);
      lookup.resolve({ isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>);
      await enteredAccess.promise;
      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(failure).toMatchObject({ message: expect.stringContaining("未找到可运行") });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      access.resolve();
      await completed;
    }
  });

  it.each(["cancel", "timeout"])("POSIX 查找进程遇到 %s 时收到取消，迟到输出不能触发文件检查", async action => {
    const lookup = mockExecutableLookup("linux", ["/synthetic/client"]);
    const pending = Promise.withResolvers<{ stdout: string; stderr: string }>();
    lookup.mockImplementationOnce(() => pending.promise);
    const { resolveCustomCli } = await import("../repo-scanner/custom-cli");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    let settled = false;
    let failure: unknown;
    const completed = resolveCustomCli({ command: "client", args: [] }, controller.signal)
      .then(() => { settled = true; }, error => { settled = true; failure = error; });
    try {
      if (action === "cancel") controller.abort(new Error("Synthetic canceled"));
      else await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(failure).toMatchObject({ message: expect.stringContaining(action === "cancel" ? "Synthetic canceled" : "未找到可运行") });
      expect(lookup.mock.calls[0]?.[2].signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pending.resolve({ stdout: "/synthetic/client\n", stderr: "" });
      await completed;
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(fs.stat).not.toHaveBeenCalled();
    expect(fs.access).not.toHaveBeenCalled();
  });
});
