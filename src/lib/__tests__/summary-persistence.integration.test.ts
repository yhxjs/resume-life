import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-summary-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-summary-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

async function saveSummary(id: number, content: unknown) {
  const { loadResume } = await import("../resumes");
  const { PATCH } = await import("@/app/api/resumes/[id]/route");
  const revision = loadResume(id)!.modules.find((module) => module.key === "summary")!.revision;
  const response = await PATCH(new Request(`http://localhost/api/resumes/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ modules: { summary: content }, moduleRevisions: { summary: revision } }),
  }), { params: Promise.resolve({ id: String(id) }) });
  expect(response.status).toBe(200);
}

async function reloadSummary(id: number) {
  const { GET } = await import("@/app/api/resumes/[id]/route");
  const response = await GET(new Request(`http://localhost/api/resumes/${id}`), { params: Promise.resolve({ id: String(id) }) });
  expect(response.status).toBe(200);
  const document = await response.json();
  return document.modules.find((module: { key: string }) => module.key === "summary").content;
}

describe("自我评价列表的真实持久化边界", () => {
  it("列表类型与空行跨 PATCH、重载、发布、复制和加密备份恢复保留", async () => {
    const { createResume, copyResume } = await import("../resume-creation");
    const { publishResumeVersion, getResumeVersion } = await import("../resume-versions");
    const { id } = createResume({ title: "合成简历" });
    const content = { text: "<strong>第一项</strong>\n第二项", descriptionItems: ["<strong>第一项</strong>", "", "第二项"], descriptionStyle: "ordered" };
    await saveSummary(id, content);
    expect(await reloadSummary(id)).toEqual(content);
    const version = publishResumeVersion(id, { name: "有序列表版本" });
    expect(version.snapshot.modules.find((module) => module.key === "summary")!.content).toEqual(content);
    const copied = copyResume(id)!;
    expect(await reloadSummary(copied.id)).toEqual(content);

    const password = "synthetic summary backup";
    const { POST: exportBackup } = await import("@/app/api/backup/export/route");
    const exported = await exportBackup(new Request("http://localhost/api/backup/export", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password, confirmation: password }),
    }));
    expect(exported.status).toBe(200);
    const bytes = new Uint8Array(await exported.arrayBuffer());
    await saveSummary(id, { text: "备份后的变更" });
    const { encodeBackupPasswordHeader } = await import("../backup-container");
    const { POST: restoreBackup } = await import("@/app/api/backup/restore/route");
    const restored = await restoreBackup(new Request("http://localhost/api/backup/restore", {
      method: "POST", headers: { "X-Resume-Life-Backup-Password": encodeBackupPasswordHeader(password) }, body: bytes,
    }));
    expect(restored.status).toBe(200);
    expect(await reloadSummary(id)).toEqual(content);
    expect(await reloadSummary(copied.id)).toEqual(content);
    expect(getResumeVersion(id, version.id)!.snapshot.modules.find((module) => module.key === "summary")!.content).toEqual(content);
  });

  it("诊断替换正文同步更新旧条目，保留列表类型且可清空", async () => {
    const { createResume } = await import("../resume-creation");
    const { writeDiagnosisValue } = await import("../module-descriptions");
    const { id } = createResume({ title: "诊断合成简历" });
    const current = { text: "旧正文", descriptionItems: ["旧正文"], descriptionStyle: "ordered" };
    await saveSummary(id, current);
    const next = writeDiagnosisValue("summary", current, "", "<strong>新正文</strong>\n第二行");
    await saveSummary(id, next);
    expect(await reloadSummary(id)).toEqual({ text: "<strong>新正文</strong>\n第二行", descriptionItems: ["<strong>新正文</strong>", "第二行"], descriptionStyle: "ordered" });
    expect(current.descriptionItems).toEqual(["旧正文"]);
    await saveSummary(id, writeDiagnosisValue("summary", next, "", ""));
    expect(await reloadSummary(id)).toEqual({ text: "", descriptionItems: [], descriptionStyle: "ordered" });
  });
});
