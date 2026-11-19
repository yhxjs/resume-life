import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptySummary } from "../summary";

const model = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("../safe-llm", async original => ({
  ...await original<typeof import("../safe-llm")>(), safeChatStream: model.stream,
}));
const prefix = "resume-life-summary-source-";
const archive = { ...emptySummary(), responsibilities: "原职责：参与联调，尚未上线" };
const revised = { ...archive, responsibilities: "更正职责：只做参数校验，联调由同事完成" };
let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  model.stream.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.prepare("INSERT INTO projects (id,name,summary,created_at,updated_at) VALUES (1,'来源项目',?,'','')").run(JSON.stringify(archive));
});
afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

function concurrentWrite(write: (writer: DatabaseSync) => void): boolean {
  const writer = new DatabaseSync(path.join(directory, "resume-life.db"));
  try {
    writer.exec("BEGIN IMMEDIATE");
    write(writer);
    writer.exec("COMMIT");
    return false;
  } catch (error) {
    if (!(error instanceof Error) || !("errcode" in error) || error.errcode !== 5) throw error;
    return true;
  } finally { writer.close(); }
}

async function generate(mode: string) {
  const { POST } = await import("@/app/api/projects/[id]/summarize/route");
  const response = await POST(new Request(`http://localhost/api/projects/1/summarize?mode=${mode}`, { method: "POST" }), { params: Promise.resolve({ id: "1" }) });
  expect(response.status).toBe(200);
  const events = await response.text();
  expect(events).not.toContain("event: error");
  expect(events).toContain("event: done");
  return JSON.parse(events.match(/event: done\ndata: ([^\n]+)/)![1]!) as ReturnType<typeof import("../project-summary-history").prepareProjectSummaryProposal>;
}

async function adopt(draft: Awaited<ReturnType<typeof generate>>) {
  const { PATCH } = await import("@/app/api/projects/[id]/route");
  return PATCH(new Request("http://localhost/api/projects/1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    summary: draft.summary, expectedRevisionId: draft.revisionId,
    proposal: { generated: draft.summary, acceptedKeys: draft.comparison.map(change => change.key), source: "ai", materialFingerprint: draft.materialFingerprint },
  }) }), { params: Promise.resolve({ id: "1" }) });
}

function userText() {
  const messages = model.stream.mock.calls[0]![3] as { parts: { text: string }[] }[];
  return messages.flatMap(message => message.parts.map(part => part.text)).join("\n");
}

describe.each(["full", "resume-only"])("材料总结 %s 的来源快照", mode => {
  beforeEach(() => {
    model.stream.mockResolvedValue(JSON.stringify(mode === "full"
      ? { ...archive, brief: "参与接口工作，尚未上线" }
      : { techStack: "", brief: "参与接口工作，尚未上线", achievements: [] }));
  });

  it("并发更正可提交，草稿绑定旧快照的职责与版本，采纳时返回冲突", async () => {
    const history = await import("../project-summary-history");
    const first = history.saveProjectSummary(1, { summary: archive });
    const projects = await import("../projects");
    const load = projects.loadProjectRow;
    let blocked: boolean | undefined;
    vi.spyOn(projects, "loadProjectRow").mockImplementationOnce((...args) => {
      const row = load(...args);
      blocked = concurrentWrite(writer => {
        writer.prepare("UPDATE projects SET summary=? WHERE id=1").run(JSON.stringify(revised));
        writer.prepare("INSERT INTO project_summary_history (project_id,summary,ai_baseline,material_snapshot,source,created_at) VALUES (1,?,'{}',NULL,'manual','later')").run(JSON.stringify(revised));
      });
      return row;
    });
    const draft = await generate(mode);
    const saved = await adopt(draft);
    const latest = db.prepare("SELECT summary FROM projects WHERE id=1").get()!;
    expect({ blocked, sourceRevision: draft.revisionId, status: saved.status, responsibilities: JSON.parse(latest.summary as string).responsibilities })
      .toEqual({ blocked: false, sourceRevision: first.id, status: 409, responsibilities: revised.responsibilities });
  });

  it("读取材料期间允许另一连接提交，模型读取原文且旧指纹不能覆盖新材料", async () => {
    const text = "仅在测试环境验证";
    db.prepare("INSERT INTO project_materials (id,project_id,title,content,created_at) VALUES (1,1,'原材料',?,'')").run(text);
    const serializer = await import("../project-summary-llm");
    const serialize = serializer.serializeProjectSummaryMaterial;
    const writes: boolean[] = [];
    vi.spyOn(serializer, "serializeProjectSummaryMaterial").mockImplementationOnce((...args) => {
      writes.push(concurrentWrite(writer => { writer.prepare("UPDATE project_materials SET content='并发替换后的正文' WHERE id=1").run(); }));
      return serialize(...args);
    });
    const draft = await generate(mode);
    expect(writes).toEqual([false]);
    expect(userText()).toContain(text);
    expect(userText()).not.toContain("并发替换后的正文");
    expect((await adopt(draft)).status).toBe(409);
  });

  it("模型等待期间释放快照锁，外部更正成功而旧草稿采纳返回409", async () => {
    const history = await import("../project-summary-history");
    history.saveProjectSummary(1, { summary: archive });
    model.stream.mockImplementationOnce(async () => {
      expect(concurrentWrite(writer => {
        writer.prepare("UPDATE projects SET summary=? WHERE id=1").run(JSON.stringify(revised));
        writer.prepare("INSERT INTO project_summary_history (project_id,summary,ai_baseline,material_snapshot,source,created_at) VALUES (1,?,'{}',NULL,'manual','later')").run(JSON.stringify(revised));
      })).toBe(false);
      return JSON.stringify(mode === "full" ? { ...archive, brief: "旧稿" } : { techStack: "", brief: "旧稿", achievements: [] });
    });
    const draft = await generate(mode);
    expect((await adopt(draft)).status).toBe(409);
    expect(JSON.parse(db.prepare("SELECT summary FROM projects WHERE id=1").get()!.summary as string)).toEqual(revised);
  });

  it("材料超限提前拒绝后也释放游标与事务，外部写入可正常继续", async () => {
    db.prepare("INSERT INTO project_materials (id,project_id,title,content,created_at) VALUES (1,1,'超限材料',?,'')").run("文".repeat(60_001));
    db.exec("INSERT INTO project_materials (id,project_id,title,content,created_at) VALUES (2,1,'后续材料','正文','')");
    db.exec("INSERT INTO project_material_table_provenance (material_id,provenance) VALUES (2,'{}')");
    const { POST } = await import("@/app/api/projects/[id]/summarize/route");
    const response = await POST(new Request(`http://localhost/api/projects/1/summarize?mode=${mode}`, { method: "POST" }), { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(413);
    expect(model.stream).not.toHaveBeenCalled();
    expect(concurrentWrite(writer => { writer.prepare("UPDATE project_materials SET content='精简后可重试' WHERE id=1").run(); })).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
    db.exec("DELETE FROM project_material_table_provenance WHERE material_id=2");
    expect(await generate(mode)).toMatchObject({ revisionId: 0 });
    expect(userText()).toContain("精简后可重试");
  });
});
