import { afterEach, describe, expect, it, vi } from "vitest";

import { logServerError, logServerEvent, type DiagnosticStage } from "../server-errors";
import { ModelProtocolError } from "../model-protocol";

afterEach(() => vi.restoreAllMocks());

describe("服务端错误日志", () => {
  it("只接受固定诊断阶段，运行时未知阶段不会写入日志", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    logServerError("health.check", new Error("PRIVATE_MARKER"), { stage: "storage-write" });
    logServerError("health.check", new Error("PRIVATE_MARKER"), { stage: "PRIVATE_MARKER" as DiagnosticStage });
    const lines = output.mock.calls.map((call) => String(call[0]));
    const payloads = lines.map((line) => JSON.parse(line.replace(/^\[server-error\]\s*/, "")));
    expect(payloads[0].stage).toBe("storage-write");
    expect(payloads[1]).not.toHaveProperty("stage");
    expect(lines.join("\n")).not.toContain("PRIVATE_MARKER");
  });

  it("只输出可信错误类别，任意 name/message/stack 仍不外发", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases = [new TypeError("PRIVATE_MARKER"), new SyntaxError("PRIVATE_MARKER"),
      new ModelProtocolError("PRIVATE_MARKER"), new Error("PRIVATE_MARKER")];
    for (const error of cases) {
      error.name = "PRIVATE_MARKER";
      error.stack = "PRIVATE_MARKER";
      logServerError("audit.test", error, { requestId: "audit-fixed" });
    }
    const lines = output.mock.calls.map((call) => String(call[0]));
    expect(lines.map((line) => JSON.parse(line.replace(/^\[server-error\]\s*/, "")).errorType))
      .toEqual(["TypeError", "SyntaxError", "ModelProtocolError", "Error"]);
    expect(lines.join("\n")).not.toContain("PRIVATE_MARKER");
  });

  it("保留有限网络 cause.code，不输出未知代码或循环 cause 内容", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const errors = [
      new TypeError("PRIVATE_MARKER", { cause: Object.assign(new Error("PRIVATE_MARKER"), { code: "ECONNREFUSED" }) }),
      new Error("PRIVATE_MARKER", { cause: Object.assign(new Error("PRIVATE_MARKER"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }),
      new Error("PRIVATE_MARKER", { cause: { code: "PRIVATE_MARKER" } }),
    ];
    const cycle = new Error("PRIVATE_MARKER");
    cycle.cause = cycle;
    errors.push(cycle);
    for (const error of errors) logServerError("network.test", error);
    const lines = output.mock.calls.map((call) => String(call[0]));
    expect(lines.map((line) => JSON.parse(line.replace(/^\[server-error\]\s*/, "")).errorCode))
      .toEqual(["ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "unknown", "unknown"]);
    expect(lines.join("\n")).not.toContain("PRIVATE_MARKER");
  });

  it("解析子进程的退出诊断只接受整数和系统信号，正文仍被丢弃", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    logServerError("parse.process.exit", new Error("SYNTHETIC_PRIVATE_MARKER"), {
      context: { exitCode: 7, signal: "SIGTERM", stderr: "SYNTHETIC_PRIVATE_MARKER" },
    });
    logServerError("parse.process.exit", new Error("SYNTHETIC_PRIVATE_MARKER"), {
      context: { exitCode: "SYNTHETIC_PRIVATE_MARKER", signal: "SIGPRIVATE", stderr: "SYNTHETIC_PRIVATE_MARKER" },
    });
    const lines = output.mock.calls.map((call) => String(call[0]));
    const payloads = lines.map((line) => JSON.parse(line.replace(/^\[server-error\]\s*/, "")));
    expect(payloads[0].context).toEqual({ exitCode: 7, signal: "SIGTERM" });
    expect(payloads[1]).not.toHaveProperty("context");
    expect(lines.join("\n")).not.toMatch(/SYNTHETIC_PRIVATE_MARKER|SIGPRIVATE|stderr/);
  });

  it("输出可关联的结构化字段且不记录错误正文、密钥或个人资料", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("sk-live-secret NAME_PRIVATE");
    error.name = "SecretErrorName-sk-name-secret";
    logServerError("backup.stats", error, {
      requestId: "req-fixed",
      status: 503,
      durationMs: 12,
      context: { table: "resumes", apiKey: "sk-context-secret", body: "PRIVATE_RESUME" },
    });

    expect(output).toHaveBeenCalledOnce();
    const line = String(output.mock.calls[0]![0]);
    const payload = JSON.parse(line.replace(/^\[server-error\]\s*/, ""));
    expect(payload).toMatchObject({
      operation: "backup.stats",
      requestId: "req-fixed",
      status: 503,
      durationMs: 12,
      errorType: "Error",
      context: { table: "resumes" },
    });
    expect(line).not.toMatch(/sk-live-secret|sk-name-secret|SecretErrorName|sk-context-secret|NAME_PRIVATE|PRIVATE_RESUME|apiKey|body/);
  });

  it("区分磁盘满、权限和 SQLite 约束，且不输出敏感异常正文", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases = [
      [Object.assign(new Error("C:/private/sk-secret"), { code: "ENOSPC" }), "ENOSPC"],
      [Object.assign(new Error("C:/private/sk-secret"), { code: "EACCES" }), "EACCES"],
      [Object.assign(new Error("UNIQUE constraint failed: secret_table.sk-secret"), { code: "ERR_SQLITE_ERROR" }), "SQLITE_CONSTRAINT"],
      [Object.assign(new Error("sk-secret"), { code: "sk-secret" }), "unknown"],
    ] as const;
    for (const [error] of cases) logServerError("storage.write", error);
    const lines = output.mock.calls.map((call) => String(call[0]));
    expect(lines.map((line) => JSON.parse(line.replace(/^\[server-error\]\s*/, "")).errorCode))
      .toEqual(cases.map((entry) => entry[1]));
    expect(lines.join("\n")).not.toMatch(/sk-secret|private|secret_table|constraint failed/);
  });
});

describe("服务端事件日志", () => {
  it("info 走 console.info、warn 走 console.warn，并带上 durationMs", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    logServerEvent("info", "startup", { context: { node: "v24.21.0", platform: "win32" } });
    logServerEvent("warn", "search.slow", {
      requestId: "req-slow",
      durationMs: 1743.6,
      context: { queryLength: 4, thresholdMs: 500, resultCount: 24 },
    });

    expect(info).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warn.mock.calls[0]![0]).replace(/^\[server-warn\]\s*/, ""))).toEqual({
      level: "warn",
      operation: "search.slow",
      requestId: "req-slow",
      durationMs: 1744,
      context: { queryLength: 4, thresholdMs: 500, resultCount: 24 },
    });
  });

  it("沿用字段白名单：白名单外的键与敏感值一律丢弃", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    logServerEvent("info", "db.open", {
      context: {
        journalMode: "wal",
        dbVersion: 2,
        dataDirConfigured: true,
        // 以下都不在白名单内，必须被丢弃
        apiKey: "sk-should-not-appear",
        resumeContent: "PRIVATE_RESUME_TEXT",
        baseUrl: "http://internal.example",
        dbPath: "C:/Users/someone/data/resume-life.db",
      },
    });

    const line = String(info.mock.calls[0]![0]);
    expect(JSON.parse(line.replace(/^\[server-info\]\s*/, ""))).toEqual({
      level: "info",
      operation: "db.open",
      context: { journalMode: "wal", dbVersion: 2, dataDirConfigured: true },
    });
    expect(line).not.toMatch(/sk-should-not-appear|PRIVATE_RESUME_TEXT|internal\.example|someone/);
  });

  it("未提供 requestId 时不写入该字段（成功路径不应伪造关联 ID）", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    logServerEvent("info", "startup", { context: { node: "v24.21.0" } });

    const payload = JSON.parse(String(info.mock.calls[0]![0]).replace(/^\[server-info\]\s*/, ""));
    expect(payload).not.toHaveProperty("requestId");
    expect(payload).not.toHaveProperty("durationMs");
  });

  it("OCR 页数只接受有界整数", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logServerEvent("warn", "ocr.vision_fallback_to_local", { context: { pageCount: 3, errorCode: "protocol" } });
    logServerEvent("warn", "ocr.vision_fallback_to_local", { context: { pageCount: 999, errorCode: "unknown" } });
    const valid = JSON.parse(String(warn.mock.calls[0]![0]).replace(/^\[server-warn\]\s*/, ""));
    const invalid = JSON.parse(String(warn.mock.calls[1]![0]).replace(/^\[server-warn\]\s*/, ""));
    expect(valid.context).toEqual({ pageCount: 3, errorCode: "protocol" });
    expect(invalid.context).toEqual({ errorCode: "unknown" });
  });
});
