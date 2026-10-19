import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * 真实后端的分页契约测试：不 mock 任何 /api 请求，直接验证游标分页与统计口径。
 * 合成后端（synthetic-api）无法发现真实游标算法漂移，这里补上那一层。
 */

type CursorPage<T> = { items: T[]; nextCursor: string | null };

async function fetchPage<T>(
  request: APIRequestContext,
  path: string,
  params: Record<string, string>
): Promise<CursorPage<T>> {
  const search = new URLSearchParams(params);
  const response = await request.get(`${path}?${search.toString()}`);
  expect(response.status(), `${path} 应返回 200`).toBe(200);
  return (await response.json()) as CursorPage<T>;
}

/** 按游标翻完全部页面，返回拼接后的条目与页数 */
async function walkAllPages<T>(
  request: APIRequestContext,
  path: string,
  params: Record<string, string> = {},
  limit = 50
): Promise<{ items: T[]; pages: number }> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 60; page += 1) {
    const chunk: CursorPage<T> = await fetchPage<T>(request, path, {
      ...params,
      limit: String(limit),
      ...(cursor === null ? {} : { cursor }),
    });
    items.push(...chunk.items);
    cursor = chunk.nextCursor;
    if (cursor === null) return { items, pages: page + 1 };
  }
  throw new Error("分页未在 60 页内结束，游标可能没有推进");
}

test("真实 API：题库游标分页不重复、不丢项、严格递减", async ({ request }) => {
  const marker = `E2E游标${Date.now()}`;
  const total = 120;
  const questions = Array.from({ length: total }, (_, i) => `${marker}-题目-${String(i).padStart(3, "0")}`);

  const created = await request.post("/api/bank", {
    data: { direction: marker, kind: "tech", text: questions.join("\n") },
  });
  expect(created.status()).toBe(201);
  expect((await created.json()).count).toBe(total);

  const { items, pages } = await walkAllPages<{ id: number; question: string }>(request, "/api/bank", {
    direction: marker,
  });

  expect(pages).toBeGreaterThan(1);
  expect(items).toHaveLength(total);

  const ids = items.map((item) => item.id);
  expect(new Set(ids).size, "翻页过程中出现了重复条目").toBe(total);
  for (let i = 1; i < ids.length; i += 1) {
    expect(ids[i]!, "游标分页未保持 id 严格递减").toBeLessThan(ids[i - 1]!);
  }

  const seenQuestions = new Set(items.map((item) => item.question));
  expect(seenQuestions.size).toBe(total);
  for (const question of questions) {
    expect(seenQuestions.has(question), `漏掉了 ${question}`).toBe(true);
  }
});

test("真实 API：投递列表翻页与统计口径一致", async ({ request }) => {
  const before = await (await request.get("/api/applications/stats")).json();

  const suffix = Date.now();
  const created: { id: number; stage: string }[] = [];
  for (const stage of ["applied", "interviewing", "offer"]) {
    const response = await request.post("/api/applications", {
      data: { company: `E2E公司-${suffix}`, role: `E2E岗位-${stage}`, stage },
    });
    expect(response.status()).toBe(201);
    created.push({ id: (await response.json()).id, stage });
  }

  const after = await (await request.get("/api/applications/stats")).json();
  for (const stage of ["applied", "interviewing", "offer"]) {
    expect(after.counts[stage] - before.counts[stage], `${stage} 阶段统计未随写入增长`).toBe(1);
  }

  const { items } = await walkAllPages<{ id: number; stage: string }>(request, "/api/applications", {}, 2);
  const ids = items.map((item) => item.id);
  expect(new Set(ids).size, "投递列表翻页出现重复条目").toBe(ids.length);
  for (const { id } of created) {
    expect(ids, `新建的投递 ${id} 未出现在分页结果中`).toContain(id);
  }

  // 统计的阶段计数应等于按阶段过滤后逐页走完的条目数
  for (const stage of ["applied", "interviewing", "offer"]) {
    const filtered = await walkAllPages<{ id: number }>(request, "/api/applications", { stage }, 2);
    expect(filtered.items.length, `${stage} 阶段列表条数与统计不一致`).toBe(after.counts[stage]);
  }
});

test("真实 API：非法分页参数被拒绝", async ({ request }) => {
  for (const query of ["limit=0", "limit=1000", "limit=abc", "cursor=-1", "cursor=abc"]) {
    const response = await request.get(`/api/bank?${query}`);
    expect(response.status(), `${query} 应被拒绝`).toBe(400);
    expect((await response.json()).error).toBe("分页参数无效");
  }
});
