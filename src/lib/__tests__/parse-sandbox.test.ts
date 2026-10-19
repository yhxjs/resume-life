import { describe, expect, it, vi } from "vitest";
import {
  FileFormatError,
  runInSandboxedProcess,
  runInSandboxedWorker,
  UNPARSEABLE_MESSAGE,
} from "../parse-sandbox";

const LIMITS = { timeoutMs: 5_000, maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 };
const PROCESS_LIMITS = { timeoutMs: 20_000, maxOldSpaceSizeMb: 256 };

describe("runInSandboxedWorker", () => {
  it("返回 Worker 回传的结果", async () => {
    const source = `
      const { parentPort } = require("node:worker_threads");
      parentPort.postMessage({ value: "ok" });
    `;

    await expect(
      runInSandboxedWorker<{ value?: unknown }, string>(source, {}, LIMITS, "解析超时", (message) => String(message.value))
    ).resolves.toBe("ok");
  });

  it("Worker 一直不返回时按超时终止，而不是无限等待", async () => {
    const source = `setInterval(() => {}, 1000);`;
    const startedAt = Date.now();

    await expect(
      runInSandboxedWorker(source, {}, { ...LIMITS, timeoutMs: 200 }, "解析超时", (message) => message)
    ).rejects.toThrow("解析超时");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("Worker 内抛错时映射为格式错误", async () => {
    const source = `throw new Error("boom");`;

    await expect(runInSandboxedWorker(source, {}, LIMITS, "解析超时", (message) => message)).rejects.toThrow(
      UNPARSEABLE_MESSAGE
    );
  });

  it("readMessage 抛出的格式错误原样透出", async () => {
    const source = `
      const { parentPort } = require("node:worker_threads");
      parentPort.postMessage({ invalid: true });
    `;

    await expect(
      runInSandboxedWorker<{ invalid?: unknown }, string>(source, {}, LIMITS, "解析超时", (message) => {
        if (message.invalid) throw new FileFormatError("内容无效");
        return "";
      })
    ).rejects.toThrow("内容无效");
  });

  it("超过内存上限的 Worker 被终止并报格式错误", async () => {
    const source = `
      const { parentPort } = require("node:worker_threads");
      const chunks = [];
      for (let index = 0; index < 40; index += 1) chunks.push(new Array(2_000_000).fill(index));
      parentPort.postMessage({ value: String(chunks.length) });
    `;

    await expect(
      runInSandboxedWorker<{ value?: unknown }, string>(
        source,
        {},
        { ...LIMITS, maxOldGenerationSizeMb: 32 },
        "解析超时",
        (message) => String(message.value)
      )
    ).rejects.toBeInstanceOf(FileFormatError);
  });
});

describe("runInSandboxedProcess", () => {
  it("跨 stdout Buffer 的 UTF-8 字符保持原样", async () => {
    const source = `
      const output = Buffer.from(JSON.stringify({ value: "\\u{1f600}" }));
      const split = output.indexOf(0xf0) + 1;
      process.stdout.write(output.subarray(0, split));
      setTimeout(() => process.stdout.write(output.subarray(split)), 30);
    `;
    await expect(runInSandboxedProcess(source, "unused", Buffer.alloc(0), PROCESS_LIMITS, "解析超时", (stdout) => {
      return (JSON.parse(stdout) as { value: string }).value;
    }, { maxStdoutBytes: Buffer.byteLength(JSON.stringify({ value: "\u{1f600}" })) })).resolves.toBe("\u{1f600}");
  });

  it("分块 UTF-8 stdout 的原始字节预算仍拒绝超出一字节的结果", async () => {
    const source = `
      const output = Buffer.from(JSON.stringify({ value: "\\u{1f600}" }));
      const split = output.indexOf(0xf0) + 1;
      process.stdout.write(output.subarray(0, split));
      setTimeout(() => process.stdout.write(output.subarray(split)), 30);
    `;
    const outputBytes = Buffer.byteLength(JSON.stringify({ value: "\u{1f600}" }));
    await expect(runInSandboxedProcess(source, "unused", Buffer.alloc(0), PROCESS_LIMITS, "解析超时", (stdout) => stdout, {
      maxStdoutBytes: outputBytes - 1,
    })).rejects.toThrow("解析结果超出大小上限");
  });

  it("返回子进程 stdout 解析出的结果", async () => {
    const source = `process.stdout.write(JSON.stringify({ value: "ok" }));`;

    await expect(
      runInSandboxedProcess(source, "unused", Buffer.alloc(0), PROCESS_LIMITS, "解析超时", (stdout) => {
        return (JSON.parse(stdout) as { value: string }).value;
      })
    ).resolves.toBe("ok");
  });

  it("子进程一直不退出时按超时终止，而不是无限等待", async () => {
    const source = `setInterval(() => {}, 1000);`;
    const startedAt = Date.now();

    await expect(
      runInSandboxedProcess(source, "unused", Buffer.alloc(0), { ...PROCESS_LIMITS, timeoutMs: 500 }, "解析超时", (stdout) => stdout)
    ).rejects.toThrow("解析超时");
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  });

  it("子进程非零退出时映射为格式错误", async () => {
    const source = `process.exit(3);`;

    await expect(
      runInSandboxedProcess(source, "unused", Buffer.alloc(0), PROCESS_LIMITS, "解析超时", (stdout) => stdout)
    ).rejects.toThrow(UNPARSEABLE_MESSAGE);
  });

  it("真实子进程的 stderr 私密文本不进入日志和错误，保留安全退出诊断", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await runInSandboxedProcess(
        'process.stderr.write("SYNTHETIC_PRIVATE_MARKER"); process.exit(7);',
        "unused",
        Buffer.alloc(0),
        PROCESS_LIMITS,
        "解析超时",
        (stdout) => stdout,
      ).then(() => null, (error: unknown) => error);
      expect(error).toBeInstanceOf(FileFormatError);
      expect((error as Error).message).toBe(UNPARSEABLE_MESSAGE);
      expect(output).toHaveBeenCalledOnce();
      const line = output.mock.calls.flat().join(" ");
      expect(line).not.toContain("SYNTHETIC_PRIVATE_MARKER");
      const payload = JSON.parse(line.replace(/^\[server-error\]\s*/, ""));
      expect(payload).toMatchObject({
        operation: "parse.process.exit",
        requestId: expect.any(String),
        context: { exitCode: 7, signal: null },
      });
    } finally {
      output.mockRestore();
    }
  });

  it("stdout 不是合法 JSON 时映射为格式错误", async () => {
    const source = `process.stdout.write("这不是 JSON");`;

    await expect(
      runInSandboxedProcess(source, "unused", Buffer.alloc(0), PROCESS_LIMITS, "解析超时", (stdout) => {
        return (JSON.parse(stdout) as { value: string }).value;
      })
    ).rejects.toThrow(UNPARSEABLE_MESSAGE);
  });

  it("把数据经 stdin 原样交给子进程", async () => {
    const source = `
      const chunks = [];
      process.stdin.on("data", (chunk) => chunks.push(chunk));
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ value: Buffer.concat(chunks).toString("utf8") }));
      });
    `;

    await expect(
      runInSandboxedProcess(source, "unused", Buffer.from("payload", "utf8"), PROCESS_LIMITS, "解析超时", (stdout) => {
        return (JSON.parse(stdout) as { value: string }).value;
      })
    ).resolves.toBe("payload");
  });

  it("取消信号会终止仍在运行的解析子进程", async () => {
    const controller = new AbortController();
    const aborted = new Error("用户取消解析");
    setTimeout(() => controller.abort(aborted), 25);

    await expect(runInSandboxedProcess(
      "setInterval(() => {}, 1000);",
      "unused",
      Buffer.alloc(0),
      { ...PROCESS_LIMITS, timeoutMs: 300 },
      "解析超时",
      (stdout) => stdout,
      { signal: controller.signal }
    )).rejects.toThrow("用户取消解析");
  });

  it("子进程输出超过预算时终止并拒绝", async () => {
    await expect(runInSandboxedProcess(
      'process.stdout.write("x".repeat(1024));',
      "unused",
      Buffer.alloc(0),
      PROCESS_LIMITS,
      "解析超时",
      (stdout) => stdout,
      { maxStdoutBytes: 128 }
    )).rejects.toThrow("解析结果超出大小上限");
  });
});
