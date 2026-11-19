import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-notebook-sync-route-test-";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolved = path.resolve(tempDir);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !path.basename(resolved).startsWith(TEMP_PREFIX)
  ) {
    throw new Error(`Unsafe cleanup path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

describe("错题本写入时补全与反馈归属", () => {
  it("模拟面试生成参考答案后，自动同步到已收藏的错题本中", async () => {
    // 准备数据
    db.prepare("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '测试简历', '2026-01-01', '2026-01-01')").run();
    db.prepare("INSERT INTO interviews (id, resume_id, jd, rounds, style, status, created_at) VALUES (1, 1, '前端开发', 3, 'deep', 'finished', '2026-01-01')").run();
    db.prepare(`
      INSERT INTO interview_turns (id, interview_id, idx, kind, question, answer, comment, reference, scores, answered_at)
      VALUES (10, 1, 1, 'question', '请解释 React Fiber', '原答：Fiber 是新架构', '答得一般', '', '{"depth":6,"structure":6,"authenticity":6,"completeness":6}', '2026-01-01')
    `).run();

    // 在生成参考答案前先收藏
    const notebookPostRes = await (await import("@/app/api/notebook/route")).POST(
      new Request("http://127.0.0.1/api/notebook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "interview", source_id: 10 }),
      })
    );
    expect(notebookPostRes.status).toBe(201);
    const { id: notebookId } = (await notebookPostRes.json()) as { id: number };

    // 验证此时错题本里没有参考答案
    let entry = db.prepare("SELECT * FROM notebook_entries WHERE id = ?").get(notebookId) as { reference: string };
    expect(entry.reference).toBe("");

    // Mock safeChat 生成参考答案
    vi.doMock("@/lib/safe-llm", async () => {
      const actual = await vi.importActual<typeof import("@/lib/safe-llm")>("@/lib/safe-llm");
      return {
        ...actual,
        safeChat: vi.fn().mockResolvedValue(JSON.stringify({
          reference: "Fiber 是 React 16 引入的协作式多任务调度与协调引擎...",
        })),
      };
    });

    const refRoute = await import("@/app/api/interviews/[id]/turns/[tid]/reference/route");
    const refRes = await refRoute.POST(
      new Request("http://127.0.0.1/api/interviews/1/turns/10/reference", { method: "POST" }),
      { params: Promise.resolve({ id: "1", tid: "10" }) }
    );
    expect(refRes.status).toBe(200);

    // 验证错题本中已自动同步上生成的参考答案！
    entry = db.prepare("SELECT * FROM notebook_entries WHERE id = ?").get(notebookId) as { reference: string };
    expect(entry.reference).toContain("Fiber 是 React 16 引入的协作式多任务调度");
  });

  it("题目练习提交作答与评分后，自动同步到已收藏的错题本中", async () => {
    db.prepare("INSERT INTO drills (id, source, jd, focus, created_at) VALUES (1, 'bank', '前端', 'React', '2026-01-01')").run();
    db.prepare(`
      INSERT INTO drill_questions (id, drill_id, idx, question, answer, comment, reference, scores, answered_at, kind)
      VALUES (20, 1, 1, 'CSS 盒模型区别？', '', '', '', '', '', 'core')
    `).run();

    // 在提交作答前先收藏
    const notebookPostRes = await (await import("@/app/api/notebook/route")).POST(
      new Request("http://127.0.0.1/api/notebook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "drill", source_id: 20 }),
      })
    );
    expect(notebookPostRes.status).toBe(201);
    const { id: notebookId } = (await notebookPostRes.json()) as { id: number };

    // 验证初始状态为空
    let entry = db.prepare("SELECT * FROM notebook_entries WHERE id = ?").get(notebookId) as {
      answer: string;
      comment: string;
      reference: string;
      scores: string;
    };
    expect(entry.answer).toBe("");
    expect(entry.reference).toBe("");

    // Mock safeChat 进行练习打分与生成参考答案
    vi.doMock("@/lib/safe-llm", async () => {
      const actual = await vi.importActual<typeof import("@/lib/safe-llm")>("@/lib/safe-llm");
      return {
        ...actual,
        safeChat: vi.fn().mockResolvedValue(JSON.stringify({
          depth: 9,
          structure: 9,
          authenticity: 9,
          completeness: 9,
          comment: "回答非常到位",
          reference: "标准参考答案：标准盒模型与怪异盒模型（border-box）的区别在于 width 包含范围...",
        })),
      };
    });

    const drillRoute = await import("@/app/api/drills/[id]/questions/[qid]/route");
    const drillRes = await drillRoute.POST(
      new Request("http://127.0.0.1/api/drills/1/questions/20", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "标准盒模型 width 仅包括 content，怪异盒模型包含 padding 和 border" }),
      }),
      { params: Promise.resolve({ id: "1", qid: "20" }) }
    );
    expect(drillRes.status).toBe(200);

    // 验证错题本已自动同步作答、参考答案、点评和分数！
    entry = db.prepare("SELECT * FROM notebook_entries WHERE id = ?").get(notebookId) as {
      answer: string;
      comment: string;
      reference: string;
      scores: string;
    };
    expect(entry.answer).toContain("标准盒模型 width 仅包括 content");
    expect(entry.comment).toBe("回答非常到位");
    expect(entry.reference).toContain("标准参考答案：标准盒模型与怪异盒模型");
    expect(entry.scores).toContain('"depth":9');
  });

  it("练习重答保存成功，但旧收藏的缺失反馈不能从新原答补入", async () => {
    db.exec(`INSERT INTO drills (id, source, jd, focus, created_at) VALUES (1, 'bank', '接口开发', '', '');
      INSERT INTO drill_questions (id, drill_id, idx, question, answer, answered_at)
        VALUES (20, 1, 1, '你个人负责什么？', '原答：仅做接口校验，未上线。', '已答');`);
    const { POST } = await import("@/app/api/notebook/route");
    const collected = await POST(new Request("http://localhost/api/notebook", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "drill", source_id: 20 }),
    }));
    expect(collected.status).toBe(201);
    const notebook = await collected.json();
    const before = db.prepare("SELECT * FROM notebook_entries WHERE id = ?").get(notebook.id);
    vi.doMock("@/lib/safe-llm", async () => ({
      ...await vi.importActual<typeof import("@/lib/safe-llm")>("@/lib/safe-llm"),
      safeChat: vi.fn().mockResolvedValue(JSON.stringify({
        depth: 8, structure: 8, authenticity: 9, completeness: 8,
        comment: "本次重答点评", reference: "本次重答参考 <T> &amp;，仍待验证。",
      })),
    }));
    const answer = "新原答：还负责联调 <T> &amp;，仍未上线。";
    const response = await (await import("@/app/api/drills/[id]/questions/[qid]/route")).POST(
      new Request("http://localhost/api/drills/1/questions/20", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer }) }),
      { params: Promise.resolve({ id: "1", qid: "20" }) },
    );
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT answer, comment FROM drill_questions WHERE id = 20").get())
      .toEqual({ answer, comment: "本次重答点评" });
    expect(db.prepare("SELECT * FROM notebook_entries WHERE id = ?").get(notebook.id)).toEqual(before);
    const detail = await (await import("@/app/api/notebook/[id]/route")).GET(
      new Request(`http://localhost/api/notebook/${notebook.id}`), { params: Promise.resolve({ id: String(notebook.id) }) },
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ answer: "原答：仅做接口校验，未上线。", comment: "", reference: "" });
    const review = await (await import("@/app/api/reviews/[id]/route")).GET(
      new Request(`http://localhost/api/reviews/${notebook.review.review_card_id}`),
      { params: Promise.resolve({ id: String(notebook.review.review_card_id) }) },
    );
    expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({ answer: "原答：仅做接口校验，未上线。", comment: "", reference: "" });
  });

  it.each(["重答前", "重答后"])("%s 收藏面试题，重答参考只属于该次重答；原题参考可另行生成补全", async (timing) => {
    db.exec(`INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '测试简历', '', '');
      INSERT INTO interviews (id, resume_id, jd, rounds, style, status, created_at)
        VALUES (1, 1, '接口开发', 1, 'deep', 'finished', '');
      INSERT INTO interview_turns (id, interview_id, idx, kind, question, answer, comment, scores, answered_at)
        VALUES (10, 1, 1, 'question', '你的个人分工？', '原答：仅做接口校验，未上线。', '原答点评', '{"depth":6,"structure":6,"authenticity":6,"completeness":6}', '已答');`);
    const notebookRoute = await import("@/app/api/notebook/route");
    const collect = async () => {
      const response = await notebookRoute.POST(new Request("http://localhost/api/notebook", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "interview", source_id: 10 }),
      }));
      expect(response.status).toBe(201);
      return response.json() as Promise<{ id: number }>;
    };
    let notebook = timing === "重答前" ? await collect() : null;
    const before = notebook ? db.prepare("SELECT * FROM notebook_entries WHERE id = ?").get(notebook.id) : null;
    const reference = "本次重答参考 <T> &amp;\n[待补充：真实联调记录]。";
    vi.doMock("@/lib/safe-llm", async () => ({
      ...await vi.importActual<typeof import("@/lib/safe-llm")>("@/lib/safe-llm"),
      safeChat: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({ depth: 8, structure: 8, authenticity: 9, completeness: 8, comment: "重答点评", reference }))
        .mockResolvedValueOnce(JSON.stringify({ reference: "依据原答生成的题目参考" })),
    }));
    const retry = await (await import("@/app/api/interviews/[id]/turns/[tid]/retry/route")).POST(
      new Request("http://localhost/api/interviews/1/turns/10/retry", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "重答：还负责联调，未上线。" }),
      }), { params: Promise.resolve({ id: "1", tid: "10" }) },
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ reference: "", retry: { answer: "重答：还负责联调，未上线。", reference } });
    const turn = db.prepare("SELECT answer, comment, reference, retries FROM interview_turns WHERE id = 10").get() as {
      answer: string; comment: string; reference: string; retries: string;
    };
    expect(turn).toMatchObject({ answer: "原答：仅做接口校验，未上线。", comment: "原答点评", reference: "" });
    expect(JSON.parse(turn.retries)).toEqual([expect.objectContaining({ reference, comment: "重答点评" })]);
    if (notebook) expect(db.prepare("SELECT * FROM notebook_entries WHERE id = ?").get(notebook.id)).toEqual(before);
    else notebook = await collect();
    expect(db.prepare("SELECT answer, comment, reference FROM notebook_entries WHERE id = ?").get(notebook.id))
      .toEqual({ answer: turn.answer, comment: "原答点评", reference: "" });
    const generated = await (await import("@/app/api/interviews/[id]/turns/[tid]/reference/route")).POST(
      new Request("http://localhost/api/interviews/1/turns/10/reference", { method: "POST" }),
      { params: Promise.resolve({ id: "1", tid: "10" }) },
    );
    expect(generated.status).toBe(200);
    expect(db.prepare("SELECT answer, comment, reference FROM notebook_entries WHERE id = ?").get(notebook.id))
      .toEqual({ answer: turn.answer, comment: "原答点评", reference: "依据原答生成的题目参考" });
    expect(db.prepare("SELECT retries FROM interview_turns WHERE id = 10").get()).toEqual({ retries: turn.retries });
  });

  it.each(["列表", "详情"])("GET %s 不回填历史快照，并发写锁下仍可只读访问", async (view) => {
    db.prepare("INSERT INTO drills (id, source, jd, focus, created_at) VALUES (1, 'bank', '', '', '2026-01-01')").run();
    db.prepare(`
      INSERT INTO drill_questions (id, drill_id, idx, question, answer, comment, reference, scores, answered_at, kind)
      VALUES (30, 1, 1, '回填测试题', '我的回答', '我的点评', '练习标准答案示范', '{"depth":8}', '2026-01-01', 'core')
    `).run();

    // 历史存留的错题条目（reference 是空的）
    db.prepare(`
      INSERT INTO notebook_entries (id, source, source_id, question, answer, comment, reference, scores, created_at, updated_at)
      VALUES (88, 'drill', 30, '回填测试题', '', '', '', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();

    const notebookRoute = await import("@/app/api/notebook/route");
    const detailRoute = await import("@/app/api/notebook/[id]/route");
    const writer = new DatabaseSync(path.join(tempDir, "data", "resume-life.db"));
    db.exec("PRAGMA busy_timeout = 10");
    writer.exec("BEGIN IMMEDIATE");
    try {
      const response = view === "列表"
        ? await notebookRoute.GET(new Request("http://127.0.0.1/api/notebook?limit=1"))
        : await detailRoute.GET(new Request("http://127.0.0.1/api/notebook/88"), { params: Promise.resolve({ id: "88" }) });
      expect(response.status).toBe(200);
      const data = await response.json();
      const entry = view === "列表" ? data.items[0] : data;
      expect(entry).toMatchObject({ id: 88, reference: "", answer: "" });
      expect(db.prepare("SELECT answer, reference, updated_at FROM notebook_entries WHERE id = 88").get()).toEqual({
        answer: "", reference: "", updated_at: "2026-01-01T00:00:00.000Z",
      });
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });
});
