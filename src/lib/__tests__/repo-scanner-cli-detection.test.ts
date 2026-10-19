import { afterEach, describe, expect, it, vi } from "vitest";
import { promisify } from "node:util";
import type { CliType, DetectedClis } from "@/lib/repo-scanner/cli-runner";

const childProcess = process.getBuiltinModule("child_process");
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const notInstalled = new Error("CLI not found");

async function loadDetector(
  platform: NodeJS.Platform,
  outputs: Record<CliType, string | Error>,
) {
  vi.resetModules();
  const execFileSpy = vi.spyOn(childProcess, "execFile").mockImplementation((
    (file: string, args: readonly string[], callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      const output = outputs[args[0] as CliType];
      queueMicrotask(() => {
        callback(output instanceof Error ? output : null, typeof output === "string" ? output : "", "");
      });
      return new childProcess.ChildProcess();
    }
  ) as typeof childProcess.execFile);
  // Vitest spy 不保留 execFile 的 custom promisify，须还原 stdout/stderr 多返回值约定。
  Object.defineProperty(execFileSpy, promisify.custom, {
    value: (file: string, args: string[]) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      childProcess.execFile(file, args, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    }),
  });
  Object.defineProperty(process, "platform", { value: platform });
  const { detectInstalledClis } = await import("@/lib/repo-scanner/cli-runner");
  return { detectInstalledClis, execFileSpy };
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
  vi.resetModules();
});

describe("repo-scanner: CLI 检测外部进程边界", () => {
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
    expect(execFileSpy).toHaveBeenNthCalledWith(1, "where.exe", ["codex"], expect.any(Function));
    expect(execFileSpy).toHaveBeenNthCalledWith(2, "where.exe", ["claude"], expect.any(Function));
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
    expect(execFileSpy).toHaveBeenNthCalledWith(1, "which", ["codex"], expect.any(Function));
    expect(execFileSpy).toHaveBeenNthCalledWith(2, "which", ["claude"], expect.any(Function));
  });
});
