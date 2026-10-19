import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptySummary } from "../summary";

const model = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("../safe-llm", async (original) => ({
  ...await original<typeof import("../safe-llm")>(),
  safeChatStream: model.stream,
}));

let directory: string;
let db: DatabaseSync;
const params = { params: Promise.resolve({ id: "1" }) };
const projectRequest = (body: unknown) => new Request("http://localhost/api/projects/1", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

it.each(["first oversized", "exact budget plus newer material"])("总结拒绝不完整材料输入：%s", async (scenario) => {
  const header = "===== 材料：材料 =====\n";
  db.prepare("UPDATE project_materials SET content = ? WHERE project_id = 1").run("a".repeat(60_000 - header.length + (scenario === "first oversized" ? 1 : 0)));
  if (scenario === "exact budget plus newer material") {
    db.exec("INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,'新增成果','NEW_MATERIAL_SENTINEL','')");
  }
  model.stream.mockResolvedValue(JSON.stringify({ ...emptySummary(), overview: "不应生成" }));
  const summarize = await import("@/app/api/projects/[id]/summarize/route");
  const response = await summarize.POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), params);
  expect(response.status).toBe(413);
  expect((await response.json()).error).toContain("材料");
  expect(model.stream).not.toHaveBeenCalled();
  expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
});

it("恰好完整占满总结预算的材料全部传入模型", async () => {
  const header = "===== 材料：材料 =====\n";
  const content = "a".repeat(60_000 - header.length);
  db.prepare("UPDATE project_materials SET content = ? WHERE project_id = 1").run(content);
  model.stream.mockResolvedValue(JSON.stringify({ ...emptySummary(), overview: "完整总结" }));
  const summarize = await import("@/app/api/projects/[id]/summarize/route");
  const response = await summarize.POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), params);
  expect(response.status).toBe(200);
  await response.text();
  expect(model.stream.mock.calls[0]?.[3][0].parts).toContainEqual({ trust: "untrusted", tag: "project_materials", text: header + content });
});

beforeEach(async () => {
  vi.resetModules();
  model.stream.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-summary-routes-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'项目','',''); INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,'材料','技术事实','')");
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-summary-routes-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("project summary routes", () => {
  it("returns 413 and rolls back the combined name write for an oversized history snapshot", async () => {
    const insert = db.prepare("INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,?,'正文','')");
    for (let i = 0; i < 5; i++) insert.run("T".repeat(450_000));
    const summary = { ...emptySummary(), overview: "不能保存" };
    const history = await import("../project-summary-history");
    const materialFingerprint = history.prepareProjectSummaryProposal(1, summary).materialFingerprint;
    const before = db.prepare("SELECT * FROM projects WHERE id = 1").get();
    const response = await (await import("@/app/api/projects/[id]/route")).PATCH(projectRequest({
      name: "不能改名", summary, expectedRevisionId: 0,
      proposal: { generated: summary, acceptedKeys: ["overview"], source: "repo", materialFingerprint },
    }), params);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "项目总结历史内容过大，请精简总结或材料标题后重试" });
    expect(db.prepare("SELECT * FROM projects WHERE id = 1").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
  });

  it.each(["json", "multipart"])("rejects an oversized material title on creation (%s)", async (format) => {
    const title = "中".repeat(201);
    const form = new FormData();
    form.set("title", title);
    form.set("file", new Blob(["正文"], { type: "text/plain" }), "material.txt");
    const response = await (await import("@/app/api/projects/[id]/materials/route")).POST(new Request("http://localhost/api/projects/1/materials", {
      method: "POST",
      body: format === "json" ? JSON.stringify({ title, content: "正文" }) : form,
      headers: format === "json" ? { "Content-Type": "application/json" } : undefined,
    }), params);
    expect(response.status).toBe(413);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_materials").get()).toEqual({ count: 1 });
  });

  it("rejects an oversized material title on edit without changing the material", async () => {
    const route = await import("@/app/api/projects/[id]/materials/[mid]/route");
    const context = { params: Promise.resolve({ id: "1", mid: "1" }) };
    const before = db.prepare("SELECT * FROM project_materials WHERE id = 1").get();
    const detail = await route.GET(new Request("http://localhost/api/projects/1/materials/1"), context);
    const { revision } = await detail.json();
    const response = await route.PATCH(new Request("http://localhost/api/projects/1/materials/1", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "T".repeat(201), content: "不应保存", expectedRevision: revision }),
    }), context);
    expect(response.status).toBe(413);
    expect(db.prepare("SELECT * FROM project_materials WHERE id = 1").get()).toEqual(before);
  });

  it.each([
    { overview: 123 }, { achievements: [{}] }, { achievements: "错误类型" },
    { unknown: "未知字段" }, null, [], "错误结构",
  ].map((summary) => ({ summary })))("rejects invalid summary $summary without changing the project or history", async ({ summary }) => {
    const route = await import("@/app/api/projects/[id]/route");
    const saved = await route.PATCH(projectRequest({ summary: { ...emptySummary(), overview: "保留原总结" }, expectedRevisionId: 0 }), params);
    expect(saved.status).toBe(200);
    const revisionId = (await saved.json()).revisionId;
    const before = db.prepare("SELECT * FROM projects WHERE id = 1").get();
    const count = db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get();
    const response = await route.PATCH(projectRequest({ summary, expectedRevisionId: revisionId, name: "也不能改名" }), params);
    expect(response.status).toBe(400);
    expect(db.prepare("SELECT * FROM projects WHERE id = 1").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual(count);
  });

  it("accepts deliberate empty fields and name-only updates", async () => {
    const route = await import("@/app/api/projects/[id]/route");
    const first = await route.PATCH(projectRequest({ summary: { ...emptySummary(), overview: "待清空", achievements: ["成果"] }, expectedRevisionId: 0 }), params);
    expect(first.status).toBe(200);
    const saved = await route.PATCH(projectRequest({ summary: emptySummary(), expectedRevisionId: (await first.json()).revisionId }), params);
    expect(saved.status).toBe(200);
    expect(JSON.parse((db.prepare("SELECT summary FROM projects WHERE id = 1").get() as { summary: string }).summary)).toEqual(emptySummary());
    const count = db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get();
    expect((await route.PATCH(projectRequest({ name: "新名称" }), params)).status).toBe(200);
    expect(db.prepare("SELECT name FROM projects WHERE id = 1").get()).toEqual({ name: "新名称" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual(count);
  });

  it("rejects a stale material editor without overwriting the newer content", async () => {
    const materialRoute = await import("@/app/api/projects/[id]/materials/[mid]/route");
    const detail = await materialRoute.GET(new Request("http://localhost/api/projects/1/materials/1"), { params: Promise.resolve({ id: "1", mid: "1" }) });
    const snapshot = await detail.json() as { revision: string; content: string; title: string };
    const first = await materialRoute.PATCH(new Request("http://localhost/api/projects/1/materials/1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "新标题", content: "新正文", expectedRevision: snapshot.revision }) }), { params: Promise.resolve({ id: "1", mid: "1" }) });
    expect(first.status).toBe(200);
    const stale = await materialRoute.PATCH(new Request("http://localhost/api/projects/1/materials/1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: snapshot.title, content: "旧标签页正文", expectedRevision: snapshot.revision }) }), { params: Promise.resolve({ id: "1", mid: "1" }) });
    expect(stale.status).toBe(409);
    expect((db.prepare("SELECT title, content FROM project_materials WHERE id = 1").get())).toEqual({ title: "新标题", content: "新正文" });
  });

  it("rolls back summary history when the combined project name write fails", async () => {
    db.exec("CREATE TRIGGER block_project_name BEFORE UPDATE OF name ON projects BEGIN SELECT RAISE(ABORT, 'name blocked'); END;");
    const before = db.prepare("SELECT name, summary, summary_updated_at, updated_at FROM projects WHERE id = 1").get();
    const response = await (await import("@/app/api/projects/[id]/route")).PATCH(projectRequest({ summary: { ...emptySummary(), overview: "不应保存" }, expectedRevisionId: 0, name: "新名称" }), params);
    expect(response.status).toBe(500);
    expect(db.prepare("SELECT name, summary, summary_updated_at, updated_at FROM projects WHERE id = 1").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history WHERE project_id = 1").get()).toEqual({ count: 0 });
  });

  it("returns a comparison in regeneration SSE and preserves corrected text through selective adoption", async () => {
    const route = await import("@/app/api/projects/[id]/route");
    const ai = { ...emptySummary(), overview: "AI 原稿", architecture: "旧架构" };
    const history = await import("../project-summary-history");
    const firstFingerprint = history.prepareProjectSummaryProposal(1, ai).materialFingerprint;
    const first = await route.PATCH(projectRequest({ summary: ai, expectedRevisionId: 0, proposal: { generated: ai, acceptedKeys: ["overview", "architecture"], source: "ai", materialFingerprint: firstFingerprint } }), params);
    expect(first.status).toBe(200);
    const firstId = (await first.json()).revisionId as number;
    const manual = await route.PATCH(projectRequest({ summary: { ...ai, overview: "用户校正" }, expectedRevisionId: firstId }), params);
    expect(manual.status).toBe(200);
    const secondId = (await manual.json()).revisionId as number;

    model.stream.mockResolvedValue(JSON.stringify({ ...ai, overview: "AI 新稿", architecture: "新架构" }));
    const summarize = await import("@/app/api/projects/[id]/summarize/route");
    const response = await summarize.POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), params);
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"status":"conflict"');
    expect(stream).toContain('"status":"changed"');
    expect(stream).toContain(`"revisionId":${secondId}`);

    const adopted = await route.PATCH(projectRequest({
      summary: { ...ai, overview: "用户校正", architecture: "新架构" },
      expectedRevisionId: secondId,
      proposal: { generated: { ...ai, overview: "AI 新稿", architecture: "新架构" }, acceptedKeys: ["architecture"], source: "ai", materialFingerprint: firstFingerprint },
    }), params);
    expect(adopted.status).toBe(200);
    const detail = await route.GET(new Request("http://localhost/api/projects/1"), params);
    expect(await detail.json()).toMatchObject({ summary: { overview: "用户校正", architecture: "新架构" }, summary_revision_id: (await adopted.json()).revisionId });
  });

  it("rejects stale and invalid proposal writes, and paginates immutable history", async () => {
    const route = await import("@/app/api/projects/[id]/route");
    const summary = { ...emptySummary(), overview: "第一版" };
    const first = await route.PATCH(projectRequest({ summary, expectedRevisionId: 0 }), params);
    expect(first.status).toBe(200);
    const firstId = (await first.json()).revisionId as number;
    expect((await route.PATCH(projectRequest({ summary, expectedRevisionId: 0 }), params)).status).toBe(409);
    expect((await route.PATCH(projectRequest({ summary, expectedRevisionId: firstId, proposal: { generated: summary, acceptedKeys: ["bogus"], source: "ai", materialFingerprint: "0".repeat(64) } }), params)).status).toBe(400);
    const second = await route.PATCH(projectRequest({ summary: { ...summary, overview: "第二版" }, expectedRevisionId: firstId }), params);
    expect(second.status).toBe(200);

    const history = await import("@/app/api/projects/[id]/summary-history/route");
    const page = await history.GET(new Request("http://localhost/api/projects/1/summary-history?limit=1"), params);
    expect(page.status).toBe(200);
    const body = await page.json() as { items: Array<{ summary: { overview: string } }>; nextCursor: string };
    expect(body.items[0]?.summary.overview).toBe("第二版");
    const older = await history.GET(new Request(`http://localhost/api/projects/1/summary-history?limit=1&cursor=${body.nextCursor}`), params);
    expect((await older.json()).items[0].summary.overview).toBe("第一版");
    expect((await history.GET(new Request("http://localhost/api/projects/1/summary-history?cursor=bad"), params)).status).toBe(400);
  });

  it("rejects a proposal when materials change after generation", async () => {
    const route = await import("@/app/api/projects/[id]/route");
    const summarize = await import("@/app/api/projects/[id]/summarize/route");
    const generated = { ...emptySummary(), overview: "AI 原稿" };
    model.stream.mockResolvedValue(JSON.stringify(generated));
    const response = await summarize.POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), params);
    const stream = await response.text();
    const done = JSON.parse(stream.match(/event: done\ndata: ([^\n]+)/)?.[1] ?? "{}") as { materialFingerprint?: string };
    expect(done.materialFingerprint).toMatch(/^[a-f0-9]{64}$/);
    db.exec("INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,'后加材料','尚未总结','')");
    const saved = await route.PATCH(projectRequest({
      summary: generated,
      expectedRevisionId: 0,
      proposal: { generated, acceptedKeys: ["overview"], source: "ai", materialFingerprint: done.materialFingerprint },
    }), params);
    expect(saved.status).toBe(409);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
  });

  it("keeps the generation-start revision when another save happens during summarization", async () => {
    const route = await import("@/app/api/projects/[id]/route");
    const summarize = await import("@/app/api/projects/[id]/summarize/route");
    const generated = { ...emptySummary(), overview: "AI 新稿" };
    model.stream.mockImplementation(async () => {
      const concurrent = await route.PATCH(projectRequest({ summary: { ...emptySummary(), overview: "另一处保存" }, expectedRevisionId: 0 }), params);
      expect(concurrent.status).toBe(200);
      return JSON.stringify(generated);
    });
    const response = await summarize.POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), params);
    const stream = await response.text();
    const done = JSON.parse(stream.match(/event: done\ndata: ([^\n]+)/)?.[1] ?? "{}") as { revisionId: number; materialFingerprint: string };
    expect(done.revisionId).toBe(0);
    const saved = await route.PATCH(projectRequest({
      summary: generated,
      expectedRevisionId: done.revisionId,
      proposal: { generated, acceptedKeys: ["overview"], source: "ai", materialFingerprint: done.materialFingerprint },
    }), params);
    expect(saved.status).toBe(409);
  });
});
