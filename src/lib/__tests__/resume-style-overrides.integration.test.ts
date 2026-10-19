import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-style-overrides-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-style-overrides-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("resume style overrides integration", () => {
  it.each(["{broken", "null", "[]", ""])("损坏排版 %s 保留原文、明确警告并阻止发布，显式保存后恢复", async (broken) => {
    const { createResume } = await import("@/lib/resume-creation");
    const { loadResume } = await import("@/lib/resumes");
    const { publishResumeVersion } = await import("@/lib/resume-versions");
    const { PATCH } = await import("@/app/api/resumes/[id]/route");
    const { id } = createResume({ title: "排版修复" });
    db.prepare("UPDATE resumes SET style_overrides=? WHERE id=?").run(broken, id);
    const loaded = loadResume(id)!;
    expect(loaded.resume).toMatchObject({ style_overrides: {}, styleCorrupted: true });
    expect(loaded.warnings.join(" ")).toContain("排版数据损坏");
    expect(loaded.corruptedKeys).toEqual([]);
    expect(() => publishResumeVersion(id, { name: "异常版" })).toThrow(/排版数据损坏/);
    expect(db.prepare("SELECT style_overrides FROM resumes WHERE id=?").get(id)).toEqual({ style_overrides: broken });
    const response = await PATCH(new Request(`http://localhost/api/resumes/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataGeneration: loaded.resume.dataGeneration, styleRevision: loaded.resume.styleRevision, styleOverrides: null }),
    }), { params: Promise.resolve({ id: String(id) }) });
    expect(response.status).toBe(200);
    expect(loadResume(id)!.resume.styleCorrupted).not.toBe(true);
    expect(loadResume(id)!.warnings).toEqual([]);
    expect(publishResumeVersion(id, { name: "修复版" }).snapshot.style_overrides).toEqual({});
  });

  it("同一世代的旧排版快照不能覆盖已保存设置，刷新后可合并", async () => {
    const { createResume } = await import("@/lib/resume-creation");
    const { loadResume } = await import("@/lib/resumes");
    const { PATCH } = await import("@/app/api/resumes/[id]/route");
    const { id } = createResume({ title: "并发排版" });
    const initial = loadResume(id)!;
    const send = (body: unknown) => PATCH(new Request(`http://localhost/api/resumes/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: String(id) }) });
    const baseline = { dataGeneration: initial.resume.dataGeneration, styleRevision: initial.resume.styleRevision };
    expect((await send({ ...baseline, styleOverrides: { baseSize: 14 } })).status).toBe(200);
    expect((await send({ ...baseline, styleOverrides: { pageMargin: 20 } })).status).toBe(409);
    const fresh = loadResume(id)!;
    expect(fresh.resume.style_overrides).toEqual({ baseSize: 14 });
    expect((await send({ dataGeneration: fresh.resume.dataGeneration, styleRevision: fresh.resume.styleRevision,
      styleOverrides: { ...fresh.resume.style_overrides, pageMargin: 20 } })).status).toBe(200);
    expect(loadResume(id)!.resume.style_overrides).toEqual({ baseSize: 14, pageMargin: 20 });
  });

  it("排版写入缺少版本时返回冲突而不是覆盖", async () => {
    const { createResume } = await import("@/lib/resume-creation");
    const { loadResume } = await import("@/lib/resumes");
    const { PATCH } = await import("@/app/api/resumes/[id]/route");
    const { id } = createResume({ title: "排版令牌" });
    const initial = loadResume(id)!;
    const response = await PATCH(new Request(`http://localhost/api/resumes/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataGeneration: initial.resume.dataGeneration, styleOverrides: null }),
    }), { params: Promise.resolve({ id: String(id) }) });
    expect(response.status).toBe(409);
    expect(loadResume(id)).toEqual(initial);
  });

  it("persists and reads style overrides through API and database", async () => {
    const { loadResume } = await import("@/lib/resumes");
    const { PATCH, GET } = await import("@/app/api/resumes/[id]/route");
    const { POST: copyRoute } = await import("@/app/api/resumes/[id]/copy/route");
    const { now } = await import("@/lib/db");

    const ts = now();
    const res = db
      .prepare("INSERT INTO resumes (title, template, style_overrides, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("测试简历", "classic", "{}", ts, ts);
    const resumeId = Number(res.lastInsertRowid);

    // 默认读取为空对象
    const initial = loadResume(resumeId);
    expect(initial).not.toBeNull();
    expect(initial?.resume.style_overrides).toEqual({});

    // 通过 PATCH 更新 styleOverrides
    const patchReq = new Request(`http://localhost/api/resumes/${resumeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataGeneration: initial?.resume.dataGeneration,
        styleRevision: initial?.resume.styleRevision,
        styleOverrides: {
          sectionGapBefore: 10,
          entryGap: 6,
          lineHeight: 1.4,
          pageMargin: 11,
        },
      }),
    });
    const patchRes = await PATCH(patchReq, { params: Promise.resolve({ id: String(resumeId) }) });
    expect(patchRes.status).toBe(200);
    const patchData = await patchRes.json();
    expect(patchData.resume.style_overrides).toEqual({
      sectionGapBefore: 10,
      entryGap: 6,
      lineHeight: 1.4,
      pageMargin: 11,
    });

    // 再次 GET 验证持久化
    const getRes = await GET(new Request(`http://localhost/api/resumes/${resumeId}`), {
      params: Promise.resolve({ id: String(resumeId) }),
    });
    const getData = await getRes.json();
    expect(getData.resume.style_overrides).toEqual({
      sectionGapBefore: 10,
      entryGap: 6,
      lineHeight: 1.4,
      pageMargin: 11,
    });

    // 测试复制简历继承 style_overrides
    const copyRes = await copyRoute(new Request(`http://localhost/api/resumes/${resumeId}/copy`, { method: "POST" }), {
      params: Promise.resolve({ id: String(resumeId) }),
    });
    expect(copyRes.status).toBe(201);
    const copyJson = await copyRes.json();
    const copiedResume = loadResume(copyJson.id);
    expect(copiedResume?.resume.style_overrides).toEqual({
      sectionGapBefore: 10,
      entryGap: 6,
      lineHeight: 1.4,
      pageMargin: 11,
    });

    // 重置 styleOverrides 为 null
    const resetReq = new Request(`http://localhost/api/resumes/${resumeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataGeneration: getData.resume.dataGeneration,
        styleRevision: getData.resume.styleRevision,
        styleOverrides: null,
      }),
    });
    const resetRes = await PATCH(resetReq, { params: Promise.resolve({ id: String(resumeId) }) });
    const resetData = await resetRes.json();
    expect(resetData.resume.style_overrides).toEqual({});
  });
});
