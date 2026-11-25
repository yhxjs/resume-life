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
  it("导入的技术字面量经真实创建、回读、复制与 Markdown 导出不被解码或重复转义", async () => {
    const text = String.raw`维护 Array<T>、<template>、<strong>字面标签</strong>、&amp; 与 C:\new\resume`;
    const secondLine = "未上线，收益尚未统计。";
    const llm = await import("../llm");
    vi.spyOn(llm, "chat").mockResolvedValue(JSON.stringify({
      title: "字面量导入",
      basic: { name: "合成人物", links: text },
      education: [{ school: "合成大学", description: `${text}\n${secondLine}` }],
      work: [{ company: text, descriptionItems: [text, secondLine], subItems: [{ label: "技术栈", value: text }] }],
      projects: [{ name: "合成项目", description: `${text}\n${secondLine}` }],
      custom: [{ title: "合成作品", descriptionItems: [text, secondLine] }],
      summary: { text: `${text}\n${secondLine}` },
      skills: { items: [text] },
    }));
    const { POST: parse } = await import("@/app/api/import/parse/route");
    const parsed = await parse(new Request("http://localhost/api/import/parse", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
    }));
    expect(parsed.status).toBe(200);
    const draft = await parsed.json();
    const { POST } = await import("@/app/api/resumes/route");
    const response = await POST(new Request("http://localhost/api/resumes", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft),
    }));
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const { loadResume, loadResumeContext } = await import("../resumes");
    const { stripRichText } = await import("../rich-text");
    const { resumeToMarkdown } = await import("../resume-markdown");
    const loaded = loadResume(id)!;
    for (const section of loaded.modules) {
      expect(section.content).toEqual(draft.modules[section.type]);
      if (["education", "work", "projects", "custom"].includes(section.type)) {
        const entry = (section.content as { description: string; descriptionItems?: string[] }[])[0]!;
        expect(stripRichText(entry.description)).toBe(`${text}\n${secondLine}`);
        if (entry.descriptionItems) expect(entry.descriptionItems.map(stripRichText)).toEqual([text, secondLine]);
      }
      if (section.type === "summary") expect(stripRichText((section.content as { text: string }).text)).toBe(`${text}\n${secondLine}`);
    }
    const resumeContext = JSON.parse(loadResumeContext(id));
    expect(resumeContext).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "work", entries: [expect.objectContaining({
        company: text, subItems: [{ label: "技术栈", value: text }],
      })] }),
      expect.objectContaining({ type: "skills", items: [text] }),
    ]));
    const markdown = resumeToMarkdown("字面量导入", loaded.modules);
    expect(markdown).toContain(String.raw`维护 Array\<T\>、\<template\>、\<strong\>字面标签\</strong\>、\&amp; 与 C:\\new\\resume`);
    expect(markdown).not.toContain("&amp;amp;");
    const copied = await copy(id);
    expect(copied.status).toBe(201);
    const copiedId = (await copied.json()).id;
    expect(loadResume(copiedId)!.modules.map((module) => module.content)).toEqual(loaded.modules.map((module) => module.content));
    expect(JSON.parse(loadResumeContext(copiedId))).toEqual(resumeContext);
  });

  it("导入解析的证书与团队奖项经创建、回读和复制后完整保留", async () => {
    const llm = await import("../llm");
    vi.spyOn(llm, "chat").mockResolvedValue(JSON.stringify({
      title: "合成导入简历",
      custom: [
        { title: "合成证书", subTitle: "合成机构", start: "2025年6月", end: "",
          subItems: [{ label: "编号", value: "CERT-001" }], descriptionItems: ["证书有效期三年。"] },
        { title: "合成竞赛二等奖", subTitle: "团队奖项", start: "2024", end: "",
          descriptionItems: ["团队获得二等奖，个人负责联调。"] },
      ],
    }));
    const { POST: parse } = await import("@/app/api/import/parse/route");
    const parsed = await parse(new Request("http://localhost/api/import/parse", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "证书与团队奖项的合成原文" }),
    }));
    expect(parsed.status).toBe(200);
    const draft = await parsed.json();
    const { POST } = await import("@/app/api/resumes/route");
    const response = await POST(new Request("http://localhost/api/resumes", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft),
    }));
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const { loadResume, loadResumeContext } = await import("../resumes");
    const modules = loadResume(id)!.modules;
    expect(modules).toHaveLength(7);
    const custom = modules.find((module) => module.type === "custom")!;
    expect(custom.key).toMatch(/^mod_/);
    expect(custom.label).toBe("自定义");
    expect(custom.sort).toBe(6);
    expect(custom.content).toEqual(draft.modules.custom);
    expect(loadResumeContext(id)).toContain("团队获得二等奖，个人负责联调。");
    const copied = await copy(id);
    const copiedId = (await copied.json()).id;
    expect(loadResume(copiedId)!.modules.find((module) => module.type === "custom")).toMatchObject({
      key: custom.key, type: "custom", content: draft.modules.custom,
    });
  });
  it("导入解析拒绝嵌套未声明字段并保留完整原文供恢复", async () => {
    const originalText = "负责接口联调，尚未上线。";
    const llm = await import("../llm");
    vi.spyOn(llm, "chat").mockResolvedValue(JSON.stringify({
      work: [{ company: "合成公司", descriptionItems: ["负责接口联调，尚未上线。"], legacyExtra: "原文补充事实" }],
    }));
    const { POST: parse } = await import("@/app/api/import/parse/route");
    const response = await parse(new Request("http://localhost/api/import/parse", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: originalText }),
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ extractedText: originalText, error: expect.any(String) });
  });
  it.each([undefined, []])("自定义内容为 %j 时仍仅创建默认六模块", async (custom) => {
    const { createResume } = await import("../resume-creation");
    const { loadResume } = await import("../resumes");
    const { id } = createResume({ title: "空自定义", modules: custom === undefined ? {} : { custom } });
    expect(loadResume(id)!.modules.map((module) => module.key)).toEqual([...DEFAULT_INITIAL_MODULE_KEYS]);
  });
  it("导入自定义模块写失败时回滚整份简历，可重新创建", async () => {
    const { createResume } = await import("../resume-creation");
    db.exec("CREATE TRIGGER fail_custom BEFORE INSERT ON resume_modules WHEN NEW.type = 'custom' BEGIN SELECT RAISE(ABORT, 'synthetic custom failure'); END;");
    const draft = { title: "证书简历", modules: { custom: [{ title: "证书" }] } };
    expect(() => createResume(draft)).toThrow("synthetic custom failure");
    expect(db.prepare("SELECT COUNT(*) AS n FROM resumes").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM resume_modules").get()).toEqual({ n: 0 });
    db.exec("DROP TRIGGER fail_custom");
    expect(createResume(draft).id).toBeGreaterThan(0);
  });
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
