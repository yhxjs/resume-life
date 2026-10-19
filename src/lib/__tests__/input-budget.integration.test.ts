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
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  return { prepared, executed, restore: () => prepareSpy.mockRestore() };
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

  it("allows a JSON body at the exact request budget", async () => {
    const emptyBody = JSON.stringify({ text: "" });
    const expectedModelText = "x".repeat(60_000);
    const excludedTailMarker = "UNIQUE_TEXT_AFTER_MODEL_LIMIT";
    const textLength = MAX_JSON_REQUEST_BYTES - Buffer.byteLength(emptyBody);
    const text = `${expectedModelText}${excludedTailMarker}${"y".repeat(
      textLength - expectedModelText.length - excludedTailMarker.length,
    )}`;
    const body = JSON.stringify({ text });
    expect(Buffer.byteLength(body)).toBe(MAX_JSON_REQUEST_BYTES);
    boundary.chat.mockResolvedValue('{"title":"边界简历","summary":{"text":"有效内容"}}');
    const { POST } = await import("../../app/api/import/parse/route");

    const response = await POST(new Request("http://localhost/api/import/parse", {
      method: "POST",
      body,
    }));

    expect(response.status).toBe(200);
    expect(boundary.chat).toHaveBeenCalledOnce();
    const userMessage = boundary.chat.mock.calls[0]![1][1].content;
    expect(userMessage).toContain(expectedModelText);
    expect(userMessage).not.toContain(excludedTailMarker);
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
  it("counts the accumulated interview history, including model questions and comments", async () => {
    seed();
    db.prepare("INSERT INTO interview_turns (interview_id,idx,question,answer,comment,answered_at) VALUES (1,0,?,?,?,'now')")
      .run("Q".repeat(22000), "A".repeat(22000), "C".repeat(22000));
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
      const response = await POST(req({}), context);
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
    else db.prepare("UPDATE intro_versions SET sentences=?").run(JSON.stringify([{ text: "t".repeat(64000), comment: "" }]));
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
    expect((await post(req({}), context)).status).toBe(413);
    expect(boundary.chat).not.toHaveBeenCalled();
    db.exec("UPDATE interview_series SET jd='JD'");
    db.prepare("UPDATE interviews SET report=?").run(JSON.stringify({ ...report, strengths: "s".repeat(64000) }));
    expect((await post(req({}), context)).status).toBe(413);
    expect(boundary.chat).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status,final_report FROM interview_series").get()).toEqual({ status: "ongoing", final_report: "" });
  });
});

describe("budgeted SQL context loading", () => {
  it("loads project materials with one 50-row cursor batch after a small budget is reached", async () => {
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
      const context = await loadProjectContext(1, { maxChars: 1_000 });

      expect(context).toHaveLength(1_000);
      expect(context).toContain("【项目概述】");
      expect(context).toContain("PROJECT_MATERIAL_1");
      expect(context).not.toContain("PROJECT_MATERIAL_AFTER_BUDGET");
      expect(trace.prepared).toHaveLength(1);
      expect(trace.executed).toHaveLength(1);
      expect(compactSql(trace.executed[0]!.sql)).toMatch(
        /FROM project_materials WHERE project_id = \? AND id > \? ORDER BY id LIMIT \?/i,
      );
      expect(trace.executed[0]!.params).toEqual([1, 0, 50]);
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
    const trace = traceSelects("project_materials");

    try {
      const { POST } = await import("../../app/api/projects/[id]/summarize/route");
      const response = await POST(req({}), { params: Promise.resolve({ id: "1" }) });

      expect(response.status).toBe(413);
      expect((await response.json()).error).toContain("60000");
      expect(boundary.chatStream).not.toHaveBeenCalled();
      expect(trace.prepared).toHaveLength(2);
      expect(trace.executed).toHaveLength(1);
      expect(trace.prepared.map(compactSql)).toContainEqual(expect.stringMatching(
        /SELECT id, title, content FROM project_materials WHERE project_id = \? ORDER BY id/i,
      ));
      expect(compactSql(trace.executed[0]!.sql)).toMatch(
        /FROM project_materials WHERE project_id = \? AND id > \? ORDER BY id LIMIT \?/i,
      );
      expect(trace.executed[0]!.params).toEqual([1, 0, 50]);
    } finally {
      trace.restore();
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
      expect(bankBlock).toHaveLength(60_000);
      expect(userMessage).toContain("1|八股|BANK_1_");
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
    const turnQuestion = (id: number) => `TURN_ID_${id}_${"q".repeat(1_800)}`;
    const turnAnswer = (id: number) => `回答_ID_${id}_${"a".repeat(200)}`;
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
      expect(userMessage).toContain("【本场问答】\n【问答记录】");
      for (const index of [1, 2, 3]) {
        expect(userMessage).toContain(`<interview_question>\n${turnQuestion(index)}\n</interview_question>`);
        expect(userMessage).toContain(`<candidate_answer>\n${turnAnswer(index)}\n</candidate_answer>`);
        expect(userMessage).toContain(`<model_comment>\n${turnComment(index)}\n</model_comment>`);
      }
      expect(userMessage.indexOf(turnQuestion(1))).toBeLessThan(userMessage.indexOf(turnQuestion(2)));
      expect(userMessage.indexOf(turnQuestion(2))).toBeLessThan(userMessage.indexOf(turnQuestion(3)));
      expect(userMessage).not.toContain("INTERVIEW_TURN_AFTER_BUDGET");
      expect(trace.prepared).toHaveLength(1);
      expect(trace.executed).toHaveLength(1);
      expect(compactSql(trace.executed[0]!.sql)).toMatch(
        /FROM interview_turns WHERE interview_id = \? AND answered_at != '' AND id > \? ORDER BY id LIMIT \?/i,
      );
      expect(trace.executed[0]!.params).toEqual([1, 0, 50]);
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
    vi.doMock("../projects", async (original) => ({
      ...await original<typeof import("../projects")>(),
      loadProjectContext,
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
      const userMessage = boundary.chat.mock.calls[0]![1][1].content as string;
      expect(userMessage).toContain("ASYNC_PROJECT_CONTEXT");
      expect(userMessage).not.toContain("[object Promise]");
    } finally {
      vi.doUnmock("../projects");
    }
  });
});
