import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_INITIAL_MODULE_KEYS } from "../modules";

let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-creation-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-creation-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

async function create() {
  const { POST } = await import("@/app/api/resumes/route");
  const response = await POST(new Request("http://localhost/api/resumes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "源简历" }),
  }));
  expect(response.status).toBe(201);
  return (await response.json()).id as number;
}
async function copy(id: number) {
  const { POST } = await import("@/app/api/resumes/[id]/copy/route");
  return POST(new Request(`http://localhost/api/resumes/${id}/copy`, { method: "POST" }), { params: Promise.resolve({ id: String(id) }) });
}
describe("简历创建和复制的领域写入", () => {
  it.each(["", "{broken", "null", "[]"])("复制损坏排版 %j 后仍须显式修复才能发布或导出", async (rawStyle) => {
    const source = await create();
    db.prepare("UPDATE resumes SET style_overrides=? WHERE id=?").run(rawStyle, source);
    const response = await copy(source);
    expect(response.status).toBe(201);
    const { id } = await response.json();
    expect(db.prepare("SELECT style_overrides FROM resumes WHERE id=?").get(id)).toEqual({ style_overrides: rawStyle });
    const { loadResume } = await import("../resumes");
    const { publishResumeVersion } = await import("../resume-versions");
    const document = loadResume(id)!;
    expect(document.resume.styleCorrupted).toBe(true);
    expect(() => publishResumeVersion(id, { name: "禁止发布" })).toThrow("排版数据损坏");
    const context = { params: Promise.resolve({ id: String(id) }) };
    for (const route of [
      await import("@/app/api/resumes/[id]/export/route"),
      await import("@/app/api/resumes/[id]/export/pdf/route"),
      await import("@/app/api/resumes/[id]/export/docx/route"),
    ]) {
      expect((await route.GET(new Request("http://localhost/export"), context)).status).toBe(422);
    }
    const { PATCH } = await import("@/app/api/resumes/[id]/route");
    const repaired = await PATCH(new Request("http://localhost/resume", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ styleOverrides: {}, styleRevision: document.resume.styleRevision, dataGeneration: document.resume.dataGeneration }),
    }), context);
    expect(repaired.status).toBe(200);
    expect(loadResume(id)!.resume.styleCorrupted).toBeUndefined();
    expect(publishResumeVersion(id, { name: "已修复" }).version).toBe(1);
  });
  it("复制空简历与新建使用同一默认六模块集合", async () => {
    const source = await create();
    db.prepare("DELETE FROM resume_modules WHERE resume_id = ?").run(source);
    const response = await copy(source);
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const rows = db.prepare("SELECT module_key FROM resume_modules WHERE resume_id = ? ORDER BY sort,id").all(id);
    expect(rows.map((row) => row.module_key)).toEqual([...DEFAULT_INITIAL_MODULE_KEYS]);
  });
  it("复制正常源时保留自定义模块、顺序和原始损坏正文", async () => {
    const source = await create();
    db.prepare("DELETE FROM resume_modules WHERE resume_id = ?").run(source);
    db.prepare("UPDATE resumes SET template = 'classic', style_overrides = '{\"entryGap\":8}' WHERE id = ?").run(source);
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,sort,content,updated_at) VALUES (?, 'mod_custom', 'custom', '自定义档案', 2, 'broken-json', '')").run(source);
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,sort,content,updated_at) VALUES (?, 'summary', 'summary', '简介', 1, '{\"text\":\"正文\"}', '')").run(source);
    const response = await copy(source);
    expect(response.status).toBe(201);
    const { id } = await response.json();
    expect(db.prepare("SELECT title,template,style_overrides FROM resumes WHERE id = ?").get(id))
      .toEqual({ title: "源简历（副本）", template: "classic", style_overrides: '{"entryGap":8}' });
    const columns = "module_key,type,label,sort,content";
    expect(db.prepare(`SELECT ${columns} FROM resume_modules WHERE resume_id = ? ORDER BY sort,id`).all(id))
      .toEqual(db.prepare(`SELECT ${columns} FROM resume_modules WHERE resume_id = ? ORDER BY sort,id`).all(source));
  });
  it.each(["create", "copy"] as const)("%s 的模块写失败时不留下半份简历", async (kind) => {
    const source = await create();
    db.exec("CREATE TRIGGER fail_creation BEFORE INSERT ON resume_modules WHEN NEW.module_key = 'work' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;");
    let response: Response;
    if (kind === "copy") response = await copy(source);
    else {
      const { POST } = await import("@/app/api/resumes/route");
      response = await POST(new Request("http://localhost/api/resumes", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "新简历" }),
      }));
    }
    expect(response.status).toBe(500);
    expect(db.prepare("SELECT COUNT(*) AS n FROM resumes").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM resume_modules").get()).toEqual({ n: 6 });
  });
});
