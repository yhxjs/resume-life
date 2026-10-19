import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { StringDecoder } from "node:string_decoder";
import { logServerError } from "./server-errors";

export const UNPARSEABLE_MESSAGE = "文件内容无法解析，请确认文件格式正确";

/** 文件解析失败（格式不支持、内容损坏、超出资源上限或超时）时抛出的统一错误 */
export class FileFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileFormatError";
  }
}

export type ParseWorkerLimits = {
  timeoutMs: number;
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
};

/**
 * 在独立 Worker 内执行解析：主进程只等结果，超时、内存超限或 Worker 崩溃都会终止它并报格式错误。
 * mammoth 是 CPU 密集型解析，直接跑在主进程会阻塞整个事件循环，让应用整体失去响应。
 *
 * 这是本仓库唯一一处 `new Worker(..., { eval: true })` 的出口，只接受本模块调用方传入的常量源码。
 */
export function runInSandboxedWorker<Message, Result>(
  source: string,
  data: Record<string, unknown>,
  limits: ParseWorkerLimits,
  timeoutMessage: string,
  readMessage: (message: Message) => Result,
  options?: { signal?: AbortSignal }
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new FileFormatError("文件解析已取消"));
      return;
    }
    const worker = new Worker(source, {
      eval: true,
      workerData: data,
      resourceLimits: {
        maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb,
      },
    });
    let settled = false;
    const finish = (error?: Error, value?: Result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // 退出完成后再结算，调用方才能归还真实已释放的解析名额。
      void worker.terminate().then(() => {
        if (error) reject(error);
        else resolve(value as Result);
      }, () => reject(error ?? new FileFormatError(UNPARSEABLE_MESSAGE)));
    };
    const timer = setTimeout(() => finish(new FileFormatError(timeoutMessage)), limits.timeoutMs);
    const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new FileFormatError("文件解析已取消"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    worker.once("message", (message: Message) => {
      if (settled) return;
      try {
        finish(undefined, readMessage(message));
      } catch (error) {
        // readMessage 主动抛出的 FileFormatError（如文本超长）原样透出，其余统一为格式错误
        finish(error instanceof FileFormatError ? error : new FileFormatError(UNPARSEABLE_MESSAGE));
      }
    });
    worker.once("error", () => finish(new FileFormatError(UNPARSEABLE_MESSAGE)));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish(new FileFormatError(UNPARSEABLE_MESSAGE));
    });
  });
}

export type ParseProcessLimits = {
  timeoutMs: number;
  maxOldSpaceSizeMb: number;
};

/**
 * 在独立子进程内执行解析，结果以 UTF-8 JSON 经 stdout 回传。
 *
 * 为什么 PDF 不用上面的 Worker：pdf-parse 在 Node 下走 pdfjs 的 legacy 构建，
 * 而该构建加载进 worker_threads 会以约一半的概率让整个进程段错误（SIGSEGV，
 * 实测 pdfjs-dist 5.4.296 / Node 23.1 与 24.21 均可复现；pdfjs 的现代构建不会，
 * 但它在 Node 下不被支持）。子进程同样让主进程事件循环保持响应，还能用
 * --max-old-space-size 给堆内存封顶。
 *
 * 子进程脚本通过 `node -e` 内联传入，不需要额外的可追踪文件；模块路径经 argv 传入。
 */
export function runInSandboxedProcess<Result>(
  source: string,
  modulePath: string,
  data: Buffer,
  limits: ParseProcessLimits,
  timeoutMessage: string,
  readStdout: (stdout: string) => Result,
  options?: { signal?: AbortSignal; maxStdoutBytes?: number }
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new FileFormatError("文件解析已取消"));
      return;
    }
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${limits.maxOldSpaceSizeMb}`, "-e", source, modulePath],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdout = "";
    const stdoutDecoder = new StringDecoder("utf8");
    let stdoutBytes = 0;
    let stopError: Error | undefined;
    let settled = false;
    const finish = (error?: Error, value?: Result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as Result);
    };
    const timer = setTimeout(() => {
      stop(new FileFormatError(timeoutMessage));
    }, limits.timeoutMs);
    const stop = (error: Error) => {
      if (settled || stopError) return;
      stopError = error;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.kill();
    };
    const onAbort = () => stop(signal?.reason instanceof Error ? signal.reason : new FileFormatError("文件解析已取消"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    // 保持 stderr 排空，避免反压阻塞；解析器可能输出文件正文，不能缓存或记录它。
    child.stderr?.on("data", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || stopError) return;
      stdoutBytes += chunk.length;
      if (options?.maxStdoutBytes !== undefined && stdoutBytes > options.maxStdoutBytes) {
        stop(new FileFormatError("解析结果超出大小上限"));
        return;
      }
      stdout += stdoutDecoder.write(chunk);
    });
    child.once("error", () => finish(new FileFormatError(UNPARSEABLE_MESSAGE)));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (stopError) return finish(stopError);
      if (code !== 0) {
        logServerError("parse.process.exit", new FileFormatError(UNPARSEABLE_MESSAGE), {
          context: { exitCode: code, signal },
        });
        return finish(new FileFormatError(UNPARSEABLE_MESSAGE));
      }
      try {
        finish(undefined, readStdout(stdout + stdoutDecoder.end()));
      } catch (error) {
        finish(error instanceof FileFormatError ? error : new FileFormatError(UNPARSEABLE_MESSAGE));
      }
    });
    // 子进程提前退出时 stdin 会 EPIPE，这里只是避免未处理错误事件，不影响结果
    child.stdin.on("error", () => {});
    if (!stopError) child.stdin.end(data);
  });
}
