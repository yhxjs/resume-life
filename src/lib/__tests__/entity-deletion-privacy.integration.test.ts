import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-delete-privacy-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec(`
    INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'合成隐私标题','',''),(2,'其他简历','','');
    INSERT INTO interview_series (id,resume_id,jd,created_at) VALUES (1,1,'','');
    INSERT INTO interviews (id,resume_id,jd,series_id,created_at) VALUES (1,1,'',1,'');
    INSERT INTO intros (id,resume_id,created_at) VALUES (1,1,'');
    INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'合成项目','','');
    INSERT INTO drills (id,project_id,created_at) VALUES (1,1,'');
    INSERT INTO resume_templates (id,name,style,created_at,updated_at) VALUES (1,'合成模板','{}','','');
    INSERT INTO bank_entries (id,kind,question,created_at) VALUES (1,'tech','题目','');
    INSERT INTO resume_defenses (id,title,source_content,created_at) VALUES (1,'合成排雷','','');
    INSERT INTO salary_negotiations (id,target_company_tier,target_role,expected_salary,created_at) VALUES (1,'top_tech','合成岗位','','');
  `);
  for (const type of ["resume", "interview", "interview_series", "intro", "project", "drill", "template", "bank_entry", "defense", "negotiation"]) {
    db.prepare("INSERT INTO llm_call_logs (created_at,feature,entity_type,entity_id,entity_label,task,model,api_format,status,input_tokens) VALUES ('','synthetic',?,1,'合成隐私标题','evaluate','synthetic','openai_chat','ok',12)").run(type);
  }
  db.exec("INSERT INTO llm_call_logs (created_at,feature,entity_type,entity_id,entity_label,task,model,api_format,status) VALUES ('','synthetic','resume',2,'其他简历','evaluate','synthetic','openai_chat','ok')");
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-delete-privacy-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

const targets = [
  ["interview", "@/app/api/interviews/[id]/route"],
  ["interview_series", "@/app/api/interviews/series/[id]/route"],
  ["intro", "@/app/api/intros/[id]/route"],
  ["project", "@/app/api/projects/[id]/route"],
  ["drill", "@/app/api/drills/[id]/route"],
  ["template", "@/app/api/templates/[id]/route"],
  ["bank_entry", "@/app/api/bank/[id]/route"],
  ["defense", "@/app/api/tools/resume-defenses/[id]/route"],
  ["negotiation", "@/app/api/tools/salary-negotiations/[id]/route"],
] as const;
async function remove(module: string) {
  const route = await import(module);
  return route.DELETE(new Request("http://127.0.0.1/api/synthetic/1", { method: "DELETE" }), { params: Promise.resolve({ id: "1" }) });
}
function expectErased(type: string) {
  expect(db.prepare("SELECT entity_label, input_tokens FROM llm_call_logs WHERE entity_type = ? AND entity_id = 1").get(type))
    .toEqual({ entity_label: "", input_tokens: 12 });
  expect(db.prepare("SELECT entity_label FROM llm_call_logs WHERE entity_type = 'resume' AND entity_id = 2").get()).toEqual({ entity_label: "其他简历" });
}
it.each(targets)("删除 %s 清空标题但保留匿名计量", async (type, module) => {
  expect((await remove(module)).status).toBe(200);
  expectErased(type);
  if (type === "interview_series") expectErased("interview");
  if (type === "project") expectErased("drill");
});
it.each(["child-first", "parent-first"])("删除简历 %s 不留下派生标题", async (order) => {
  if (order === "child-first") {
    await remove(targets[0][1]);
    await remove(targets[2][1]);
    await remove(targets[1][1]);
  }
  expect((await import("../resumes")).deleteResume(1)).toBe(true);
  for (const type of ["resume", "interview", "interview_series", "intro"]) expectErased(type);
});
it("删除失败时标题擦除一同回滚", async () => {
  db.exec("CREATE TRIGGER block_delete BEFORE DELETE ON interviews BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await remove(targets[0][1])).status).toBe(500);
  expect(db.prepare("SELECT entity_label FROM llm_call_logs WHERE entity_type = 'interview'").get()).toEqual({ entity_label: "合成隐私标题" });
  expect(db.prepare("SELECT id FROM interviews WHERE id = 1").get()).toEqual({ id: 1 });
});

