import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const childProcess = process.getBuiltinModule("child_process");
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let fixture: string;
let spawned: Promise<void>;

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 901234, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(), exitCode: null as number | null,
  });
  return child;
}

const SUMMARY = JSON.stringify({ overview: "项目概况", architecture: "项目架构", highlights: "项目亮点", responsibilities: "项目职责", challenges: "项目成果", techStack: "TypeScript", brief: "项目简述", achievements: ["成果一", "成果二", "成果三"] });

beforeEach(() => {
  vi.resetModules();
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-cli-test-"));
  fs.writeFileSync(path.join(fixture, "README.md"), "Synthetic source fixture.");
});
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  Object.defineProperty(process, "platform", originalPlatform);
  if (path.dirname(fixture) !== os.tmpdir() || !path.basename(fixture).startsWith("resume-life-cli-test-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(fixture, { recursive: true, force: true });
});

async function loadRunner(platform: NodeJS.Platform = "win32") {
  Object.defineProperty(process, "platform", { value: platform });
  const children: ReturnType<typeof fakeChild>[] = [];
  let resolveSpawn!: () => void;
  spawned = new Promise<void>((resolve) => { resolveSpawn = resolve; });
  const spawn = vi.spyOn(childProcess, "spawn").mockImplementation((() => {
    const child = fakeChild(); children.push(child);
    resolveSpawn();
    return child;
  }) as unknown as typeof childProcess.spawn);
  const exec = vi.spyOn(childProcess, "execFile");
  Object.defineProperty(exec, promisify.custom, { value: async (_file: string, args: string[]) => {
    if (args[0] === "claude") throw new Error("not installed");
    return { stdout: platform === "win32" ? "C:\\cli\\codex.cmd\r\n" : "/opt/codex\n", stderr: "" };
  } });
  const runner = await import("../repo-scanner/cli-runner");
  return { runner, spawn, children };
}

async function startScan(runner: typeof import("../repo-scanner/cli-runner"), repoPath = fixture, signal?: AbortSignal) {
  const promise = runner.runRepoScan({ repoPath, projectName: "测试项目", preferredCli: "codex", signal });
  void promise.catch(() => {});
  await Promise.race([spawned, promise.then(() => {}, () => {})]);
  return { promise };
}

describe("扫描子进程边界", () => {
  it("动态仓库路径不会进入 cmd.exe 命令行", async () => {
    const { runner, spawn, children } = await loadRunner();
    const { promise } = await startScan(runner);
    children[0]!.stdout.write(SUMMARY); children[0]!.emit("close", 0);
    await promise;
    expect(JSON.stringify(spawn.mock.calls[0]?.[1])).not.toContain(fixture.replaceAll("\\", "\\\\"));
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true });
  });

  it("POSIX 子进程使用独立进程组，取消后移除监听和计时器", async () => {
    const { runner, spawn, children } = await loadRunner("linux");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const controller = new AbortController();
    const { promise } = await startScan(runner, fixture, controller.signal);
    controller.abort();
    children[0]!.emit("close", null);
    await expect(promise).rejects.toThrow(/取消/);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true });
    expect(kill).toHaveBeenCalledWith(-children[0]!.pid, "SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("相同仓库重复扫描在创建新进程前被拒绝", async () => {
    const { runner, children } = await loadRunner();
    const { promise } = await startScan(runner);
    const second = runner.runRepoScan({ repoPath: fixture, projectName: "重复", preferredCli: "codex" });
    const rejection = expect(second).rejects.toThrow(/进行|繁忙/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const child of children) { child.stdout.write(SUMMARY); child.emit("close", 0); }
    await rejection; await promise;
    expect(children).toHaveLength(1);
  });

  it("输出超出预算时终止任务，后续数据不能继续累积", async () => {
    const { runner, children } = await loadRunner("linux");
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const { promise } = await startScan(runner);
    children[0]!.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1, 97));
    children[0]!.emit("close", null);
    await expect(promise).rejects.toThrow(/输出.*上限/);
  });

  it("进度日志以固定窗口保留", async () => {
    const { runner, children } = await loadRunner();
    const { promise } = await startScan(runner);
    for (let i = 0; i < 300; i++) children[0]!.stderr.write(`progress-${i}\n`);
    children[0]!.stdout.write(SUMMARY); children[0]!.emit("close", 0);
    const result = await promise;
    expect(result.logs.length).toBeLessThanOrEqual(200);
    expect(result.logs.join("\n")).toContain("progress-299");
  });

  it("Windows taskkill 失败会明确报错，不因派生进程管道拖住取消", async () => {
    const { runner, children } = await loadRunner();
    const controller = new AbortController();
    const { promise } = await startScan(runner, fixture, controller.signal);
    const rejected = expect(promise).rejects.toThrow(/终止失败/);
    controller.abort();
    children[1]!.emit("close", 1);
    children[0]!.emit("exit", null);
    await rejected;
  });

  it("Windows 树终止失败只记录退出元数据并保留失败反馈", async () => {
    const { runner, children } = await loadRunner();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const { promise } = await startScan(runner, fixture, controller.signal);
    const rejected = expect(promise).rejects.toThrow(/终止失败/);
    controller.abort();
    children[0]!.emit("exit", null);
    children[1]!.emit("close", 128, null);
    await rejected;
    const diagnostic = logged.mock.calls.find(([line]) => String(line).startsWith("[server-error] "));
    expect(diagnostic).toBeDefined();
    expect(JSON.parse(String(diagnostic?.[0]).slice("[server-error] ".length))).toMatchObject({
      operation: "cli.terminate", context: { exitCode: 128, signal: null, resource: "parent-exited" },
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(fixture.replaceAll("\\", "\\\\"));
  });

  it("Windows 等待延迟的 taskkill，不能先独立杀父进程使树终止报错", async () => {
    const { runner, children } = await loadRunner();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const { promise } = await startScan(runner, fixture, controller.signal);
    const outcome = promise.then(() => "completed", (error: Error) => error.message);
    let parentKilled = false;
    children[0]!.kill.mockImplementation(() => {
      parentKilled = true;
      children[0]!.emit("exit", null);
      return true;
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(1500);
    // taskkill 成功/找不到 PID 的结果由父进程是否被提前独立终止决定。
    children[1]!.emit("close", parentKilled ? 128 : 0);
    if (!parentKilled) children[0]!.emit("exit", null);
    expect(await outcome).toMatch(/取消/);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Windows 先收到父进程 exit 时仍等待 taskkill，释放名额后可继续扫描", async () => {
    const { runner, spawn, children } = await loadRunner();
    const controller = new AbortController();
    const { promise } = await startScan(runner, fixture, controller.signal);
    const rejected = expect(promise).rejects.toThrow(/取消/);
    controller.abort();
    children[0]!.emit("exit", null);
    children[1]!.emit("close", 0);
    await rejected;
    expect(children[0]!.stdout.destroyed).toBe(true);
    const child = fakeChild();
    let nextStarted!: () => void;
    const started = new Promise<void>((resolve) => { nextStarted = resolve; });
    spawn.mockImplementationOnce((() => { nextStarted(); return child; }) as unknown as typeof childProcess.spawn);
    const next = runner.runRepoScan({ repoPath: fixture, projectName: "再次扫描", preferredCli: "codex" });
    await started;
    child.stdout.write(SUMMARY); child.emit("close", 0);
    await next;
  });

  it("POSIX 超时强制清理同组派生进程并移除计时器", async () => {
    const { runner, children } = await loadRunner("linux");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { promise } = await startScan(runner);
    const rejected = expect(promise).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(kill).toHaveBeenCalledWith(-children[0]!.pid, "SIGTERM");
    children[0]!.emit("exit", null);
    await rejected;
    expect(kill).toHaveBeenCalledWith(-children[0]!.pid, "SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("CLI 无法使用文件/命令工具，也不加载原仓库配置", async () => {
    const { textOnlyCliArgs } = await import("../repo-scanner/cli-process");
    const claude = textOnlyCliArgs("claude");
    expect(claude.slice(claude.indexOf("--tools"), claude.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(claude).toContain("--safe-mode");
    expect(claude).toContain("--strict-mcp-config");
    const codex = textOnlyCliArgs("codex");
    expect(codex).toContain("--ignore-user-config");
    expect(codex).toContain("apps");
    expect(codex).toContain("plugins");
    expect(codex).not.toContain("mcp_servers={}");
    expect(codex).toContain("shell_tool");
    expect(codex).toContain("unified_exec");
    expect(codex).toContain("hooks");
    expect(codex).toContain("permissions.resume_life_scan.filesystem={':minimal'='read',':workspace_roots'='read'}");
  });
});
