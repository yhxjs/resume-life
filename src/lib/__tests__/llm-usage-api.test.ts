import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as DatabaseSync | undefined }));

vi.mock("../db", () => ({
  requestDataGeneration: () => null,
  getDb: () => {
    if (!holder.db) throw new Error("测试未初始化数据库");
    return holder.db;
  },
}));
vi.mock("../server-errors", async (original) => ({
  ...await original<typeof import("../server-errors")>(),
  logServerEvent: () => {},
  logServerError: (_op: string, _err: unknown, options: { requestId?: string }) => options.requestId ?? "rid",
  requestIdFrom: () => "rid",
}));

import { GET as getLogs } from "../../app/api/settings/llm-logs/route";
import { GET as getUsage } from "../../app/api/settings/llm-usage/route";

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

function insert(createdAt: string, feature = "简历润色", input: number | null = 100, cached: number | null = 40) {
  holder.db!
    .prepare(
      `INSERT INTO llm_call_logs
         (created_at, feature, entity_type, entity_id, entity_label, task, model, api_format,
          status, error_code, attempts, duration_ms, input_tokens, output_tokens, cached_tokens)
       VALUES (?, ?, 'resume', 12, '前端开发工程师', 'summary', 'm', 'openai_chat', 'ok', '', 0, 0, ?, 7, ?)`
    )
    .run(createdAt, feature, input, cached);
}

function request(path: string) {
  return new Request(`http://127.0.0.1:3000${path}`);
}

beforeEach(() => {
  holder.db = new DatabaseSync(":memory:");
  holder.db.exec(DDL);
});

describe("GET /api/settings/llm-usage", () => {
  it("接受浏览器时区并按当地日期分组", async () => {
    insert("2026-10-18T02:00:00.000Z");
    const res = await getUsage(request("/api/settings/llm-usage?from=2026-10-17T16:00:00.000Z&to=2026-10-18T16:00:00.000Z&timeZone=Asia%2FShanghai"));
    expect(res.status).toBe(200);
    expect((await res.json()).daily).toEqual([{ date: "2026-10-18", calls: 1, failed: 0, inputTokens: 100, outputTokens: 7, cachedTokens: 40 }]);
  });

  it("非法时区返回 400", async () => {
    const res = await getUsage(request("/api/settings/llm-usage?timeZone=Invalid%2FZone"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/timeZone/);
  });

  it("极长区间明确拒绝而不静默截断趋势", async () => {
    const res = await getUsage(request("/api/settings/llm-usage?from=2000-01-01T00:00:00.000Z&to=2026-10-19T00:00:00.000Z"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/3660/);
  });

  it("返回汇总，含上报次数", async () => {
    insert("2026-09-10T00:00:00.000Z");
    insert("2026-09-11T00:00:00.000Z", "黑话解码", null, null);

    const res = await getUsage(request("/api/settings/llm-usage"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      calls: 2, failed: 0, cancelled: 0,
      inputTokens: 100, outputTokens: 14, cachedTokens: 40,
      usageReportedCalls: 1, cacheReportedCalls: 1,
    });
  });

  it("from / to 生效", async () => {
    insert("2026-08-01T00:00:00.000Z");
    insert("2026-09-10T00:00:00.000Z");

    const res = await getUsage(request("/api/settings/llm-usage?from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z"));
    expect(await res.json()).toMatchObject({ calls: 1 });
  });

  it("非法时间参数返回 400", async () => {
    const res = await getUsage(request("/api/settings/llm-usage?from=2026-09-01"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ISO 8601/);
  });

  it("feature 过滤生效", async () => {
    insert("2026-09-10T00:00:00.000Z", "简历润色", 100, 40);
    insert("2026-09-11T00:00:00.000Z", "黑话解码", 200, 80);

    const res = await getUsage(request("/api/settings/llm-usage?feature=%E9%BB%91%E8%AF%9D%E8%A7%A3%E7%A0%81"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ calls: 1, inputTokens: 200, cachedTokens: 80 });
  });

  it("返回 daily、byFeature 和 byModel 聚合数据", async () => {
    insert("2026-09-10T10:00:00.000Z", "简历润色", 100, 40);
    insert("2026-09-10T14:00:00.000Z", "简历润色", 50, 10);
    insert("2026-09-12T08:00:00.000Z", "黑话解码", 200, 80);

    const res = await getUsage(
      request("/api/settings/llm-usage?from=2026-09-10T00:00:00.000Z&to=2026-09-13T00:00:00.000Z")
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // 验证连续补齐：包含 09-10, 09-11 (补0), 09-12 共 3 天
    expect(body.daily).toHaveLength(3);
    expect(body.daily[0]).toMatchObject({
      date: "2026-09-10",
      calls: 2,
      inputTokens: 150,
      cachedTokens: 50,
    });
    expect(body.daily[1]).toMatchObject({
      date: "2026-09-11",
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(body.daily[2]).toMatchObject({
      date: "2026-09-12",
      calls: 1,
      inputTokens: 200,
      cachedTokens: 80,
    });

    // 验证 byFeature
    expect(body.byFeature).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: "黑话解码", calls: 1 }),
        expect.objectContaining({ feature: "简历润色", calls: 2 }),
      ])
    );

    // 验证 byModel
    expect(body.byModel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "m", calls: 3 }),
      ])
    );
  });

  it("非法 feature 参数返回 400", async () => {
    const res = await getUsage(request("/api/settings/llm-usage?feature=不存在"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/feature 参数无效/);
  });
});

describe("GET /api/settings/llm-logs", () => {
  it("返回 camelCase 行与游标", async () => {
    insert("2026-09-10T00:00:00.000Z");
    insert("2026-09-11T00:00:00.000Z");

    const res = await getLogs(request("/api/settings/llm-logs?limit=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBe("2");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: 2, feature: "简历润色", entityType: "resume", entityId: 12,
      entityLabel: "前端开发工程师", status: "ok", inputTokens: 100, cachedTokens: 40,
    });
  });

  it("feature 过滤与游标翻页", async () => {
    insert("2026-09-10T00:00:00.000Z", "简历润色");
    insert("2026-09-11T00:00:00.000Z", "黑话解码");

    const filtered = await getLogs(request("/api/settings/llm-logs?feature=%E9%BB%91%E8%AF%9D%E8%A7%A3%E7%A0%81"));
    expect((await filtered.json()).items.map((r: { feature: string }) => r.feature)).toEqual(["黑话解码"]);

    const next = await getLogs(request("/api/settings/llm-logs?cursor=2"));
    expect((await next.json()).items.map((r: { id: number }) => r.id)).toEqual([1]);
  });

  it("未知 feature、非法 limit、非法 cursor 都返回 400", async () => {
    for (const query of ["feature=不存在", "limit=0", "limit=abc", "cursor=-1", "cursor=abc"]) {
      const res = await getLogs(request(`/api/settings/llm-logs?${query}`));
      expect(res.status, query).toBe(400);
    }
  });
});
