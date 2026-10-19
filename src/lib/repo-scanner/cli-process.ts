import { StringDecoder } from "node:string_decoder";
import { logServerError } from "../server-errors";

const { spawn } = process.getBuiltinModule("child_process");
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
let activeProcesses = 0;

/** 两条 CLI 路径共用输出、并发、截止时间和进程组生命周期。 */
export async function runCliPrompt(options: {
  command: string;
  args: readonly string[];
  cwd: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (text: string, stderr: boolean) => void;
}): Promise<string> {
  options.signal?.throwIfAborted();
  if (activeProcesses >= 2) throw new Error("本机 CLI 任务过多，请等待当前扫描完成");
  activeProcesses++;
  try {
    return await execute(options);
  } finally {
    activeProcesses--;
  }
}

function execute(options: Parameters<typeof runCliPrompt>[0]): Promise<string> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const env = { ...process.env, FORCE_COLOR: "0", PYTHONIOENCODING: "utf-8" };
    let child: ReturnType<typeof spawn>;
    try {
      if (isWin && /\.(?:cmd|bat)$/i.test(options.command)) {
        // 路径始终引用；百分号与引号无法可靠表达，提前拒绝。cwd 不进入命令行。
        if (/[%"\r\n\0]/.test(options.command) || options.args.some((arg) => /[%"\r\n\0]/.test(arg))) {
          throw new Error("CLI 批处理命令包含不能安全引用的字符");
        }
        const inner = [options.command, ...options.args].map((arg) => `"${arg}"`).join(" ");
        child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/v:off", "/s", "/c", `"${inner}"`], {
          cwd: options.cwd, env, windowsVerbatimArguments: true, windowsHide: true, shell: false,
        });
      } else {
        child = spawn(options.command, [...options.args], {
          cwd: options.cwd, env, windowsHide: true, shell: false, detached: !isWin,
        });
      }
    } catch (error) {
      reject(error);
      return;
    }
    const decoder = new StringDecoder("utf8");
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finished = false;
    let stopping: Error | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let killTask: ReturnType<typeof spawn> | undefined;
    let childExited = false;
    let killTaskFinished = true;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve(stdout + decoder.end());
    };
    const finishStopped = () => {
      if (!stopping || !childExited || !killTaskFinished || finished) return;
      if (!isWin && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* 进程组已全部结束 */ }
      }
      // 派生进程可能仍持有管道；取消时不再等待 stdout 的 close。
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(stopping);
    };
    const terminationFailed = (failure: unknown, context?: Record<string, unknown>) => {
      if (finished) return;
      killTaskFinished = true;
      logServerError("cli.terminate", failure, { context });
      stopping = new Error("CLI 进程树终止失败，请检查本机残留进程");
      try { child.kill("SIGKILL"); } catch (error) { logServerError("cli.forceTerminate", error); }
      finishStopped();
    };
    const terminate = (error: Error) => {
      if (finished || stopping) return;
      stopping = error;
      clearTimeout(timer);
      try {
        if (isWin && child.pid) {
          killTaskFinished = false;
          killTask = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
          killTask.once("error", terminationFailed);
          killTask.once("close", (code, signal) => {
            if (code !== 0) return terminationFailed(new Error(`taskkill 退出失败（${code ?? "signal"}）`), {
              exitCode: code, signal, resource: childExited ? "parent-exited" : "parent-running",
            });
            killTaskFinished = true;
            finishStopped();
          });
        } else if (child.pid) {
          process.kill(-child.pid, "SIGTERM");
        }
      } catch (failure) {
        if (!(failure && typeof failure === "object" && "code" in failure && failure.code === "ESRCH")) terminationFailed(failure);
      }
      // Windows 的 taskkill /T /F 已有超时；独立杀父进程会让树终止误报 PID 不存在。
      if (!isWin) forceTimer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch (failure) {
          if (!(failure && typeof failure === "object" && "code" in failure && failure.code === "ESRCH")) logServerError("cli.forceTerminate", failure);
        }
      }, 1000);
    };
    const onAbort = () => terminate(new Error("CLI 任务已被取消"));
    const timer = setTimeout(() => terminate(new Error("CLI 任务超时")), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (finished || stopping) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) return terminate(new Error("CLI 输出超过大小上限"));
      const text = decoder.write(chunk);
      stdout += text;
      try { options.onOutput?.(text, false); } catch (error) { terminate(error instanceof Error ? error : new Error("进度处理失败")); }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (finished || stopping) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) return terminate(new Error("CLI 错误输出超过大小上限"));
      try { options.onOutput?.(chunk.toString("utf8"), true); } catch (error) { terminate(error instanceof Error ? error : new Error("进度处理失败")); }
    });
    child.once("error", () => finish(new Error("无法启动本机 CLI")));
    child.once("exit", () => { childExited = true; finishStopped(); });
    child.once("close", (code) => {
      if (stopping) {
        childExited = true;
        finishStopped();
        return;
      }
      finish(code === 0 ? undefined : new Error(`CLI 退出失败（${code ?? "signal"}）`));
    });
    child.stdin?.on("error", () => {});
    if (options.signal?.aborted) onAbort();
    if (!stopping) child.stdin?.end(options.prompt, "utf8");
  });
}

/** 只分析 stdin 材料；不给模型文件、命令、网络或外部插件工具。 */
export function textOnlyCliArgs(cli: "claude" | "codex"): string[] {
  return cli === "claude"
    ? ["-p", "--output-format", "text", "--tools", "", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"]
    : ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "hooks",
      "--disable", "apps", "--disable", "plugins",
      "-c", "web_search='disabled'", "-c", "default_permissions='resume_life_scan'",
      "-c", "permissions.resume_life_scan.filesystem={':minimal'='read',':workspace_roots'='read'}"];
}
