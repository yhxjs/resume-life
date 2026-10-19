import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeDiagnosisValue } from "@/lib/module-descriptions";
import type { WorkItem } from "@/lib/modules";

let tempDir: string;
let db: DatabaseSync;
let PATCH: typeof import("@/app/api/resumes/[id]/route").PATCH;
let GET: typeof import("@/app/api/resumes/[id]/route").GET;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-diagnosis-apply-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  const route = await import("@/app/api/resumes/[id]/route");
  PATCH = route.PATCH;
  GET = route.GET;
  db = (await import("@/lib/db")).getDb();
  db.exec("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '原简历', '', '')");
  db.prepare(
    `INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at)
     VALUES (1, 'work_1', 'work', '工作经历', 0, ?, '')`
  ).run(
    JSON.stringify([
      {
        id: "w1",
        company: "某公司",
        title: "工程师",
        start: "",
        end: "",
        description: "旧描述",
        subItems: [],
        descriptionItems: ["更旧的一行"],
        descriptionStyle: "unordered",
      },
    ])
  );
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-diagnosis-apply-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const params = { params: Promise.resolve({ id: "1" }) };
const patch = (body: unknown) =>
  new Request("http://localhost/api/resumes/1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function revision(): Promise<string> {
  const response = await GET(new Request("http://localhost/api/resumes/1"), params);
  const document = await response.json() as { modules: { key: string; revision: string }[] };
  return document.modules.find((module) => module.key === "work_1")!.revision;
}

describe("JD 诊断建议的应用能活过保存与重新加载", () => {
  it("work：应用后重新加载保留建议正文与列表", async () => {
    const current = [
      {
        id: "w1",
        company: "某公司",
        title: "工程师",
        start: "",
        end: "",
        description: "旧描述",
        subItems: [],
        descriptionItems: ["更旧的一行"],
        descriptionStyle: "unordered",
      },
    ];
    const next = writeDiagnosisValue("work", current, "w1", "<strong>对齐 JD 的新描述</strong>");
    expect(next).not.toBeNull();

    const saved = await PATCH(patch({ modules: { work_1: next }, moduleRevisions: { work_1: await revision() } }), params);
    expect(saved.status).toBe(200);

    const reloaded = await (await GET(new Request("http://localhost/api/resumes/1"), params)).json();
    const item = (reloaded.modules as { key: string; content: WorkItem[] }[]).find(
      (m) => m.key === "work_1"
    )!.content[0];
    expect(item!.description).toBe("<strong>对齐 JD 的新描述</strong>");
    expect(item!.descriptionItems).toEqual(["<strong>对齐 JD 的新描述</strong>"]);
  });

});
