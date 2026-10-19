import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

const model = vi.hoisted(() => ({ chat: vi.fn(), chatStream: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
let directory: string;
let db: DatabaseSync;
const context = { params: Promise.resolve({ id: "1", tid: "1" }) };
const introContext = { params: Promise.resolve({ id: "1", kind: "30s" }) };
const request = (body: unknown, method = "POST") => new Request("http://127.0.0.1/api/audit", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset().mockResolvedValue('{"reference":"New reference"}');
  model.chatStream.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-audit-fixes-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(directory, "data"));
  db = (await import("@/lib/db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'Synthetic','',''); INSERT INTO interviews (id,resume_id,jd,created_at) VALUES (1,1,'Synthetic JD',''); INSERT INTO interview_turns (id,interview_id,idx,question,reference) VALUES (1,1,1,'Original question','Saved reference'); INSERT INTO intros (id,resume_id,jd,created_at) VALUES (1,1,'Synthetic JD','')");
  db.prepare("INSERT INTO intro_versions (intro_id,kind,sentences,updated_at) VALUES (1,'30s',?,'original-revision')")
    .run(JSON.stringify([{ text: "A", comment: "" }, { text: "B", comment: "" }]));
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-audit-fixes-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

async function introVersion() {
  const { GET } = await import("@/app/api/intros/[id]/route");
  const response = await GET(new Request("http://localhost/api/intros/1"), context);
  const data = await response.json() as { versions: { kind: string; revision: string; sentences: { text: string; comment: string }[] }[] };
  return data.versions[0]!;
}
function storedReference() {
  return (db.prepare("SELECT reference FROM interview_turns WHERE id=1").get() as { reference: string }).reference;
}
async function pausedReference() {
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<string>();
  model.chat.mockImplementationOnce(() => { entered.resolve(); return result.promise; });
  const { POST } = await import("@/app/api/interviews/[id]/turns/[tid]/reference/route");
  const pending = POST(request({}), context);
  await entered.promise;
  return { pending, release: () => result.resolve('{"reference":"Old task result"}') };
}
async function restoredBackup() {
  db.prepare("UPDATE interview_turns SET question='Restored question',reference='Restored reference' WHERE id=1").run();
  const { POST: exportBackup } = await import("@/app/api/backup/export/route");
  const exported = await exportBackup(request({ password: "audit synthetic password", confirmation: "audit synthetic password" }));
  expect(exported.status).toBe(200);
  const bytes = await exported.arrayBuffer();
  db.prepare("UPDATE interview_turns SET question='Original question',reference='Saved reference' WHERE id=1").run();
  return async () => {
    const { encodeBackupPasswordHeader } = await import("@/lib/backup-container");
    const { POST } = await import("@/app/api/backup/restore/route");
    const response = await POST(new Request("http://localhost/api/backup/restore", {
      method: "POST", headers: { "X-Resume-Life-Backup-Password": encodeBackupPasswordHeader("audit synthetic password") }, body: bytes,
    }));
    expect(response.status).toBe(200);
  };
}

describe("audit fixes: introduction revisions", () => {
  it("rejects the second tab's stale snapshot and keeps the first tab's saved sentence", async () => {
    const base = await introVersion();
    const { PATCH } = await import("@/app/api/intros/[id]/versions/[kind]/route");
    const first = await PATCH(request({ baseRevision: base.revision, sentences: [{ text: "Edited A", comment: "" }, base.sentences[1]] }, "PATCH"), introContext);
    expect(first.status).toBe(200);
    const second = await PATCH(request({ baseRevision: base.revision, sentences: [base.sentences[0], { text: "Edited B", comment: "" }] }, "PATCH"), introContext);
    expect(second.status).toBe(409);
    expect((await introVersion()).sentences[0]!.text).toBe("Edited A");
  });
  it("requires a revision rather than accepting unconditional overwrites", async () => {
    const { PATCH } = await import("@/app/api/intros/[id]/versions/[kind]/route");
    expect((await PATCH(request({ sentences: [{ text: "Unsafe", comment: "" }] }, "PATCH"), introContext)).status).toBe(400);
  });
  it("returns a new revision after save and accepts that revision for the next save", async () => {
    const base = await introVersion();
    const { PATCH } = await import("@/app/api/intros/[id]/versions/[kind]/route");
    const response = await PATCH(request({ baseRevision: base.revision, sentences: [{ text: "Edited", comment: "" }] }, "PATCH"), introContext);
    const saved = await response.json() as { revision: string };
    expect(saved.revision).toEqual(expect.any(String));
    expect(saved.revision).not.toBe(base.revision);
    expect((await PATCH(request({ baseRevision: saved.revision, sentences: [{ text: "Next", comment: "" }] }, "PATCH"), introContext)).status).toBe(200);
  });
  it("invalidates an old client revision across restore even when visible sentences match", async () => {
    const base = await introVersion();
    db.prepare("INSERT INTO runtime_state (id,data_generation) VALUES (1,'changed') ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation").run();
    const { PATCH } = await import("@/app/api/intros/[id]/versions/[kind]/route");
    expect((await PATCH(request({ baseRevision: base.revision, sentences: [{ text: "Stale", comment: "" }] }, "PATCH"), introContext)).status).toBe(409);
  });
});

describe("audit fixes: reference protocol and identity", () => {
  it.each(['{"reference":42}', '{"reference":[]}', '{"reference":" "}', '{}', 'not JSON'])('rejects invalid model output %s without changing saved data', async (raw) => {
    model.chat.mockResolvedValueOnce(raw);
    const { POST } = await import("@/app/api/interviews/[id]/turns/[tid]/reference/route");
    expect((await POST(request({}), context)).status).toBe(502);
    expect(storedReference()).toBe("Saved reference");
  });
  it("saves a valid reference string", async () => {
    const { POST } = await import("@/app/api/interviews/[id]/turns/[tid]/reference/route");
    expect((await POST(request({}), context)).status).toBe(200);
    expect(storedReference()).toBe("New reference");
  });
  it("rejects a request whose body is still arriving when data is restored", async () => {
    db.prepare("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'Original','','')").run();
    const entered = Promise.withResolvers<void>();
    let bodyController: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { bodyController = controller; },
      pull() { entered.resolve(); },
    }, { highWaterMark: 0 });
    const { PATCH } = await import("@/app/api/projects/[id]/route");
    const pending = PATCH(new Request("http://localhost/api/projects/1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body, duplex: "half",
    } as RequestInit), context);
    await entered.promise;
    db.prepare("INSERT INTO runtime_state (id,data_generation) VALUES (1,'body-restored')").run();
    db.prepare("UPDATE projects SET name='Restored' WHERE id=1").run();
    bodyController!.enqueue(new TextEncoder().encode('{"name":"Old request"}'));
    bodyController!.close();
    expect((await pending).status).toBe(409);
    expect(db.prepare("SELECT name FROM projects WHERE id=1").get()).toEqual({ name: "Restored" });
  });
  it.each(["reverse", "retry"] as const)("rejects %s results when restore commits while acquiring the write lock", async (kind) => {
    const locked = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<void>();
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(workerData);
      database.exec('BEGIN IMMEDIATE');
      database.prepare("INSERT INTO runtime_state (id,data_generation) VALUES (1,'lock-restored')").run();
      database.prepare("UPDATE interviews SET jd='Restored JD' WHERE id=1").run();
      database.prepare("UPDATE interview_turns SET question='Restored question', reference='' WHERE id=1").run();
      parentPort.postMessage('locked');
      parentPort.once('message', () => setTimeout(() => {
        database.exec('COMMIT'); database.close(); parentPort.close();
      }, 100));
    `, { eval: true, workerData: path.join(directory, "data", "resume-life.db") });
    worker.once("message", () => locked.resolve());
    worker.once("error", (error) => { locked.reject(error); exited.reject(error); });
    worker.once("exit", () => exited.resolve());
    try {
      model.chat.mockImplementationOnce(async () => {
        await locked.promise;
        worker.postMessage("release");
        return kind === "reverse"
          ? '{"answer":"Old model answer","evaluation":{"score":8,"level":"优秀","insight":"Old insight","feedback":"Old feedback","suggestions":"Old suggestions"}}'
          : '{"depth":7,"structure":7,"authenticity":7,"completeness":7,"comment":"Old grade","reference":"Old reference"}';
      });
      const { POST } = kind === "reverse"
        ? await import("@/app/api/interviews/[id]/reverse/route")
        : await import("@/app/api/interviews/[id]/turns/[tid]/retry/route");
      expect((await POST(request(kind === "reverse" ? { question: "Old question" } : { answer: "Old answer" }), context)).status).toBe(409);
      expect(db.prepare("SELECT jd,reverse_interview FROM interviews WHERE id=1").get()).toEqual({ jd: "Restored JD", reverse_interview: "" });
      expect(db.prepare("SELECT question,retries,reference FROM interview_turns WHERE id=1").get()).toEqual({ question: "Restored question", retries: "[]", reference: "" });
      await exited.promise;
    } finally {
      await worker.terminate();
    }
  });
  it("rejects an old model result after a complete backup restore reused the turn ID", async () => {
    const restore = await restoredBackup();
    const paused = await pausedReference();
    await restore();
    paused.release();
    expect((await paused.pending).status).toBe(409);
    expect(storedReference()).toBe("Restored reference");
  });
  it("rejects a changed question during the model wait", async () => {
    const paused = await pausedReference();
    db.prepare("UPDATE interview_turns SET question='Changed question' WHERE id=1").run();
    paused.release();
    expect((await paused.pending).status).toBe(409);
    expect(storedReference()).toBe("Saved reference");
  });
  it("returns 404 if the turn was deleted during the model wait", async () => {
    const paused = await pausedReference();
    db.prepare("DELETE FROM interview_turns WHERE id=1").run();
    paused.release();
    expect((await paused.pending).status).toBe(404);
  });
});

describe("audit fixes: request generation boundary", () => {
  it("reports a restore conflict even when a stream producer catches the model error", async () => {
    const { getDb } = await import("@/lib/db");
    const { withRouteErrorHandling } = await import("@/lib/api-route");
    const { safeChatStream, LLM_FEATURES } = await import("@/lib/safe-llm");
    const { createSseResponse } = await import("@/lib/sse");
    const entered = Promise.withResolvers<void>();
    const result = Promise.withResolvers<string>();
    model.chatStream.mockImplementationOnce(() => { entered.resolve(); return result.promise; });
    const route = withRouteErrorHandling("POST /api/audit/stream", () => {
      getDb();
      return createSseResponse(async (emitter) => {
        try {
          await safeChatStream("question", { feature: LLM_FEATURES.introGenerate }, "synthetic", []);
          emitter.sendDone({ ok: true });
        } catch {
          emitter.sendError("上游模型失败");
        }
      });
    });
    const response = await route(request({}));
    await entered.promise;
    db.prepare("INSERT INTO runtime_state (id,data_generation) VALUES (1,'caught-stream-restored')").run();
    result.resolve("old task");
    expect(await response.text()).toContain("数据已恢复");
  });
  it("rejects a non-model task committing after restore and leaves the new row untouched", async () => {
    const { getDb, inTransaction } = await import("@/lib/db");
    const { withRouteErrorHandling } = await import("@/lib/api-route");
    const entered = Promise.withResolvers<void>();
    const wait = Promise.withResolvers<void>();
    const route = withRouteErrorHandling("POST /api/audit/parser", async () => {
      const captured = getDb();
      entered.resolve();
      await wait.promise;
      inTransaction(() => captured.prepare("UPDATE interviews SET jd='Old parsed data' WHERE id=1").run());
      return Response.json({ ok: true });
    });
    const pending = route(request({}));
    await entered.promise;
    db.prepare("INSERT INTO runtime_state (id,data_generation) VALUES (1,'new-generation') ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation").run();
    wait.resolve();
    expect((await pending).status).toBe(409);
    expect(db.prepare("SELECT jd FROM interviews WHERE id=1").get()).toEqual({ jd: "Synthetic JD" });
  });
  it("rejects a streamed answer after restore although its HTTP response has already started", async () => {
    const entered = Promise.withResolvers<void>();
    const result = Promise.withResolvers<string>();
    model.chatStream.mockImplementationOnce(() => { entered.resolve(); return result.promise; });
    const { POST } = await import("@/app/api/interviews/[id]/answer/route");
    const response = await POST(request({ turn_id: 1, answer: "Synthetic answer" }), context);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await entered.promise;
    db.prepare("INSERT INTO runtime_state (id,data_generation) VALUES (1,'stream-restored') ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation").run();
    result.resolve(JSON.stringify({ comment: "Old grade", next_kind: "question", next_question: "Old next", depth: 7, structure: 7, authenticity: 7, completeness: 7 }));
    const body = await response.text();
    expect(body).toContain("event: error");
    expect(body).toContain("数据已恢复");
    expect(body).not.toContain("event: done");
    expect(db.prepare("SELECT answer FROM interview_turns WHERE id=1").get()).toEqual({ answer: "" });
  });
});
