import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "resume-life-application-related-ids-";
const fields = ["resume_id", "resume_version_id", "interview_id", "interview_series_id"] as const;
const valid = { resume_id: 1, resume_version_id: 1, interview_id: 1, interview_series_id: 1 };
let directory: string;
let db: DatabaseSync;
let applicationId: number;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'目标简历','',''),(2,'另一份简历','','')");
  const { publishResumeVersion } = await import("../resume-versions");
  publishResumeVersion(1, { name: "目标发布版" });
  publishResumeVersion(2, { name: "另一份发布版" });
  db.exec(`
    INSERT INTO interview_series (id,resume_id,jd,created_at) VALUES (1,1,'原 JD',''),(2,2,'另一份 JD','');
    INSERT INTO interviews (id,resume_id,jd,created_at) VALUES (1,1,'原 JD',''),(2,2,'另一份 JD','');
    INSERT INTO interview_turns (id,interview_id,idx,question) VALUES (1,1,1,'原题'),(2,2,1,'另一题');
    INSERT INTO notebook_entries (id,source,source_id,question,created_at,updated_at) VALUES (1,'interview',1,'原题','',''),(2,'interview',2,'另一题','','');
    INSERT INTO review_cards (notebook_id,next_review_date,created_at) VALUES (1,'2026-10-29',''),(2,'2026-10-30','');
  `);
  const { createApplication } = await import("../applications");
  applicationId = createApplication({ company: "原公司", role: "原岗位", ...valid }).id;
  createApplication({ company: "另一公司", role: "另一岗位", resume_id: 2, resume_version_id: 2, interview_id: 2, interview_series_id: 2 });
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

function stored() {
  return Object.fromEntries([
    "applications", "application_stage_history", "application_preparation_resources", "resumes", "resume_versions",
    "interviews", "interview_series", "interview_turns", "notebook_entries", "review_cards", "review_attempts", "llm_call_logs",
  ].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

function request(method: string, body: unknown) {
  return new Request("http://localhost/api/applications", {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
const context = () => ({ params: Promise.resolve({ id: String(applicationId) }) });

describe.each(["HTTP", "domain"] as const)("投递关联 ID %s 边界", entry => {
  describe.each(["create", "update"] as const)("%s", action => {
    it.each(fields)("%s 不隐式转换、不写入其他关联，失败时完整保留存档", async field => {
      const domain = await import("../applications");
      const create = await import("@/app/api/applications/route");
      const update = await import("@/app/api/applications/[id]/route");
      const before = stored();
      const invalid: unknown[] = [true, false, [1], [[1]], [], {}, "1", "1e0", " ", "12a", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];
      if (entry === "domain") invalid.push(NaN, Infinity);
      for (const value of invalid) {
        const label = `${field}=${JSON.stringify(value)} (${typeof value})`;
        const input = { company: "不得新建", role: "不得改写", ...valid, [field]: value, stage: "applied" as const };
        if (entry === "HTTP") {
          const response = action === "create"
            ? await create.POST(request("POST", input))
            : await update.PATCH(request("PATCH", input), context());
          expect(response.status, label).toBe(400);
          expect(await response.json(), label).toEqual({ error: "关联记录 ID 无效" });
          expect(response.headers.get("cache-control"), label).toContain("no-store");
        } else {
          expect(() => action === "create" ? domain.createApplication(input) : domain.updateApplication(applicationId, input), label)
            .toThrow(domain.ApplicationInputError);
        }
        expect(stored(), label).toEqual(before);
      }
    });
  });
});

it.each([null, ""].map(value => ({ value, label: JSON.stringify(value) })))("POST/PATCH 继续支持 $label 清空关联，其他记录与独立收藏保留", async ({ value }) => {
  const create = await import("@/app/api/applications/route");
  const update = await import("@/app/api/applications/[id]/route");
  const before = stored();
  const cleared = Object.fromEntries(fields.map(field => [field, value]));
  const created = await create.POST(request("POST", { company: "无关联", role: "新岗位", ...cleared }));
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ resume_id: null, resume_version_id: null, interview_id: null, interview_series_id: null });
  const updated = await update.PATCH(request("PATCH", { ...cleared, notes: "有效备注" }), context());
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ resume_id: null, resume_version_id: null, interview_id: null, interview_series_id: null, notes: "有效备注" });
  const after = stored();
  for (const table of Object.keys(before).filter(table => !["applications", "application_stage_history"].includes(table))) {
    expect(after[table]).toEqual(before[table]);
  }
  expect(db.prepare("SELECT * FROM applications WHERE id=2").get()).toEqual(before.applications![1]);
});

it("部分更新保留固定旧发布版与面试关联，正常数字仍可重新绑定且只关联目标收藏", async () => {
  const domain = await import("../applications");
  const versions = await import("../resume-versions");
  const later = versions.publishResumeVersion(1, { name: "后来发布，不能替换原版" });
  const updated = await (await import("@/app/api/applications/[id]/route")).PATCH(request("PATCH", { notes: "只改备注" }), context());
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ ...valid, notes: "只改备注" });
  const original = domain.getApplicationById(applicationId)!;
  const second = domain.getApplicationById(2)!;
  const rebound = domain.updateApplication(applicationId, { resume_id: 2, resume_version_id: 2, interview_id: 2, interview_series_id: 2 });
  expect(rebound).toMatchObject({ resume_id: 2, resume_version_id: 2, interview_id: 2, interview_series_id: 2 });
  const created = domain.createApplication({ company: "合法数字", role: "岗位", ...valid });
  expect(created).toMatchObject(valid);
  expect(db.prepare("SELECT notebook_id FROM application_preparation_resources WHERE application_id=? ORDER BY notebook_id").all(created.id))
    .toEqual([{ notebook_id: 1 }]);
  expect(domain.getApplicationById(2)).toEqual(second);
  expect(original.resume_version_id).not.toBe(later.id);
});
