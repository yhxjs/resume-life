import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptySummary } from "../summary";

const model = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("../safe-llm", async original => ({
  ...await original<typeof import("../safe-llm")>(), safeChatStream: model.stream,
}));
const prefix = "resume-life-summary-integrity-";
const params = { params: Promise.resolve({ id: "1" }) };
const ai = { ...emptySummary(), overview: "原 AI 概述" };
const edited = { ...ai, overview: "人工核实后的概述" };
const generated = { ...ai, overview: "本次新概述" };
let directory: string;
let db: DatabaseSync;
let revisionId: number;
let materialSnapshot: string;

beforeEach(async () => {
  vi.resetModules();
  model.stream.mockReset().mockResolvedValue(JSON.stringify(generated));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'原项目','',''); INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,'材料','已核实的事实','')");
  const history = await import("../project-summary-history");
  const proposal = history.prepareProjectSummaryProposal(1, ai);
  history.saveProjectSummary(1, { summary: ai, proposal: { generated: ai, acceptedKeys: ["overview"], source: "ai", materialFingerprint: proposal.materialFingerprint } });
  revisionId = history.saveProjectSummary(1, { summary: edited }).id;
  materialSnapshot = (db.prepare("SELECT material_snapshot FROM project_summary_history WHERE id=?").get(revisionId)!.material_snapshot as string);
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

const corruptions = [
  { column: "ai_baseline", value: "[]", label: "数组基线" },
  { column: "ai_baseline", value: "null", label: "null 基线" },
  { column: "ai_baseline", value: "{", label: "截断基线" },
  { column: "ai_baseline", value: '{"overview":42}', label: "非文本基线" },
  { column: "ai_baseline", value: '{"achievement:01":"错误位置"}', label: "非规范基线键" },
  { column: "material_snapshot", value: "", label: "空字符串材料快照" },
  { column: "material_snapshot", value: "{}", label: "非列表材料快照" },
  { column: "material_snapshot", value: '[{"id":1,"title":"材料"}]', label: "缺摘要材料快照" },
  { column: "material_snapshot", value: JSON.stringify([{ id: 0, title: "材料", digest: "a".repeat(64) }]), label: "非法材料 ID" },
] as const;

function corrupt(column: string, value: string) {
  if (column !== "ai_baseline" && column !== "material_snapshot" && column !== "summary") throw new Error("Invalid fixture column");
  db.prepare(`UPDATE project_summary_history SET ${column}=? WHERE id=?`).run(value, revisionId);
}
function state() {
  return ["projects", "project_materials", "project_summary_history"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
}
async function generate(mode = "full") {
  const { POST } = await import("@/app/api/projects/[id]/summarize/route");
  return POST(new Request(`http://localhost/api/projects/1/summarize?mode=${mode}`, { method: "POST" }), params);
}
async function readHistory(query = "") {
  const { GET } = await import("@/app/api/projects/[id]/summary-history/route");
  return GET(new Request(`http://localhost/api/projects/1/summary-history?${query}`), params);
}
async function patch(body: unknown) {
  const { PATCH } = await import("@/app/api/projects/[id]/route");
  return PATCH(new Request("http://localhost/api/projects/1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), params);
}

describe("项目总结历史完整性", () => {
  it.each(corruptions)("$label：两种生成模式在模型调用前拒绝，扫描来源和草稿对照同样拒绝", async ({ column, value }) => {
    corrupt(column, value);
    const before = state();
    for (const mode of ["full", "resume-only"]) {
      const response = await generate(mode);
      await response.text();
      expect(response.status).toBe(422);
      expect(response.headers.get("content-type")).toContain("application/json");
    }
    expect(model.stream).not.toHaveBeenCalled();
    const history = await import("../project-summary-history");
    expect(() => history.captureProjectSummarySource(1)).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => history.prepareProjectSummaryProposal(1, generated)).toThrow(expect.objectContaining({ status: 422 }));
    expect(state()).toEqual(before);
  });

  it.each(corruptions)("$label：手动保存原子拒绝，不抹除基线、不复制损坏内容或顺带改名", async ({ column, value }) => {
    corrupt(column, value);
    const before = state();
    const response = await patch({ name: "不应改名", summary: generated, expectedRevisionId: revisionId });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("历史") });
    expect(state()).toEqual(before);
  });

  it.each(corruptions.filter(item => item.column === "ai_baseline"))("$label：历史 API 返回可处理错误，不发布残缺成功响应", async ({ column, value }) => {
    corrupt(column, value);
    const before = state();
    const response = await readHistory();
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("历史") });
    expect(state()).toEqual(before);
  });

  it("历史正文损坏返回 422，但不影响当前档案和只读版本令牌", async () => {
    corrupt("summary", '{"overview":42}');
    const before = state();
    expect((await readHistory()).status).toBe(422);
    const { GET } = await import("@/app/api/projects/[id]/route");
    const detail = await GET(new Request("http://localhost/api/projects/1"), params);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ summary: edited, summary_revision_id: revisionId });
    expect(state()).toEqual(before);
  });

  it.each(["[]", "{"])("分页只解析本页，下一页的坏基线 %s 不阻断已保存的较新历史", async value => {
    const previousId = revisionId;
    const history = await import("../project-summary-history");
    const newer = history.saveProjectSummary(1, { summary: { ...edited, brief: "新版本" } });
    corrupt("ai_baseline", value);
    const response = await readHistory("limit=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ id: newer.id }], nextCursor: String(newer.id) });
    expect((await readHistory(`limit=1&cursor=${newer.id}`)).status).toBe(422);
    expect(history.projectSummaryRevision(1)).toBe(newer.id);
    expect(previousId).toBeLessThan(newer.id);
  });

  it("不展示的材料快照损坏不阻断历史正文查看和独立重命名", async () => {
    corrupt("material_snapshot", "{}");
    const historyBefore = db.prepare("SELECT * FROM project_summary_history ORDER BY id").all();
    expect((await readHistory()).status).toBe(200);
    expect((await patch({ name: "可独立修改" })).status).toBe(200);
    expect(db.prepare("SELECT * FROM project_summary_history ORDER BY id").all()).toEqual(historyBefore);
  });

  it.each(["ai_baseline", "material_snapshot"])("生成期间 %s 损坏时拒绝外发草稿，修复后显式重试保留人工冲突", async column => {
    model.stream.mockImplementationOnce(async () => {
      corrupt(column, column === "ai_baseline" ? "[]" : "{}");
      return JSON.stringify(generated);
    });
    const response = await generate();
    const text = await response.text();
    expect(text).toContain("event: error");
    expect(text).toContain("请修复历史数据");
    expect(text).not.toContain("event: delta");
    expect(text).not.toContain("event: done");
    corrupt("ai_baseline", JSON.stringify({ overview: ai.overview }));
    corrupt("material_snapshot", materialSnapshot);
    const retry = await generate();
    const events = await retry.text();
    expect(events).toContain('"status":"conflict"');
    expect(events).toContain("event: done");
    expect(db.prepare("SELECT summary FROM projects WHERE id=1").get()).toEqual({ summary: JSON.stringify(edited) });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 2 });
  });

  it("合法空基线、null/空材料快照以及历史空白原文保持兼容", async () => {
    for (const snapshot of [null, "[]", materialSnapshot]) {
      db.prepare("UPDATE project_summary_history SET ai_baseline='{}',material_snapshot=? WHERE id=?").run(snapshot, revisionId);
      const response = await generate();
      expect(await response.text()).toContain("event: done");
      const saved = await patch({ summary: { ...edited, brief: "  <T> &amp;\n内部  空白  " }, expectedRevisionId: revisionId });
      expect(saved.status).toBe(200);
      revisionId = (await saved.json()).revisionId;
      expect((await readHistory()).status).toBe(200);
    }
  });
});
