import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_JSON_REQUEST_BYTES, MAX_PROJECT_MATERIAL_CHARS } from "../request-limits";
import { MAX_MODEL_INPUT_CHARS } from "../llm-input-budget";
import { emptySummary } from "../summary";

const boundary = vi.hoisted(() => ({ chat: vi.fn(), chatStream: vi.fn(), resume: "合成简历", resumeError: null as Error | null }));
vi.mock("../llm", async (original) => ({ ...await original<typeof import("../llm")>(), chat: boundary.chat, chatStream: boundary.chatStream }));
vi.mock("../resumes", () => ({
  loadResume: () => ({ resume: { id: 1, title: "合成简历", template: "classic", style_overrides: {} }, modules: [], warnings: [], corruptedKeys: [] }),
  loadResumeContext: () => {
  if (boundary.resumeError) throw boundary.resumeError;
  return boundary.resume;
} }));
vi.mock("../intro-resume-context", async (original) => ({
  ...await original<typeof import("../intro-resume-context")>(),
  loadIntroResumeContext: () => {
    if (boundary.resumeError) throw boundary.resumeError;
    return boundary.resume;
  },
}));
let directory: string;
let db: DatabaseSync;
const req = (body: unknown) => new Request("http://localhost/api", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function failingJsonRequest(error: unknown, requestId: string) {
  const cancel = vi.fn().mockResolvedValue(undefined);
  const releaseLock = vi.fn();
  const request = {
    headers: new Headers({ "x-request-id": requestId }),
    body: {
      getReader: () => ({
        read: vi.fn().mockRejectedValueOnce(error),
        cancel,
        releaseLock,
      }),
    },
  } as unknown as Request;
  return { request, cancel, releaseLock };
}

function insertRows(
  sql: string,
  count: number,
  values: (index: number) => SQLInputValue[],
) {
  db.exec("BEGIN");
  try {
    const statement = db.prepare(sql);
    for (let index = 1; index <= count; index++) statement.run(...values(index));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function traceSelects(table: string) {
  const prepared: string[] = [];
  const executed: { sql: string; params: SQLInputValue[] }[] = [];
  const iterated: { sql: string; params: SQLInputValue[]; rows: number; closed: boolean }[] = [];
  const originalPrepare = db.prepare.bind(db);
  const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const statement = originalPrepare(sql);
    if (!new RegExp(`\\bFROM\\s+${table}\\b`, "i").test(sql)) return statement;
    prepared.push(sql);
    return new Proxy(statement, {
      get(target, property) {
        if (property === "all") {
          return (...params: SQLInputValue[]) => {
            executed.push({ sql, params });
            return target.all(...params);
          };
        }
        if (property === "iterate") {
          return function* (...params: SQLInputValue[]) {
            const read = { sql, params, rows: 0, closed: false };
            iterated.push(read);
            try {
              for (const row of target.iterate(...params)) {
                read.rows++;
                yield row;
              }
            } finally { read.closed = true; }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  return { prepared, executed, iterated, restore: () => prepareSpy.mockRestore() };
}

function compactSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

beforeEach(async () => {
  vi.resetModules();
  boundary.chat.mockReset(); boundary.chatStream.mockReset(); boundary.resume = "合成简历"; boundary.resumeError = null;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-budget-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'合成简历','','')");
  (await import("../resume-versions")).publishResumeVersion(1, { name: "测试发布版本" });
});

it.each(["jd-portraits", "jargon-decodings", "career-gap-remedies"])("%s 的真实输入预算超限返回 413 且不调用模型", async (tool) => {
  const routes = {
    "jd-portraits": () => import("../../app/api/tools/jd-portraits/route"),
    "jargon-decodings": () => import("../../app/api/tools/jargon-decodings/route"),
    "career-gap-remedies": () => import("../../app/api/tools/career-gap-remedies/route"),
  };
  const text = "x".repeat(MAX_MODEL_INPUT_CHARS + 1);
  const body = tool === "jd-portraits" ? { jd: text } : tool === "jargon-decodings" ? { text } : { rawStory: text };
  const { POST } = await routes[tool as keyof typeof routes]();
  const response = await POST(req(body));
  expect(response.status).toBe(413);
  expect((await response.json()).error).toContain("64000");
  expect(boundary.chat).not.toHaveBeenCalled();
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-budget-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("import parse request budget", () => {
  it("rejects JSON one byte over the request budget before calling the model", async () => {
    const emptyBody = JSON.stringify({ text: "" });
    const text = "x".repeat(MAX_JSON_REQUEST_BYTES + 1 - Buffer.byteLength(emptyBody));
    const body = JSON.stringify({ text });
    expect(Buffer.byteLength(body)).toBe(MAX_JSON_REQUEST_BYTES + 1);
    const { POST } = await import("../../app/api/import/parse/route");
    const response = await POST(new Request("http://localhost/api/import/parse", {
      method: "POST",
      body,
    }));

    expect(response.status).toBe(413);
    expect(boundary.chat).not.toHaveBeenCalled();
  });

  it("完整读取请求体边界内的原文，模型预算超限时保留全文而不截断调用", async () => {
    const emptyBody = JSON.stringify({ text: "" });
    const sourcePrefix = "x".repeat(60_000);
    const tailMarker = "UNIQUE_TEXT_AFTER_MODEL_LIMIT";
    const textLength = MAX_JSON_REQUEST_BYTES - Buffer.byteLength(emptyBody);
    const text = `${sourcePrefix}${tailMarker}${"y".repeat(
      textLength - sourcePrefix.length - tailMarker.length,
    )}`;
    const body = JSON.stringify({ text });
    expect(Buffer.byteLength(body)).toBe(MAX_JSON_REQUEST_BYTES);
    boundary.chat.mockResolvedValue('{"title":"边界简历","summary":{"text":"有效内容"}}');
    const { POST } = await import("../../app/api/import/parse/route");

    const response = await POST(new Request("http://localhost/api/import/parse", {
      method: "POST",
      body,
    }));

    expect(response.status).toBe(413);
    expect(boundary.chat).not.toHaveBeenCalled();
    const result = await response.json();
    expect(result.error).toContain("完整模型输入");
    expect(result.extractedText).toBe(text);
  });

  it("maps malformed JSON to 400 without calling the model", async () => {
    const { POST } = await import("../../app/api/import/parse/route");
    const response = await POST(new Request("http://localhost/api/import/parse", {
      method: "POST",
      body: "{broken",
    }));

    expect(response.status).toBe(400);
    expect(boundary.chat).not.toHaveBeenCalled();
  });

  it("maps a SyntaxError from the request stream to one generic logged 500", async () => {
    const internalMessage = "PRIVATE_IMPORT_JSON_STREAM_FAILURE";
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const { request, cancel, releaseLock } = failingJsonRequest(
      new SyntaxError(internalMessage),
      "req-import-json-stream",
    );

    try {
      const { POST } = await import("../../app/api/import/parse/route");
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result).toEqual({
        error: "简历文件处理失败，请稍后重试",
        requestId: "req-import-json-stream",
      });
      expect(JSON.stringify(result)).not.toContain(internalMessage);
      expect(output).toHaveBeenCalledOnce();
      expect(JSON.stringify(output.mock.calls.flat())).not.toContain(internalMessage);
      expect(boundary.chat).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(releaseLock).toHaveBeenCalledOnce();
    } finally {
      output.mockRestore();
    }
  });
});

describe("project material route budget", () => {
  const projectContext = { params: Promise.resolve({ id: "1" }) };
  const materialContext = { params: Promise.resolve({ id: "1", mid: "1" }) };

  beforeEach(() => {
    db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'预算项目','created','original-project'); INSERT INTO project_materials (id,project_id,title,content,created_at) VALUES (1,1,'原材料','原内容','original-material')");
  });

  function databaseState() {
    return {
      project: db.prepare("SELECT * FROM projects WHERE id = 1").get(),
      materials: db.prepare("SELECT * FROM project_materials ORDER BY id").all(),
    };
  }

  async function writeMaterial(action: "create" | "update", body: unknown) {
    if (action === "create") {
      const { POST } = await import("../../app/api/projects/[id]/materials/route");
      return POST(req(body), projectContext);
    }
    const { PATCH } = await import("../../app/api/projects/[id]/materials/[mid]/route");
    const { materialRevision } = await import("../project-material-revisions");
    const value = body && typeof body === "object" ? body as Record<string, unknown> : null;
    const current = db.prepare("SELECT id, title, content FROM project_materials WHERE id = 1").get() as { id: number; title: string; content: string };
    return PATCH(req(value && value.expectedRevision === undefined ? { ...value, expectedRevision: materialRevision(1, current) } : body), materialContext);
  }

  it.each((["create", "update"] as const).flatMap(action => ["title", "content"].flatMap(field =>
    ([null, 0, true, [], ["材料"], {}] as unknown[]).map(value => ({ action, field, value })),
  )))("$action rejects $field=$value without losing supplied material", async ({ action, field, value }) => {
    const before = databaseState();
    const response = await writeMaterial(action, { title: "完整标题", content: "完整正文 <T> &amp;", [field]: value });
    expect(response.status).toBe(400);
    expect(databaseState()).toEqual(before);
  });

  it.each([undefined, "", " \n "])("create keeps the default title rule for %j and stores the entire original content", async title => {
    const content = "  第一行  <T> &amp;\n第二行正文保留  ";
    const response = await writeMaterial("create", { title, content });
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({ title: content.trim().slice(0, 20), source: "paste", filename: "" });
    expect(db.prepare("SELECT title, content FROM project_materials WHERE id = ?").get(created.id))
      .toEqual({ title: created.title, content });
    expect(db.prepare("SELECT title,content FROM project_materials WHERE id = 1").get()).toEqual({ title: "原材料", content: "原内容" });
  });

  it("both material routes reject JSON primitives/arrays without rewriting the existing material", async () => {
    const before = databaseState();
    const create = await import("../../app/api/projects/[id]/materials/route");
    const update = await import("../../app/api/projects/[id]/materials/[mid]/route");
    for (const value of [null, [], "正文", 1, true]) {
      expect((await create.POST(req(value), projectContext)).status).toBe(400);
      expect((await update.PATCH(req(value), materialContext)).status).toBe(400);
    }
    expect(databaseState()).toEqual(before);
  });

  it.each(["create", "update"] as const)(
    "%s rejects an oversized JSON request before changing the database",
    async (action) => {
      const before = databaseState();
      const response = await writeMaterial(action, {
        title: "t".repeat(MAX_JSON_REQUEST_BYTES),
        content: "有效内容",
      });

      expect(response.status).toBe(413);
      expect(databaseState()).toEqual(before);
    },
  );

  it.each(["create", "update"] as const)(
    "%s rejects one Unicode code point over the shared material limit before persistence",
    async (action) => {
      const before = databaseState();
      const content = `${"😀".repeat(MAX_PROJECT_MATERIAL_CHARS)}x`;
      const response = await writeMaterial(action, { title: "超限材料", content });

      expect(response.status).toBe(413);
      expect(databaseState()).toEqual(before);
    },
  );

  it.each(["create", "update"] as const)(
    "%s accepts the exact shared Unicode code point boundary",
    async (action) => {
      const content = "😀".repeat(MAX_PROJECT_MATERIAL_CHARS);
      const response = await writeMaterial(action, { title: "边界材料", content });

      expect(response.status).toBe(action === "create" ? 201 : 200);
      const stored = action === "create"
        ? db.prepare("SELECT title, content FROM project_materials WHERE id <> 1").get()
        : db.prepare("SELECT title, content FROM project_materials WHERE id = 1").get();
      expect(stored).toEqual({ title: "边界材料", content });
    },
  );

  it.each(["create", "update"] as const)(
    "%s maps malformed JSON to 400 without changing the database",
    async (action) => {
      const before = databaseState();
      const invalidRequest = new Request("http://localhost/api/projects/1/materials", {
        method: action === "create" ? "POST" : "PATCH",
        body: "{broken",
      });
      const response = action === "create"
        ? await (await import("../../app/api/projects/[id]/materials/route")).POST(invalidRequest, projectContext)
        : await (await import("../../app/api/projects/[id]/materials/[mid]/route")).PATCH(invalidRequest, materialContext);

      expect(response.status).toBe(400);
      expect(databaseState()).toEqual(before);
    },
  );

  it.each(["create", "update"] as const)(
    "%s maps a SyntaxError from the request stream to one generic logged 500 without changing the database",
    async (action) => {
      const before = databaseState();
      const internalMessage = `PRIVATE_MATERIAL_${action.toUpperCase()}_JSON_STREAM_FAILURE`;
      const requestId = `req-material-${action}`;
      const output = vi.spyOn(console, "error").mockImplementation(() => {});
      const { request, cancel, releaseLock } = failingJsonRequest(
        new SyntaxError(internalMessage),
        requestId,
      );

      try {
        const response = action === "create"
          ? await (await import("../../app/api/projects/[id]/materials/route")).POST(request, projectContext)
          : await (await import("../../app/api/projects/[id]/materials/[mid]/route")).PATCH(request, materialContext);
        const result = await response.json();

        expect(response.status).toBe(500);
        expect(result).toEqual({
          error: action === "create"
            ? "保存项目材料失败，请稍后重试"
            : "更新项目材料失败，请稍后重试",
          requestId,
        });
        expect(JSON.stringify(result)).not.toContain(internalMessage);
        expect(output).toHaveBeenCalledOnce();
        expect(JSON.stringify(output.mock.calls.flat())).not.toContain(internalMessage);
        expect(databaseState()).toEqual(before);
        expect(cancel).toHaveBeenCalledOnce();
        expect(releaseLock).toHaveBeenCalledOnce();
      } finally {
        output.mockRestore();
      }
    },
  );
});

describe.each(["intros", "interviews"] as const)("%s input budget", (name) => {
  async function post(body: unknown) {
    const route = name === "intros" ? await import("../../app/api/intros/route") : await import("../../app/api/interviews/route");
    return route.POST(req(body));
  }
  it("returns a server error instead of not found when reading the resume fails", async () => {
    boundary.resumeError = new Error("SQLITE_IOERR private detail");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await post({ resume_id: 1, jd: "JD" });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "服务器内部错误，请稍后重试", requestId: expect.any(String) });
      expect(boundary.chatStream).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it("preserves the not-found response when the resume is absent", async () => {
    const { ResumeNotFoundError } = await import("../resume-errors");
    boundary.resumeError = new ResumeNotFoundError();
    const response = await post({ resume_id: 1, jd: "JD" });
    expect(response.status).toBe(404);
    expect(boundary.chatStream).not.toHaveBeenCalled();
  });
  it.each([12001, 70000])("rejects oversized JD (%i) before opening SSE or calling a model", async (length) => {
    const response = await post({ resume_id: 1, jd: "字".repeat(length) });
    // Consume only if the old route opened SSE, allowing this regression to observe the unwanted call.
    if (response.headers.get("content-type")?.includes("event-stream")) await response.text();
    expect(response.status).toBe(413);
    expect(boundary.chatStream).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()).toEqual({ n: 0 });
  });
  it("counts the resume and system prompt in the total input budget", async () => {
    boundary.resume = "r".repeat(63950);
    const response = await post({ resume_id: 1, jd: "JD" });
    if (response.headers.get("content-type")?.includes("event-stream")) await response.text();
    expect(response.status).toBe(413);
    expect(boundary.chatStream).not.toHaveBeenCalled();
  });
  it("rejects untrusted-data escaping expansion before opening SSE", async () => {
    boundary.resume = "&<>".repeat(19_000);
    const before = db.prepare(`SELECT * FROM ${name}`).all();

    const response = await post({ resume_id: 1, jd: "JD" });
    if (response.headers.get("content-type")?.includes("event-stream")) await response.text();

    expect(response.status).toBe(413);
    expect(boundary.chatStream).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT * FROM ${name}`).all()).toEqual(before);
  });
  it("allows JD at the field boundary and passes the complete input", async () => {
    boundary.chatStream.mockResolvedValue(name === "intros"
      ? '{"versions":[{"kind":"30s","sentences":[{"text":"合成内容","comment":"点评"}]}]}'
      : '{"question":"合成问题"}');
    const response = await post({ resume_id: 1, jd: "字".repeat(12000) });
    await response.text();
    expect(response.status).toBe(200);
    expect(boundary.chatStream).toHaveBeenCalledOnce();
    expect(boundary.chatStream.mock.calls[0]![1][1].content).toContain("字".repeat(12000));
  });
});

describe("existing interview input budgets", () => {
  const context = { params: Promise.resolve({ id: "1", tid: "1" }) };
  async function post(action: string, body: unknown) {
    switch (action) {
      case "answer": return (await import("../../app/api/interviews/[id]/answer/route")).POST(req(body), context);
      case "finish": return (await import("../../app/api/interviews/[id]/finish/route")).POST(req(body), context);
      case "evaluator": return (await import("../../app/api/interviews/[id]/evaluator-report/route")).POST(req(body), context);
      case "reverse": return (await import("../../app/api/interviews/[id]/reverse/route")).POST(req(body), context);
      case "retry": return (await import("../../app/api/interviews/[id]/turns/[tid]/retry/route")).POST(req(body), context);
      default: return (await import("../../app/api/interviews/[id]/turns/[tid]/reference/route")).POST(req(body), context);
    }
  }
  function seed(answered = false) {
    db.exec("INSERT INTO interviews (id,resume_id,jd,rounds,created_at) VALUES (1,1,'JD',3,''); INSERT INTO interview_turns (id,interview_id,idx,question) VALUES (1,1,1,'问题')");
    if (answered) db.exec(`UPDATE interview_turns SET answer='旧回答',answered_at='now',scores='{"depth":7,"structure":7,"authenticity":7,"completeness":7}'`);
  }
  it.each(["answer", "finish", "evaluator", "reverse", "retry", "reference"])("%s rejects oversized assembled context without calling the model", async (action) => {
    seed(action !== "answer");
    if (action === "evaluator") db.exec(`UPDATE interviews SET status='finished',report='{"depth":7,"structure":7,"authenticity":7,"completeness":7,"jd_match":7}'`);
    boundary.resume = "r".repeat(64000);
    const response = await post(action, { turn_id: 1, answer: "本轮回答", question: "反问" });
    if (response.headers.get("content-type")?.includes("event-stream")) await response.text();
    expect(response.status).toBe(413);
    expect(boundary.chat).not.toHaveBeenCalled();
    expect(boundary.chatStream).not.toHaveBeenCalled();
  });
  it.each(["answer", "finish", "evaluator", "reverse", "retry", "reference"])("%s stops before the model when reading the resume fails", async (action) => {
    seed(action !== "answer");
    if (action === "evaluator") db.exec(`UPDATE interviews SET status='finished',report='{"depth":7,"structure":7,"authenticity":7,"completeness":7,"jd_match":7}'`);
    boundary.resumeError = new Error("SQLITE_IOERR private detail");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await post(action, { turn_id: 1, answer: "本轮回答", question: "反问" });
      expect(response.status).toBe(500);
      const body = await response.json() as { error: string; requestId: string };
      expect(body.error).toBe("服务器内部错误，请稍后重试");
      expect(body.requestId).toEqual(expect.any(String));
      expect(JSON.stringify(body)).not.toContain("private detail");
      expect(boundary.chat).not.toHaveBeenCalled();
      expect(boundary.chatStream).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it.each(["answer", "retry", "reverse"])("%s enforces the per-field budget", async (action) => {
    seed();
    const response = await post(action, { turn_id: 1, answer: "字".repeat(12001), question: "字".repeat(12001) });
    if (response.headers.get("content-type")?.includes("event-stream")) await response.text();
    expect(response.status).toBe(413);
    expect(boundary.chat).not.toHaveBeenCalled();
    expect(boundary.chatStream).not.toHaveBeenCalled();
  });
  it("counts the accumulated original interview questions and answers", async () => {
    seed();
    db.prepare("INSERT INTO interview_turns (interview_id,idx,question,answer,comment,answered_at) VALUES (1,0,?,?,?,'now')")
      .run("Q".repeat(33000), "A".repeat(33000), "旧点评不参与预算");
    const response = await post("answer", { turn_id: 1, answer: "新回答" });
    if (response.headers.get("content-type")?.includes("event-stream")) await response.text();
    expect(response.status).toBe(413);
    expect(boundary.chatStream).not.toHaveBeenCalled();
  });
  it("rejects untrusted-data escaping expansion before opening the answer SSE", async () => {
    seed();
    boundary.resume = "&<>".repeat(19_000);
    const before = {
      interviews: db.prepare("SELECT * FROM interviews").all(),
      turns: db.prepare("SELECT * FROM interview_turns").all(),
    };

    const response = await post("answer", { turn_id: 1, answer: "本轮回答" });
    if (response.headers.get("content-type")?.includes("event-stream")) await response.text();

    expect(response.status).toBe(413);
    expect(boundary.chatStream).not.toHaveBeenCalled();
    expect(db.prepare("SELECT * FROM interviews").all()).toEqual(before.interviews);
    expect(db.prepare("SELECT * FROM interview_turns").all()).toEqual(before.turns);
  });
});

describe("intro regeneration and series context budgets", () => {
  const context = { params: Promise.resolve({ id: "1" }) };
  it("intro regeneration stops on a resume read failure", async () => {
    db.exec(`INSERT INTO intros (id,resume_id,jd,created_at) VALUES (1,1,'JD',''); INSERT INTO intro_versions (intro_id,kind,sentences,updated_at) VALUES (1,'30s','[{"text":"旧句子","comment":"旧点评"}]','')`);
    boundary.resumeError = new Error("SQLITE_IOERR private detail");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { POST } = await import("../../app/api/intros/[id]/regenerate/route");
      const response = await POST(req({ kind: "30s" }), context);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "服务器内部错误，请稍后重试", requestId: expect.any(String) });
      expect(boundary.chat).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it("series advance stops on a resume read failure", async () => {
    db.exec("INSERT INTO interview_series (id,resume_id,jd,created_at) VALUES (1,1,'JD','')");
    const report = JSON.stringify({ depth: 8, structure: 8, authenticity: 8, completeness: 8, jd_match: 8, overall: 8, strengths: "优点", weaknesses: "不足", suggestions: "建议" });
    db.prepare("INSERT INTO interviews (resume_id,jd,series_id,round_no,status,report,created_at) VALUES (1,'JD',1,1,'finished',?,'')").run(report);
    boundary.resumeError = new Error("SQLITE_IOERR private detail");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { POST } = await import("../../app/api/interviews/series/[id]/advance/route");
      const response = await POST(req({ from_interview_id: 1 }), context);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "服务器内部错误，请稍后重试", requestId: expect.any(String) });
      expect(boundary.chat).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it.each(["regenerate", "recomment"])("%s validates stored JD and complete generated messages", async (action) => {
    db.exec(`INSERT INTO intros (id,resume_id,jd,created_at) VALUES (1,1,'JD',''); INSERT INTO intro_versions (intro_id,kind,sentences,updated_at) VALUES (1,'30s','[{"text":"旧句子","comment":"旧点评"}]','')`);
    const post = action === "regenerate" ? (await import("../../app/api/intros/[id]/regenerate/route")).POST : (await import("../../app/api/intros/[id]/recomment/route")).POST;
    db.prepare("UPDATE intros SET jd=?").run("字".repeat(12001));
    expect((await post(req({ kind: "30s" }), context)).status).toBe(413);
    expect(boundary.chat).not.toHaveBeenCalled();
    db.exec("UPDATE intros SET jd='JD'");
    if (action === "regenerate") boundary.resume = "r".repeat(64000);
    else db.prepare("UPDATE intro_versions SET sentences=?").run(JSON.stringify(
      Array.from({ length: 60 }, () => ({ text: "<&>".repeat(250), comment: "" })),
    ));
    const before = db.prepare("SELECT * FROM intro_versions").all();
    expect((await post(req({ kind: "30s" }), context)).status).toBe(413);
    expect(boundary.chat).not.toHaveBeenCalled();
    expect(db.prepare("SELECT * FROM intro_versions").all()).toEqual(before);
  });

  it.each(["advance", "finalize"])("series %s counts stored JD and previous report content", async (action) => {
    db.exec("INSERT INTO interview_series (id,resume_id,jd,created_at) VALUES (1,1,'JD','')");
    const report = { depth: 8, structure: 8, authenticity: 8, completeness: 8, jd_match: 8, overall: 8, strengths: "优点", weaknesses: "不足", suggestions: "建议" };
    const insert = db.prepare("INSERT INTO interviews (resume_id,jd,series_id,round_no,status,report,created_at) VALUES (1,'JD',1,?,'finished',?,'')");
    for (let i = 1; i <= (action === "advance" ? 1 : 3); i++) insert.run(i, JSON.stringify(report));
    const post = action === "advance" ? (await import("../../app/api/interviews/series/[id]/advance/route")).POST : (await import("../../app/api/interviews/series/[id]/finalize/route")).POST;
    db.prepare("UPDATE interview_series SET jd=?").run("字".repeat(12001));
    expect((await post(req(action === "advance" ? { from_interview_id: 1 } : {}), context)).status).toBe(413);
    expect(boundary.chat).not.toHaveBeenCalled();
    db.exec("UPDATE interview_series SET jd='JD'");
    db.prepare("UPDATE interviews SET report=?").run(JSON.stringify({ ...report, strengths: "s".repeat(64000) }));
    expect((await post(req(action === "advance" ? { from_interview_id: 1 } : {}), context)).status).toBe(413);
    expect(boundary.chat).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status,final_report FROM interview_series").get()).toEqual({ status: "ongoing", final_report: "" });
  });
});

describe("budgeted SQL context loading", () => {
  it("rejects incomplete project context and closes the source iterator before later materials", async () => {
    db.prepare("INSERT INTO projects (id,name,summary,created_at,updated_at) VALUES (1,'预算项目',?,'','')")
      .run(JSON.stringify({ ...emptySummary(), overview: "o".repeat(500) }));
    insertRows(
      "INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,?,?, '')",
      500,
      (index) => [
        "t",
        index === 500 ? "PROJECT_MATERIAL_AFTER_BUDGET" : index === 1 ? "PROJECT_MATERIAL_1" : "x",
      ],
    );
    const trace = traceSelects("project_materials");

    try {
      const { loadProjectContext } = await import("../projects");
      await expect(loadProjectContext(1, { maxChars: 1_000 })).rejects.toThrow("完整项目档案与材料超过 1000 字符限制");
      expect(trace.prepared).toHaveLength(1);
      expect(trace.executed).toHaveLength(0);
      expect(trace.iterated).toHaveLength(1);
      expect(compactSql(trace.iterated[0]!.sql)).toMatch(
        /FROM project_materials m LEFT JOIN project_material_table_provenance p ON p\.material_id = m\.id WHERE m\.project_id = \? ORDER BY m\.id/i,
      );
      expect(trace.iterated[0]!.params).toEqual([1]);
      expect(trace.iterated[0]!.rows).toBeGreaterThan(0);
      expect(trace.iterated[0]!.rows).toBeLessThan(50);
      expect(trace.iterated[0]!.closed).toBe(true);
    } finally {
      trace.restore();
    }
  });

  it("rejects oversized project summarization after a bounded cursor read without calling the model", async () => {
    db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'总结预算项目','','')");
    insertRows(
      "INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,?,?, '')",
      500,
      (index) => [
        `总结材料 ${index}`,
        index === 500 ? "SUMMARY_MATERIAL_AFTER_BUDGET" : `SUMMARY_MATERIAL_${index}_${"s".repeat(2_000)}`,
      ],
    );
    const summaryLlm = await import("../project-summary-llm");
    const serialize = vi.spyOn(summaryLlm, "serializeProjectSummaryMaterial");

    try {
      const { POST } = await import("../../app/api/projects/[id]/summarize/route");
      const response = await POST(req({}), { params: Promise.resolve({ id: "1" }) });

      expect(response.status).toBe(413);
      expect((await response.json()).error).toContain("60000");
      expect(boundary.chatStream).not.toHaveBeenCalled();
      expect(serialize.mock.calls.length).toBeGreaterThan(0);
      expect(serialize.mock.calls.length).toBeLessThan(50);
      expect(serialize.mock.calls.some(([material]) => material.content.includes("SUMMARY_MATERIAL_AFTER_BUDGET"))).toBe(false);
    } finally {
      serialize.mockRestore();
    }
  });

  it("loads a directed bank reference through direction and id filters in one cursor batch", async () => {
    insertRows(
      "INSERT INTO bank_entries (direction,kind,question,created_at) VALUES (?,?,?, '')",
      500,
      (index) => [
        index % 2 === 1 || index === 500 ? "后端" : "前端",
        index % 3 === 0 ? "behavior" : "tech",
        index === 500 ? "BANK_AFTER_BUDGET" : `BANK_${index}_${"b".repeat(2_000)}`,
      ],
    );
    boundary.chat.mockResolvedValue('{"questions":[{"question":"生成题","kind":"tech"}]}');
    const trace = traceSelects("bank_entries");

    try {
      const { POST } = await import("../../app/api/drills/route");
      const response = await POST(req({ source: "bank", direction: "后端", count: 1 }));

      expect(response.status).toBe(201);
      const userMessage = boundary.chat.mock.calls[0]![1][1].content as string;
      const bankBlock = userMessage.match(/<question_bank>\n([\s\S]*)\n<\/question_bank>/)?.[1];
      expect(bankBlock!.length).toBeLessThanOrEqual(60_000);
      expect(bankBlock!.length).toBeGreaterThan(57_000);
      const bankRows = bankBlock!.split("\n").map(line => JSON.parse(line));
      expect(bankRows[0]).toEqual({ id: 1, kind: "八股", question: `BANK_1_${"b".repeat(2_000)}` });
      expect(bankRows.every(row => row.question === `BANK_${row.id}_${"b".repeat(2_000)}`)).toBe(true);
      expect(userMessage).not.toContain("BANK_AFTER_BUDGET");
      expect(trace.prepared).toHaveLength(1);
      expect(trace.executed).toHaveLength(1);
      expect(compactSql(trace.executed[0]!.sql)).toMatch(
        /FROM bank_entries WHERE direction = \? AND id > \? ORDER BY id LIMIT \?/i,
      );
      expect(trace.executed[0]!.params).toEqual(["后端", 0, 50]);
    } finally {
      trace.restore();
    }
  });

  it("loads an undirected bank reference with only the id cursor filter", async () => {
    insertRows(
      "INSERT INTO bank_entries (direction,kind,question,created_at) VALUES ('后端','tech',?, '')",
      500,
      (index) => [index === 500 ? "UNDIRECTED_BANK_AFTER_BUDGET" : `UNDIRECTED_BANK_${index}_${"u".repeat(2_000)}`],
    );
    boundary.chat.mockResolvedValue('{"questions":[{"question":"生成题","kind":"tech"}]}');
    const trace = traceSelects("bank_entries");

    try {
      const { POST } = await import("../../app/api/drills/route");
      const response = await POST(req({ source: "bank", jd: "岗位要求", count: 1 }));

      expect(response.status).toBe(201);
      const userMessage = boundary.chat.mock.calls[0]![1][1].content as string;
      expect(userMessage).not.toContain("UNDIRECTED_BANK_AFTER_BUDGET");
      expect(trace.prepared).toHaveLength(1);
      expect(trace.executed).toHaveLength(1);
      expect(compactSql(trace.executed[0]!.sql)).toMatch(
        /FROM bank_entries WHERE id > \? ORDER BY id LIMIT \?/i,
      );
      expect(compactSql(trace.executed[0]!.sql)).not.toContain("direction = ?");
      expect(trace.executed[0]!.params).toEqual([0, 50]);
    } finally {
      trace.restore();
    }
  });

  it.each(["参考内容", "<&>"])("保留长 JD，按转义后剩余预算选取完整题库项：%s", async (text) => {
    insertRows(
      "INSERT INTO bank_entries (direction,kind,question,created_at) VALUES ('后端','tech',?, '')",
      80,
      (index) => [`BANK_START_${index}_${text.repeat(500)}_BANK_END_${index}`],
    );
    const jd = `JD_START_${"岗位".repeat(5990)}_JD_END`;
    boundary.chat.mockResolvedValue('{"questions":[{"question":"生成题","kind":"tech"}]}');
    const { POST } = await import("../../app/api/drills/route");
    const response = await POST(req({ source: "bank", jd, count: 1 }));
    expect(response.status).toBe(201);
    const messages = boundary.chat.mock.calls[0]![1] as { content: string }[];
    expect(messages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(MAX_MODEL_INPUT_CHARS);
    expect(messages[1]!.content).toContain(jd);
    const bankBlock = messages[1]!.content.match(/<question_bank>\n([\s\S]*)\n<\/question_bank>/)![1]!;
    expect(bankBlock.length).toBeGreaterThan(30_000);
    const decodedBank = bankBlock.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    const bankRows = decodedBank.split("\n").map(line => JSON.parse(line));
    expect(bankRows.every(row => row.question === `BANK_START_${row.id}_${text.repeat(500)}_BANK_END_${row.id}`)).toBe(true);
    expect(bankBlock).not.toContain("BANK_START_80_");
    if (text === "<&>") expect(bankBlock).toContain("&lt;&amp;&gt;");
  });

  it("单条参考题超过剩余预算时跳过参考，仍依据完整 JD 出题", async () => {
    db.prepare("INSERT INTO bank_entries (direction,kind,question,created_at) VALUES ('后端','tech',?, '')").run("巨型参考".repeat(20_000));
    boundary.chat.mockResolvedValue('{"questions":[{"question":"JD 生成题","kind":"tech"}]}');
    const { POST } = await import("../../app/api/drills/route");
    expect((await POST(req({ source: "bank", jd: "后端开发", count: 1 }))).status).toBe(201);
    const message = boundary.chat.mock.calls[0]![1][1].content as string;
    expect(message).toContain("后端开发");
    expect(message).not.toContain("巨型参考");
  });

  it("必需的岗位上下文本身超限时不查询题库，也不调用模型", async () => {
    const trace = traceSelects("bank_entries");
    try {
      const { POST } = await import("../../app/api/drills/route");
      const response = await POST(req({ source: "bank", jd: "文".repeat(MAX_MODEL_INPUT_CHARS), count: 1 }));
      expect(response.status).toBe(413);
      expect(trace.executed).toHaveLength(0);
      expect(boundary.chat).not.toHaveBeenCalled();
    } finally {
      trace.restore();
    }
  });

  it("loads answered interview turns by cursor without exceeding the complete model budget", async () => {
    const report = JSON.stringify({
      depth: 4,
      structure: 8,
      authenticity: 8,
      completeness: 8,
      jd_match: 8,
      strengths: "优势",
      weaknesses: "技术深度不足",
      suggestions: "加强原理说明",
    });
    db.prepare("INSERT INTO interviews (id,resume_id,jd,report,created_at) VALUES (1,1,'后端 JD',?,'')").run(report);
    const turnIdx = (id: number) => id === 1 ? 30 : id === 2 ? 10 : id === 3 ? 20 : id + 100;
    const turnQuestion = (id: number) => `TURN_ID_${id}_${"q".repeat(10)}`;
    const turnAnswer = (id: number) => `回答_ID_${id}_${"a".repeat(1_800)}`;
    const turnComment = (id: number) => `点评_ID_${id}_${"c".repeat(100)}`;
    insertRows(
      "INSERT INTO interview_turns (interview_id,idx,kind,question,answer,comment,scores,answered_at) VALUES (1,?,?,?,?,?,?, 'now')",
      500,
      (index) => [
        turnIdx(index),
        index === 1 ? "followup" : "question",
        index === 500 ? "INTERVIEW_TURN_AFTER_BUDGET" : turnQuestion(index),
        turnAnswer(index),
        turnComment(index),
        index === 1 ? "{broken" : '{"depth":7,"structure":7,"authenticity":7,"completeness":7}',
      ],
    );
    boundary.chat.mockResolvedValue('{"questions":[{"question":"追练生成题","kind":"tech"}]}');
    const trace = traceSelects("interview_turns");

    try {
      const { POST } = await import("../../app/api/drills/route");
      const response = await POST(req({ source: "interview", interview_id: 1, count: 1 }));

      expect(response.status).toBe(201);
      const messages = boundary.chat.mock.calls[0]![1] as { content: string }[];
      const userMessage = messages[1]!.content;
      const totalChars = messages.reduce((total, message) => total + message.content.length, 0);
      expect(totalChars).toBeLessThanOrEqual(MAX_MODEL_INPUT_CHARS);
      expect(totalChars).toBeGreaterThan(60_000);
      expect(userMessage).toContain("【本场问答】");
      expect(userMessage).toContain("【问答记录】");
      for (const index of [1, 2, 3]) {
        expect(userMessage).toContain(turnQuestion(index));
        expect(userMessage).toContain(`<candidate_answer>\n${turnAnswer(index)}\n</candidate_answer>`);
        expect(userMessage).toContain(`<turn_metadata>\n${JSON.stringify({ idx: turnIdx(index), kind: index === 1 ? "followup" : "question" })}\n</turn_metadata>`);
        expect(userMessage).not.toContain(turnComment(index));
      }
      expect(userMessage).not.toContain("<model_comment>");
      const reportBlock = `<interview_report>\n${JSON.stringify({
        overall: 7.2,
        scores: { depth: 4, structure: 8, authenticity: 8, completeness: 8, jd_match: 8 },
        weaknesses: "技术深度不足", suggestions: "加强原理说明",
      })}\n</interview_report>`;
      expect(userMessage).toContain(reportBlock);
      expect(userMessage.replace(reportBlock, "")).not.toContain('"scores"');
      expect(userMessage.indexOf(turnQuestion(1))).toBeLessThan(userMessage.indexOf(turnQuestion(2)));
      expect(userMessage.indexOf(turnQuestion(2))).toBeLessThan(userMessage.indexOf(turnQuestion(3)));
      expect(userMessage).toContain("INTERVIEW_TURN_AFTER_BUDGET");
      expect(userMessage).not.toContain(turnAnswer(500));
      expect(userMessage).toContain("后续问答未提供");
      const answerReads = trace.executed.filter((item) => item.sql.includes("answered_at"));
      const questionReads = trace.executed.filter((item) => !item.sql.includes("answered_at"));
      // 出题前读取一次，提交事务中按相同预算复核一次；每次都保持原有游标批次上限。
      expect(questionReads).toHaveLength(22);
      expect(questionReads.slice(11)).toEqual(questionReads.slice(0, 11));
      expect(answerReads).toHaveLength(2);
      expect(answerReads[1]).toEqual(answerReads[0]);
      expect(compactSql(answerReads[0]!.sql)).toMatch(
        /FROM interview_turns WHERE interview_id = \? AND answered_at != '' AND id > \? ORDER BY id LIMIT \?/i,
      );
      expect(answerReads[0]!.params).toEqual([1, 0, 50]);
      expect(db.prepare("SELECT source, interview_id, focus FROM drills").get()).toEqual({
        source: "interview",
        interview_id: 1,
        focus: "技术深度",
      });
      expect(db.prepare("SELECT question, kind FROM drill_questions").get()).toEqual({
        question: "追练生成题",
        kind: "tech",
      });
    } finally {
      trace.restore();
    }
  });

  it.each([
    ["普通文本", "原答末尾：仅参与验证，尚未上线。"],
    ["需转义文本", "<&>".repeat(100)],
  ])(
    "追练完整输入恰好达到上限时仍保留全部原答：%s",
    async (_label, tail) => {
      const report = JSON.stringify({
        depth: 4, structure: 8, authenticity: 8, completeness: 8, jd_match: 8,
        strengths: "优势", weaknesses: "需进一步核实", suggestions: "练习说明验证过程",
      });
      db.prepare("INSERT INTO interviews (id,resume_id,jd,report,created_at) VALUES (1,1,'J',?,'')").run(report);
      const insert = db.prepare("INSERT INTO interview_turns (interview_id,idx,kind,question,answer,answered_at) VALUES (1,?,'question',?,?,'now')");
      insert.run(1, "如何验证方案？", "FIRST_COMPLETE_ANSWER");
      insert.run(2, "方案目前是什么状态？", `LAST_COMPLETE_ANSWER_${tail}`);
      boundary.chat.mockResolvedValue('{"questions":[{"question":"新的巩固题","kind":"tech"}]}');
      const { POST } = await import("../../app/api/drills/route");
      const body = { source: "interview", interview_id: 1, count: 1 };

      expect((await POST(req(body))).status).toBe(201);
      const initialMessages = boundary.chat.mock.calls[0]![1] as { content: string }[];
      const initialLength = initialMessages.reduce((total, message) => total + message.content.length, 0);
      db.prepare("UPDATE interviews SET jd = ? WHERE id = 1").run("J".repeat(MAX_MODEL_INPUT_CHARS - initialLength + 1));

      expect((await POST(req(body))).status).toBe(201);
      const messages = boundary.chat.mock.calls[1]![1] as { content: string }[];
      expect(messages.reduce((total, message) => total + message.content.length, 0)).toBe(MAX_MODEL_INPUT_CHARS);
      expect(messages[1]!.content).toContain("FIRST_COMPLETE_ANSWER");
      const { wrapUntrustedData } = await import("../prompt-safety");
      expect(messages[1]!.content).toContain(wrapUntrustedData("candidate_answer", `LAST_COMPLETE_ANSWER_${tail}`));
      expect(messages[1]!.content).not.toContain("后续问答未提供");
      expect(db.prepare("SELECT COUNT(*) AS count FROM drills").get()).toEqual({ count: 2 });
    },
  );

  it("只有后续游标批次确实超限时才移除末条完整原答，为范围提示腾出空间", async () => {
    db.exec("INSERT INTO interviews (id,resume_id,jd,created_at) VALUES (1,1,'','')");
    insertRows(
      "INSERT INTO interview_turns (interview_id,idx,kind,question,answer,answered_at) VALUES (1,?,'question','题目',?,'now')",
      50,
      (index) => [index, `COMPLETE_ANSWER_${index}_END`],
    );
    const { loadInterviewTurnParts, promptPartsLength } = await import("../drills-context");
    const completeParts = await loadInterviewTurnParts(1, MAX_MODEL_INPUT_CHARS);
    const exactBudget = promptPartsLength(completeParts);
    expect(await loadInterviewTurnParts(1, exactBudget)).toEqual(completeParts);
    db.prepare("INSERT INTO interview_turns (interview_id,idx,kind,question,answer,answered_at) VALUES (1,51,'question','超限题',?,'now')")
      .run("X".repeat(exactBudget));
    const trace = traceSelects("interview_turns");
    try {
      const parts = await loadInterviewTurnParts(1, exactBudget);
      const text = parts.map((part) => part.text).join("");
      expect(promptPartsLength(parts)).toBeLessThanOrEqual(exactBudget);
      for (let index = 1; index <= 49; index++) expect(text).toContain(`COMPLETE_ANSWER_${index}_END`);
      expect(text).not.toContain("COMPLETE_ANSWER_50_END");
      expect(text).not.toContain("X");
      expect(text).toContain("后续问答未提供");
      expect(trace.executed.map((item) => item.params)).toEqual([[1, 0, 50], [1, 50, 50]]);
    } finally {
      trace.restore();
    }
  });

  it("省略说明本身也计入预算，不足以容纳原答时不返回半条记录", async () => {
    db.exec("INSERT INTO interviews (id,resume_id,jd,created_at) VALUES (1,1,'',''); INSERT INTO interview_turns (interview_id,idx,kind,question,answer,answered_at) VALUES (1,1,'question','题目','PRIVATE_COMPLETE_ANSWER','now')");
    const { loadInterviewTurnParts, promptPartsLength } = await import("../drills-context");
    const omitted = await loadInterviewTurnParts(1, 100);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]).toMatchObject({ trust: "trusted", text: expect.stringContaining("后续问答未提供") });
    const noticeLength = promptPartsLength(omitted);
    for (const budget of [0, noticeLength - 1, noticeLength, 100]) {
      const parts = await loadInterviewTurnParts(1, budget);
      expect(promptPartsLength(parts)).toBeLessThanOrEqual(budget);
      expect(parts).toEqual(budget < noticeLength ? [] : omitted);
    }
  });

  it("rejects oversized fixed interview content before loading turns, calling the model, or writing a drill", async () => {
    const report = JSON.stringify({
      depth: 4,
      structure: 8,
      authenticity: 8,
      completeness: 8,
      jd_match: 8,
      strengths: "优势",
      weaknesses: "不足",
      suggestions: "建议",
    });
    db.prepare("INSERT INTO interviews (id,resume_id,jd,report,created_at) VALUES (1,1,?,?, '')")
      .run("J".repeat(MAX_MODEL_INPUT_CHARS), report);
    boundary.chat.mockResolvedValue('{"questions":[{"question":"不应生成","kind":"tech"}]}');
    const trace = traceSelects("interview_turns");

    try {
      const { POST } = await import("../../app/api/drills/route");
      const response = await POST(req({ source: "interview", interview_id: 1, count: 1 }));

      expect(response.status).toBe(413);
      expect(boundary.chat).not.toHaveBeenCalled();
      expect(trace.prepared).toHaveLength(0);
      expect(trace.executed).toHaveLength(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM drills").get()).toEqual({ count: 0 });
    } finally {
      trace.restore();
    }
  });

  it("awaits asynchronous project context before evaluating a drill answer", async () => {
    db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'异步项目','',''); INSERT INTO drills (id,source,project_id,created_at) VALUES (1,'project',1,''); INSERT INTO drill_questions (id,drill_id,idx,question) VALUES (1,1,1,'项目题')");
    const loadProjectContext = vi.fn().mockResolvedValue("ASYNC_PROJECT_CONTEXT");
    const projectContextMatches = vi.fn().mockReturnValue(true);
    vi.doMock("../projects", async (original) => ({
      ...await original<typeof import("../projects")>(),
      loadProjectContext,
      projectContextMatches,
    }));
    boundary.chat.mockResolvedValue(
      '{"depth":8,"structure":8,"authenticity":8,"completeness":8,"comment":"点评","reference":"参考"}',
    );

    try {
      const { POST } = await import("../../app/api/drills/[id]/questions/[qid]/route");
      const response = await POST(req({ answer: "候选人回答" }), {
        params: Promise.resolve({ id: "1", qid: "1" }),
      });

      expect(response.status).toBe(200);
      expect(loadProjectContext).toHaveBeenCalledWith(1);
      expect(projectContextMatches).toHaveBeenCalledWith(1, "ASYNC_PROJECT_CONTEXT");
      const userMessage = boundary.chat.mock.calls[0]![1][1].content as string;
      expect(userMessage).toContain("ASYNC_PROJECT_CONTEXT");
      expect(userMessage).not.toContain("[object Promise]");
    } finally {
      vi.doUnmock("../projects");
    }
  });
});
