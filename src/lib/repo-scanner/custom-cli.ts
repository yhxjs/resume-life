import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CliConfigError, parseCustomCliConfig, validateWindowsBatchCommand, type CustomCliConfig } from "./cli-config";

const { execFile } = process.getBuiltinModule("child_process");
const execFileAsync = promisify(execFile);
const EXECUTABLE_LOOKUP_TIMEOUT_MS = 5000;

/** 直接读取 Unicode 路径，避免 where.exe 的系统代码页输出被当作 UTF-8。 */
async function findWindowsExecutable(command: string, signal: AbortSignal): Promise<string> {
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    .map(extension => extension.trim().toLowerCase())
    .filter(extension => /^\.(?:exe|com|cmd|bat)$/i.test(extension));
  const names = [command, ...extensions.map(extension => command + extension)]
    .filter(name => /\.(?:exe|com|cmd|bat)$/i.test(name));
  const directories = [process.cwd(), ...(process.env.PATH ?? "").split(";").filter(Boolean)];
  const seen = new Set<string>();
  for (const entry of directories) {
    const directory = path.win32.resolve(entry.replace(/^"(.*)"$/, "$1"));
    for (const name of names) {
      signal.throwIfAborted();
      const candidate = path.win32.join(directory, name);
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const stat = await fs.stat(/* turbopackIgnore: true */ candidate);
        signal.throwIfAborted();
        if (stat.isFile()) return candidate;
      } catch { signal.throwIfAborted(); }
    }
  }
  return "";
}

async function findExecutable(command: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!path.isAbsolute(command)) {
    // 非当前系统的绝对路径不能当成 PATH 命令或相对路径查找。
    if (/[\\/]/.test(command)) throw new Error("Invalid executable path");
    if (process.platform === "win32") command = await findWindowsExecutable(command, signal);
    else {
      const { stdout } = await execFileAsync("which", [command], {
        timeout: EXECUTABLE_LOOKUP_TIMEOUT_MS, maxBuffer: 16_384, windowsHide: true, signal,
      });
      signal.throwIfAborted();
      command = stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) || "";
    }
  }
  signal.throwIfAborted();
  if (!path.isAbsolute(command)) throw new Error("Executable not found");
  // 宿主机客户端只在运行时查找，不应让构建追踪把整个项目当作可执行程序资产。
  const stat = await fs.stat(/* turbopackIgnore: true */ command);
  signal.throwIfAborted();
  if (!stat.isFile()) throw new Error("Executable not found");
  await fs.access(/* turbopackIgnore: true */ command, fs.constants.X_OK);
  signal.throwIfAborted();
  return command;
}

/** 只查找用户明确配置的程序；不会尝试启动客户端或退回其他模型。 */
export async function resolveCustomCli(value: unknown, signal?: AbortSignal): Promise<CustomCliConfig> {
  signal?.throwIfAborted();
  const config = parseCustomCliConfig(value);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new Error("Executable lookup timed out")), EXECUTABLE_LOOKUP_TIMEOUT_MS);
  let rejectAborted!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAborted, { once: true });
    if (controller.signal.aborted) rejectAborted();
  });
  let command: string;
  try {
    // stat/access 本身无法取消；所有查找与最终检查共享截止时间。
    // 取消后立即归还扫描名额，迟到的读取通过同一 signal 停止后续 I/O。
    command = await Promise.race([findExecutable(config.command, controller.signal), aborted]);
    controller.signal.throwIfAborted();
  } catch {
    signal?.throwIfAborted();
    throw new CliConfigError("未找到可运行的自定义 CLI，请检查命令名称、绝对路径及执行权限");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    controller.signal.removeEventListener("abort", rejectAborted);
  }
  signal?.throwIfAborted();
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) validateWindowsBatchCommand(command, config.args);
  return { command, args: config.args };
}
