import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptySummary } from "../summary";

const prefix = "resume-life-detail-snapshot-";
const original = { ...emptySummary(), responsibilities: "参与联调" };
const revised = { ...original, responsibilities: "更正：只做校验，联调由同事完成" };
let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'快照项目','','')");
});
afterEach(() => {
  vi.restoreAllMocks(); db?.close(); vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});
function writeOther(write: (writer: DatabaseSync) => void) {
  const writer = new DatabaseSync(path.join(directory, "resume-life.db"));
  try { writer.exec("BEGIN IMMEDIATE"); write(writer); writer.exec("COMMIT"); return false; }
  catch (error) {
    if (!(error instanceof Error) || !("errcode" in error) || error.errcode !== 5) throw error;
    return true;
  } finally { writer.close(); }
}
async function detail(query = "") {
  const { GET } = await import("@/app/api/projects/[id]/route");
  const response = await GET(new Request(`http://localhost/api/projects/1${query}`), { params: Promise.resolve({ id: "1" }) });
  expect(response.status).toBe(200);
  return response.json();
}

describe("项目详情编辑基准快照", () => {
  it("版本查询期间另一连接不能更正档案并把新版本号配给旧正文", async () => {
    const history = await import("../project-summary-history");
    const first = history.saveProjectSummary(1, { summary: original });
    const revision = history.projectSummaryRevision;
    let blocked = false;
    vi.spyOn(history, "projectSummaryRevision").mockImplementationOnce(id => {
      blocked = writeOther(writer => {
        writer.prepare("UPDATE projects SET summary=? WHERE id=1").run(JSON.stringify(revised));
        writer.prepare("INSERT INTO project_summary_history (project_id,summary,ai_baseline,material_snapshot,source,created_at) VALUES (1,?,'{}',NULL,'manual','later')").run(JSON.stringify(revised));
      });
      return revision(id);
    });
    const body = await detail();
    const { PATCH } = await import("@/app/api/projects/[id]/route");
    const saved = await PATCH(new Request("http://localhost/api/projects/1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      summary: { ...body.summary, brief: "用户只改介绍" }, expectedRevisionId: body.summary_revision_id,
    }) }), { params: Promise.resolve({ id: "1" }) });
    expect({ blocked, revision: body.summary_revision_id, status: saved.status }).toEqual({ blocked: true, revision: first.id, status: 200 });
  });

  it("材料页与档案同一快照，结束读取后另一连接立即可写", async () => {
    db.exec("INSERT INTO project_materials (id,project_id,title,content,created_at) VALUES (1,1,'原材料','原文','')");
    const materials = await import("../project-materials");
    const list = materials.listProjectMaterials;
    let blocked = false;
    vi.spyOn(materials, "listProjectMaterials").mockImplementationOnce((...args) => {
      const page = list(...args);
      blocked = writeOther(writer => { writer.exec("UPDATE projects SET name='并发新名称' WHERE id=1; DELETE FROM project_materials WHERE id=1"); });
      return page;
    });
    const body = await detail("?limit=1");
    expect({ blocked, name: body.name, count: body.materials_total }).toEqual({ blocked: true, name: "快照项目", count: 1 });
    expect(body.materials.map((item: { id: number }) => item.id)).toEqual([1]);
    expect(writeOther(writer => { writer.exec("UPDATE projects SET name='读取结束后可改名' WHERE id=1"); })).toBe(false);
  });
});
