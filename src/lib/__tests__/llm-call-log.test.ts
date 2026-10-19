import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as DatabaseSync | undefined }));
const warnings = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock("../db", () => ({
  inTransaction: <T>(fn: () => T) => fn(),
  getDb: () => {
    if (!holder.db) throw new Error("测试未初始化数据库");
    return holder.db;
  },
}));

vi.mock("../server-errors", () => ({
  logServerEvent: (_level: string, operation: string) => { warnings.events.push(operation); },
}));

import { recordLlmCall } from "../llm-call-log";

const DDL = `
  CREATE TABLE llm_call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL, feature TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT '', entity_id INTEGER,
    entity_label TEXT NOT NULL DEFAULT '', task TEXT NOT NULL,
    model TEXT NOT NULL, api_format TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok','failed','cancelled')),
    error_code TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER
  );
  CREATE TABLE resumes (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
`;

const base = {
  task: "summary" as const,
  model: "deepseek-chat",
  apiFormat: "openai_chat" as const,
  errorCode: "",
  attempts: 0,
  durationMs: 3120,
};

function rows() {
  return holder.db!.prepare("SELECT * FROM llm_call_logs ORDER BY id").all() as Record<string, unknown>[];
}

beforeEach(() => {
  holder.db = new DatabaseSync(":memory:");
  holder.db.exec(DDL);
  holder.db.exec("INSERT INTO resumes (id, title) VALUES (12, '前端开发工程师')");
  warnings.events.length = 0;
});

describe("recordLlmCall", () => {
  it("写入成功调用，并把三个 token 字段原样落库", () => {
    recordLlmCall({
      ...base,
      source: { feature: "简历润色", entity: { type: "resume", id: 12 } },
      status: "ok",
      usage: { inputTokens: 1240, outputTokens: 380, cachedTokens: null },
    });

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      feature: "简历润色",
      entity_type: "resume",
      entity_id: 12,
      entity_label: "前端开发工程师",
      status: "ok",
      input_tokens: 1240,
      output_tokens: 380,
      cached_tokens: null,
    });
  });

  it("未上报的 token 保持 NULL，与 0 严格区分", () => {
    recordLlmCall({
      ...base,
      source: { feature: "简历润色" },
      status: "ok",
      usage: { inputTokens: 100, outputTokens: null, cachedTokens: 0 },
    });

    const row = rows()[0];
    expect(row!.input_tokens).toBe(100);
    expect(row!.output_tokens).toBeNull();
    expect(row!.cached_tokens).toBe(0);
    expect(row!.cached_tokens).not.toBeNull();
  });

  it("无实体时 entity_id 为 NULL 且标签为空串", () => {
    recordLlmCall({
      ...base,
      source: { feature: "黑话解码" },
      status: "ok",
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: null },
    });

    expect(rows()[0]).toMatchObject({ entity_type: "", entity_id: null, entity_label: "" });
  });

  it("失败与取消调用也落库，带 error_code 与重试次数", () => {
    recordLlmCall({
      ...base,
      source: { feature: "模拟面试出题" },
      status: "failed",
      errorCode: "http_429",
      attempts: 2,
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null },
    });
    recordLlmCall({
      ...base,
      source: { feature: "模拟面试出题" },
      status: "cancelled",
      errorCode: "cancelled",
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null },
    });

    expect(rows().map((r) => [r.status, r.error_code, r.attempts])).toEqual([
      ["failed", "http_429", 2],
      ["cancelled", "cancelled", 0],
    ]);
  });

  it("数据库不可用时吞掉异常并记一条告警，绝不向上抛", () => {
    holder.db = undefined;
    expect(() =>
      recordLlmCall({
        ...base,
        source: { feature: "简历润色" },
        status: "ok",
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: null },
      })
    ).not.toThrow();
    expect(warnings.events).toEqual(["llm.metering.failed"]);
  });
});

describe("llm_call_logs 保留策略", () => {
  function insertAt(createdAt: string, feature: string) {
    holder.db!
      .prepare(
        `INSERT INTO llm_call_logs (created_at, feature, task, model, api_format, status)
         VALUES (?, ?, 'summary', 'm', 'openai_chat', 'ok')`
      )
      .run(createdAt, feature);
  }

  it("写入时清理超过保留窗口的记录，窗口内的记录保持不变", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      insertAt("2029-01-01T00:00:00.000Z", "过期记录");
      insertAt("2029-12-31T00:00:00.000Z", "窗口内记录");

      recordLlmCall({
        ...base,
        source: { feature: "简历润色" },
        status: "ok",
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: null },
      });

      const features = rows().map((row) => row.feature);
      expect(features).toContain("简历润色");
      expect(features).toContain("窗口内记录");
      expect(features).not.toContain("过期记录");
      expect(warnings.events).toContain("llm.metering.pruned");
    } finally {
      vi.useRealTimers();
    }
  });

  it("同一天内只在首次写入时清理一次", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-06-01T00:00:00.000Z"));
      insertAt("2029-01-01T00:00:00.000Z", "过期记录");
      recordLlmCall({ ...base, source: { feature: "简历润色" }, status: "ok", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: null } });
      const pruneEvents = warnings.events.filter((event) => event === "llm.metering.pruned").length;

      insertAt("2029-01-02T00:00:00.000Z", "又一条过期记录");
      recordLlmCall({ ...base, source: { feature: "黑话解码" }, status: "ok", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: null } });

      expect(warnings.events.filter((event) => event === "llm.metering.pruned").length).toBe(pruneEvents);
      expect(rows().map((row) => row.feature)).toContain("又一条过期记录");
    } finally {
      vi.useRealTimers();
    }
  });

  it("清理失败只记告警，本次计量照常落库", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));
      insertAt("2029-01-01T00:00:00.000Z", "过期记录");
      holder.db!.exec(
        "CREATE TRIGGER block_delete BEFORE DELETE ON llm_call_logs BEGIN SELECT RAISE(ABORT, 'no delete'); END;"
      );

      recordLlmCall({
        ...base,
        source: { feature: "简历润色" },
        status: "ok",
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: null },
      });

      expect(rows().map((row) => row.feature)).toEqual(["过期记录", "简历润色"]);
      expect(warnings.events).toEqual(["llm.metering.pruneFailed"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
