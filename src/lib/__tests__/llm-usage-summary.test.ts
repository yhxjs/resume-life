import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as DatabaseSync | undefined }));

vi.mock("../db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("测试未初始化数据库");
    return holder.db;
  },
}));
vi.mock("../server-errors", () => ({ logServerEvent: () => {} }));

import {
  InvalidUsageRangeError,
  listLlmCalls,
  parseFeature,
  parseIsoRange,
  summarizeLlmUsage,
} from "../llm-call-log";

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
`;

function insert(row: {
  createdAt: string; feature?: string; status?: string;
  input?: number | null; output?: number | null; cached?: number | null;
  attempts?: number;
}) {
  holder.db!
    .prepare(
      `INSERT INTO llm_call_logs
         (created_at, feature, entity_type, entity_id, entity_label, task, model, api_format,
          status, error_code, attempts, duration_ms, input_tokens, output_tokens, cached_tokens)
       VALUES (?, ?, '', NULL, '', 'summary', 'm', 'openai_chat', ?, '', ?, 0, ?, ?, ?)`
    )
    .run(
      row.createdAt,
      row.feature ?? "简历润色",
      row.status ?? "ok",
      row.attempts ?? 0,
      row.input ?? null,
      row.output ?? null,
      row.cached ?? null
    );
}

beforeEach(() => {
  holder.db = new DatabaseSync(":memory:");
  holder.db.exec(DDL);
});

describe("summarizeLlmUsage", () => {
  it("上海自然日范围内的调用在同一日期显示，右端点排除", () => {
    insert({ createdAt: "2026-10-17T16:00:00.000Z", input: 10 });
    insert({ createdAt: "2026-10-18T02:00:00.000Z", input: 100, output: 20 });
    insert({ createdAt: "2026-10-18T16:00:00.000Z", input: 999 });
    const result = summarizeLlmUsage({ from: "2026-10-17T16:00:00.000Z", to: "2026-10-18T16:00:00.000Z", timeZone: "Asia/Shanghai" });
    expect(result.calls).toBe(2);
    expect(result.daily).toEqual([{ date: "2026-10-18", calls: 2, failed: 0, inputTokens: 110, outputTokens: 20, cachedTokens: 0 }]);
  });

  it("上海七天范围补齐本地日期，聚合与总计一致", () => {
    insert({ createdAt: "2026-10-11T16:00:00.000Z", input: 10 });
    insert({ createdAt: "2026-10-18T15:59:59.999Z", input: 20 });
    const result = summarizeLlmUsage({ from: "2026-10-11T16:00:00.000Z", to: "2026-10-18T16:00:00.000Z", timeZone: "Asia/Shanghai" });
    expect(result.daily.map((row) => row.date)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(result.daily.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(result.inputTokens);
  });

  it.each([
    ["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", "2026-03-09T03:59:59.999Z", "2026-03-08"],
    ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", "2026-11-02T04:59:59.999Z", "2026-11-01"],
  ])("纽约 DST 自然日 %s 不按固定 24 小时分桶", (from, to, last, date) => {
    insert({ createdAt: from, input: 10 });
    insert({ createdAt: last, input: 20 });
    const result = summarizeLlmUsage({ from, to, timeZone: "America/New_York" });
    expect(result.daily).toEqual([{ date, calls: 2, failed: 0, inputTokens: 30, outputTokens: 0, cachedTokens: 0 }]);
  });

  it("UTC 非午夜的右端点仍包含当日已发生的调用", () => {
    insert({ createdAt: "2026-10-18T02:00:00.000Z" });
    const result = summarizeLlmUsage({ from: "2026-10-18T01:00:00.000Z", to: "2026-10-18T03:00:00.000Z" });
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0]).toMatchObject({ date: "2026-10-18", calls: 1 });
  });

  it("超过一年时不会丢弃末日的真实数据", () => {
    insert({ createdAt: "2026-10-18T02:00:00.000Z", input: 42 });
    const result = summarizeLlmUsage({ from: "2025-01-01T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z" });
    expect(result.daily.at(-1)).toMatchObject({ date: "2026-10-18", inputTokens: 42 });
    expect(result.daily.reduce((sum, row) => sum + row.calls, 0)).toBe(result.calls);
  });

  it("calls 只统计 ok，failed 与 cancelled 分别统计", () => {
    insert({ createdAt: "2026-09-10T00:00:00.000Z" });
    insert({ createdAt: "2026-09-11T00:00:00.000Z" });
    insert({ createdAt: "2026-09-12T00:00:00.000Z", status: "failed" });
    insert({ createdAt: "2026-09-13T00:00:00.000Z", status: "cancelled" });

    expect(summarizeLlmUsage({ from: null, to: null })).toMatchObject({
      calls: 2, failed: 1, cancelled: 1,
    });
  });

  it("token 只累加非 NULL 行，并分别统计上报次数", () => {
    insert({ createdAt: "2026-09-10T00:00:00.000Z", input: 1000, output: 200, cached: 400 });
    insert({ createdAt: "2026-09-11T00:00:00.000Z", input: 500, output: 100, cached: 0 });
    insert({ createdAt: "2026-09-12T00:00:00.000Z", input: null, output: null, cached: null });

    expect(summarizeLlmUsage({ from: null, to: null })).toMatchObject({
      calls: 3, failed: 0, cancelled: 0, retries: 0,
      inputTokens: 1500, outputTokens: 300, cachedTokens: 400,
      usageReportedCalls: 2, cacheReportedCalls: 2,
    });
  });

  it("retries 为 attempts 列求和，成功与失败调用的重试都计入", () => {
    insert({ createdAt: "2026-09-10T00:00:00.000Z", attempts: 1 });
    insert({ createdAt: "2026-09-11T00:00:00.000Z", attempts: 2 });
    insert({ createdAt: "2026-09-12T00:00:00.000Z", status: "failed", attempts: 2 });

    expect(summarizeLlmUsage({ from: null, to: null })).toMatchObject({ retries: 5 });
  });

  it("全部未上报时累加值为 0、上报次数为 0（前端据此显示 —）", () => {
    insert({ createdAt: "2026-09-10T00:00:00.000Z" });

    expect(summarizeLlmUsage({ from: null, to: null })).toMatchObject({
      inputTokens: 0, outputTokens: 0, cachedTokens: 0,
      usageReportedCalls: 0, cacheReportedCalls: 0,
    });
  });

  it("区间为左闭右开 [from, to)", () => {
    insert({ createdAt: "2026-09-01T00:00:00.000Z" });
    insert({ createdAt: "2026-09-15T00:00:00.000Z" });
    insert({ createdAt: "2026-10-01T00:00:00.000Z" });

    expect(summarizeLlmUsage({ from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" }).calls).toBe(2);
  });

  it("feature 过滤生效，只汇总指定来源", () => {
    insert({ createdAt: "2026-09-10T00:00:00.000Z", feature: "简历润色", input: 100, output: 20 });
    insert({ createdAt: "2026-09-11T00:00:00.000Z", feature: "黑话解码", input: 200, output: 40 });

    const polishSummary = summarizeLlmUsage({ from: null, to: null, feature: "简历润色" });
    expect(polishSummary.calls).toBe(1);
    expect(polishSummary.inputTokens).toBe(100);
    expect(polishSummary.outputTokens).toBe(20);

    const jargonSummary = summarizeLlmUsage({ from: null, to: null, feature: "黑话解码" });
    expect(jargonSummary.calls).toBe(1);
    expect(jargonSummary.inputTokens).toBe(200);
    expect(jargonSummary.outputTokens).toBe(40);
  });
});

describe("listLlmCalls", () => {
  it("按 id 倒序返回，游标翻页不漏不重", () => {
    for (let i = 0; i < 5; i += 1) insert({ createdAt: `2026-09-0${i + 1}T00:00:00.000Z` });

    const first = listLlmCalls({ from: null, to: null, feature: null, limit: 2, cursor: null });
    expect(first.items.map((row) => row.id)).toEqual([5, 4]);
    expect(first.nextCursor).toBe("4");

    const second = listLlmCalls({ from: null, to: null, feature: null, limit: 2, cursor: 4 });
    expect(second.items.map((row) => row.id)).toEqual([3, 2]);

    const third = listLlmCalls({ from: null, to: null, feature: null, limit: 2, cursor: 2 });
    expect(third.items.map((row) => row.id)).toEqual([1]);
    expect(third.nextCursor).toBeNull();
  });

  it("feature 过滤生效", () => {
    insert({ createdAt: "2026-09-01T00:00:00.000Z", feature: "简历润色" });
    insert({ createdAt: "2026-09-02T00:00:00.000Z", feature: "黑话解码" });

    const page = listLlmCalls({ from: null, to: null, feature: "黑话解码", limit: 50, cursor: null });
    expect(page.items.map((row) => row.feature)).toEqual(["黑话解码"]);
  });

  it("把下划线的列名映射为 camelCase", () => {
    insert({ createdAt: "2026-09-01T00:00:00.000Z", input: 10, output: 2, cached: null });
    expect(listLlmCalls({ from: null, to: null, feature: null, limit: 1, cursor: null }).items[0]).toMatchObject({
      createdAt: "2026-09-01T00:00:00.000Z",
      entityType: "", entityId: null, entityLabel: "",
      inputTokens: 10, outputTokens: 2, cachedTokens: null,
    });
  });
});

describe("parseIsoRange", () => {
  it("缺省与空串都视为不限", () => {
    expect(parseIsoRange(new URLSearchParams())).toEqual({ from: null, to: null });
    expect(parseIsoRange(new URLSearchParams("from=&to="))).toEqual({ from: null, to: null });
  });

  it("合法 ISO UTC 原样返回", () => {
    expect(parseIsoRange(new URLSearchParams("from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z")))
      .toEqual({ from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
  });

  it("非法格式与颠倒区间都抛 InvalidUsageRangeError", () => {
    for (const query of [
      "from=2026-09-01",
      "from=yesterday",
      "to=2026-09-01T00:00:00Z",
      "from=2026-10-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z",
    ]) {
      expect(() => parseIsoRange(new URLSearchParams(query))).toThrow(InvalidUsageRangeError);
    }
  });
});

describe("parseFeature", () => {
  it("缺省与空串返回 null", () => {
    expect(parseFeature(null)).toBeNull();
    expect(parseFeature("")).toBeNull();
  });

  it("合法 feature 原样返回", () => {
    expect(parseFeature("简历润色")).toBe("简历润色");
    expect(parseFeature("黑话解码")).toBe("黑话解码");
  });

  it("非法 feature 抛 InvalidUsageRangeError", () => {
    expect(() => parseFeature("不存在的功能")).toThrow(InvalidUsageRangeError);
  });
});
