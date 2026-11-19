import { afterEach, describe, expect, it, vi } from "vitest";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliType, DetectedClis } from "@/lib/repo-scanner/cli-runner";

const childProcess = process.getBuiltinModule("child_process");
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const notInstalled = new Error("CLI not found");

async function loadDetector(
  platform: NodeJS.Platform,
  outputs: Record<CliType, string | Error | Promise<string>>,
) {
  vi.resetModules();
  // CLI 检测不依赖运行测试的机器是否真的装有 Claude Code。
  const statSpy = vi.spyOn(fs, "stat").mockRejectedValue(notInstalled);
  const execFileSpy = vi.spyOn(childProcess, "execFile").mockImplementation((
    (file: string, args: readonly string[], options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      const output = outputs[args[0] as CliType];
      void Promise.resolve(output).then(output => {
        callback(output instanceof Error ? output : null, typeof output === "string" ? output : "", "");
      }, error => callback(error, "", ""));
      return new childProcess.ChildProcess();
    }
  ) as typeof childProcess.execFile);
  // Vitest spy 不保留 execFile 的 custom promisify，须还原 stdout/stderr 多返回值约定。
  Object.defineProperty(execFileSpy, promisify.custom, {
    value: (file: string, args: string[], options: object) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      childProcess.execFile(file, args, options, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    }),
  });
  Object.defineProperty(process, "platform", { value: platform });
  const { detectInstalledClis } = await import("@/lib/repo-scanner/cli-runner");
  return { detectInstalledClis, execFileSpy, statSpy };
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
  vi.resetModules();
});

describe("repo-scanner: CLI 检测外部进程边界", () => {
  it.each([notInstalled, "\r\n"])("Windows PATH 漏检时找到原生安装并推荐 Claude（%s）", async output => {
    const { detectInstalledClis, statSpy } = await loadDetector("win32", { codex: "C:\\cli\\codex.cmd", claude: output });
    statSpy.mockResolvedValue({ isFile: () => true } as Stats);
    const nativePath = path.join(os.homedir(), ".local", "bin", "claude.exe");

    expect(await detectInstalledClis()).toEqual({
      codex: { available: true, path: "C:\\cli\\codex.cmd" },
      claude: { available: true, path: nativePath },
      recommended: "claude",
    });
    expect(statSpy).toHaveBeenCalledExactlyOnceWith(nativePath);
  });

  it("Windows 保留 PATH 中自定义安装的优先级", async () => {
    const { detectInstalledClis, statSpy } = await loadDetector("win32", { codex: notInstalled, claude: "D:\\custom\\claude.exe" });
    statSpy.mockResolvedValue({ isFile: () => true } as Stats);

    expect((await detectInstalledClis()).claude.path).toBe("D:\\custom\\claude.exe");
    expect(statSpy).not.toHaveBeenCalled();
  });

  it("默认安装路径是目录时不能标记为可用", async () => {
    const { detectInstalledClis, statSpy } = await loadDetector("win32", { codex: notInstalled, claude: notInstalled });
    statSpy.mockResolvedValue({ isFile: () => false } as Stats);

    expect((await detectInstalledClis()).claude).toEqual({ available: false });
  });

  it.each(["resolve", "reject"])("默认安装位置探测中取消，迟到 %s 仍传播取消", async outcome => {
    const { detectInstalledClis, statSpy } = await loadDetector("win32", { codex: notInstalled, claude: notInstalled });
    const pending = Promise.withResolvers<Stats>();
    const started = Promise.withResolvers<void>();
    statSpy.mockImplementation(() => { started.resolve(); return pending.promise; });
    const controller = new AbortController();
    const result = detectInstalledClis(controller.signal);
    const rejected = expect(result).rejects.toThrow("SYNTHETIC_PRIVATE_ABORT");
    await started.promise;
    controller.abort(new Error("SYNTHETIC_PRIVATE_ABORT"));
    if (outcome === "resolve") pending.resolve({ isFile: () => true } as Stats);
    else pending.reject(notInstalled);
    await rejected;
  });

  it.each(["linux", "darwin"] as const)("%s 不检查 Windows 默认安装位置", async platform => {
    const { detectInstalledClis, statSpy } = await loadDetector(platform, { codex: notInstalled, claude: notInstalled });

    expect((await detectInstalledClis()).claude).toEqual({ available: false });
    expect(statSpy).not.toHaveBeenCalled();
  });

  it("已取消的探测不启动任何查找子进程", async () => {
    const { detectInstalledClis, execFileSpy } = await loadDetector("win32", { codex: notInstalled, claude: notInstalled });
    const controller = new AbortController();
    controller.abort(new Error("SYNTHETIC_PRIVATE_ABORT"));
    await expect(detectInstalledClis(controller.signal)).rejects.toThrow("SYNTHETIC_PRIVATE_ABORT");
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("探测等待中取消，迟到 %s 不降级成未安装，也不启动第二项", async outcome => {
    const pending = Promise.withResolvers<string>();
    const { detectInstalledClis, execFileSpy } = await loadDetector("win32", { codex: pending.promise, claude: notInstalled });
    const controller = new AbortController();
    const result = detectInstalledClis(controller.signal);
    const rejected = expect(result).rejects.toThrow("SYNTHETIC_PRIVATE_ABORT");
    controller.abort(new Error("SYNTHETIC_PRIVATE_ABORT"));
    if (outcome === "resolve") pending.resolve("C:\\synthetic\\codex.cmd");
    else pending.reject(new Error("late process rejection"));
    await rejected;
    expect(execFileSpy).toHaveBeenCalledWith("where.exe", ["codex"], expect.objectContaining({
      signal: controller.signal, windowsHide: true, timeout: 5000, maxBuffer: 16_384,
    }), expect.any(Function));
    expect(execFileSpy).toHaveBeenCalledTimes(1);
  });

  it.each<{
    name: string;
    outputs: Record<CliType, string | Error>;
    expected: DetectedClis;
  }>([
    {
      name: "两者均未安装",
      outputs: { codex: notInstalled, claude: notInstalled },
      expected: { codex: { available: false }, claude: { available: false }, recommended: null },
    },
    {
      name: "仅安装 Codex",
      outputs: { codex: "C:\\cli\\codex.cmd\r\n", claude: notInstalled },
      expected: { codex: { available: true, path: "C:\\cli\\codex.cmd" }, claude: { available: false }, recommended: "codex" },
    },
    {
      name: "仅安装 Claude",
      outputs: { codex: notInstalled, claude: "C:\\cli\\claude.exe\r\n" },
      expected: { codex: { available: false }, claude: { available: true, path: "C:\\cli\\claude.exe" }, recommended: "claude" },
    },
    {
      name: "两者均安装时推荐 Claude",
      outputs: { codex: "C:\\cli\\codex.cmd\r\n", claude: "C:\\cli\\claude.exe\r\n" },
      expected: { codex: { available: true, path: "C:\\cli\\codex.cmd" }, claude: { available: true, path: "C:\\cli\\claude.exe" }, recommended: "claude" },
    },
  ])("Windows $name", async ({ outputs, expected }) => {
    const { detectInstalledClis, execFileSpy } = await loadDetector("win32", outputs);

    expect(await detectInstalledClis()).toEqual(expected);
    expect(execFileSpy).toHaveBeenCalledTimes(2);
    expect(execFileSpy).toHaveBeenNthCalledWith(1, "where.exe", ["codex"], expect.objectContaining({ timeout: 5000, maxBuffer: 16_384 }), expect.any(Function));
    expect(execFileSpy).toHaveBeenNthCalledWith(2, "where.exe", ["claude"], expect.objectContaining({ timeout: 5000, maxBuffer: 16_384 }), expect.any(Function));
  });

  it("Windows 优先 Codex .cmd 与 Claude .exe，并忽略空行和路径周围空白", async () => {
    const { detectInstalledClis } = await loadDetector("win32", {
      codex: "\r\n  C:\\cli\\codex.exe  \r\n C:\\cli\\codex.cmd \r\n",
      claude: "  C:\\cli\\claude.cmd \r\n\r\n C:\\cli\\claude.exe  \r\n",
    });

    expect(await detectInstalledClis()).toEqual({
      codex: { available: true, path: "C:\\cli\\codex.cmd" },
      claude: { available: true, path: "C:\\cli\\claude.exe" },
      recommended: "claude",
    });
  });

  it("Windows 未找到优先扩展名时保留首个路径", async () => {
    const { detectInstalledClis } = await loadDetector("win32", {
      codex: "C:\\first\\codex.exe\r\nC:\\second\\codex.exe\r\n",
      claude: "C:\\first\\claude.cmd\r\nC:\\second\\claude.cmd\r\n",
    });

    expect(await detectInstalledClis()).toEqual({
      codex: { available: true, path: "C:\\first\\codex.exe" },
      claude: { available: true, path: "C:\\first\\claude.cmd" },
      recommended: "claude",
    });
  });

  it("查找成功但输出只有空白时仍视为未安装", async () => {
    const { detectInstalledClis } = await loadDetector("win32", { codex: " \r\n\t\r\n", claude: "\n" });

    expect(await detectInstalledClis()).toEqual({
      codex: { available: false },
      claude: { available: false },
      recommended: null,
    });
  });

  it.each(["linux", "darwin"] as const)("%s 使用 which 并保留首个非空路径", async (platform) => {
    const { detectInstalledClis, execFileSpy } = await loadDetector(platform, {
      codex: " \n /usr/local/bin/codex \n/usr/bin/codex\n",
      claude: " /usr/local/bin/claude\n/usr/bin/claude\n",
    });

    expect(await detectInstalledClis()).toEqual({
      codex: { available: true, path: "/usr/local/bin/codex" },
      claude: { available: true, path: "/usr/local/bin/claude" },
      recommended: "claude",
    });
    expect(execFileSpy).toHaveBeenCalledTimes(2);
    expect(execFileSpy).toHaveBeenNthCalledWith(1, "which", ["codex"], expect.objectContaining({ timeout: 5000, maxBuffer: 16_384 }), expect.any(Function));
    expect(execFileSpy).toHaveBeenNthCalledWith(2, "which", ["claude"], expect.objectContaining({ timeout: 5000, maxBuffer: 16_384 }), expect.any(Function));
  });
});
