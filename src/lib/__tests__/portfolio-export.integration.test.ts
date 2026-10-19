import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { DEFAULT_ANONYMIZE_CONFIG } from "../resume-anonymize";
import { BUILTIN_STYLES, resolveStyle } from "../templates";

let directory: string;
let db: DatabaseSync;
let portfolio: typeof import("../portfolio");
let generator: typeof import("../portfolio-generator");
let post: typeof import("@/app/api/portfolio/export/route").POST;
let previewPost: typeof import("@/app/api/portfolio/preview/route").POST;

beforeAll(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-portfolio-export-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.prepare("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '作品集简历', '', '')").run();
  db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (1, 'basic', 'basic', '基本信息', 0, ?, '')")
    .run(JSON.stringify({ name: "王小五", title: "软件工程师" }));
  db.prepare("INSERT INTO projects (id, name, summary, created_at, updated_at) VALUES (1, '示例项目', '{}', '', '')").run();
  portfolio = await import("../portfolio");
  generator = await import("../portfolio-generator");
  post = (await import("@/app/api/portfolio/export/route")).POST;
  previewPost = (await import("@/app/api/portfolio/preview/route")).POST;
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-portfolio-export-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

const validInput = { resumeId: 1, selectedProjects: [] };

it("损坏草稿排版不能被作品集预览或导出静默替换", async () => {
  db.prepare("UPDATE resumes SET style_overrides='{broken' WHERE id=1").run();
  try {
    for (const route of [previewPost, post]) {
      const response = await route(request(validInput));
      expect(response.status).toBe(422);
      expect((await response.json()).error).toContain("排版数据损坏");
    }
  } finally {
    db.prepare("UPDATE resumes SET style_overrides='{}' WHERE id=1").run();
  }
});

it.each(["flow", "focus", "chronicle", "sidebar"])("%s 模板的真实预览与 ZIP 主页完全一致，均使用脱敏后的简历内容", async (siteTemplate) => {
  const input = { ...validInput, siteTitle: "王小五的个人主页", themeMode: "dark", accentColor: "#b8ef67", siteTemplate };
  const previewResponse = await previewPost(request(input));
  expect(previewResponse.status).toBe(200);
  expect(previewResponse.headers.get("cache-control")).toContain("no-store");
  const { html, resumeHtml } = await previewResponse.json();
  expect(html).toContain(`data-template="${siteTemplate}"`);
  expect(html).not.toContain("王小五");
  expect(resumeHtml).not.toContain("王小五");
  const exported = await post(request(input));
  expect(exported.status).toBe(200);
  const zip = await JSZip.loadAsync(await exported.arrayBuffer());
  const exportedHtml = await zip.file("index.html")!.async("string");
  const css = await zip.file("assets/style.css")!.async("string");
  const js = await zip.file("assets/app.js")!.async("string");
  expect(html).toBe(exportedHtml.replace('<link rel="stylesheet" href="assets/style.css" />', () => `<style>${css}</style>`)
    .replace('<script src="assets/app.js"></script>', () => `<script>${js}</script>`));
  expect(resumeHtml).toBe(await zip.file("resume.html")!.async("string"));
});

it("所选草稿的自定义模板及微调样式传入脱敏预览与导出", async () => {
  const style = { ...BUILTIN_STYLES.banner_twocol, headerBg: "#a12345", accent: "#a12345", baseSize: 13 };
  const templateId = Number(db.prepare("INSERT INTO resume_templates (name, style, created_at, updated_at) VALUES ('在线简历模板', ?, '', '')")
    .run(JSON.stringify(style)).lastInsertRowid);
  const template = `custom:${templateId}`;
  const overrides = { pageMargin: 18, asidePosition: "left" as const, sectionGapBefore: 21 };
  db.prepare("UPDATE resumes SET template = ?, style_overrides = ? WHERE id = 1").run(template, JSON.stringify(overrides));
  try {
    const assembled = portfolio.assemblePortfolioData(validInput);
    expect(assembled.resumeSnapshot.resolved_style).toEqual(resolveStyle(template, [{
      id: templateId, name: "在线简历模板", style, created_at: "", updated_at: "",
    }], overrides));
    const preview = await previewPost(request(validInput));
    expect(preview.status).toBe(200);
    const { resumeHtml } = await preview.json();
    expect(resumeHtml).toContain("#a12345");
    expect(resumeHtml).toContain("padding:18mm");
    expect(resumeHtml).not.toContain("王小五");
    const exported = await post(request(validInput));
    const zip = await JSZip.loadAsync(await exported.arrayBuffer());
    expect(await zip.file("resume.html")!.async("string")).toBe(resumeHtml);
  } finally {
    db.prepare("UPDATE resumes SET template = 'classic', style_overrides = '{}' WHERE id = 1").run();
    db.prepare("DELETE FROM resume_templates WHERE id = ?").run(templateId);
  }
});

it("已发布版本保留冻结样式，不受当前草稿和原自定义模板变化影响", async () => {
  const style = { ...BUILTIN_STYLES.banner_twocol, headerBg: "#a12345", baseSize: 13 };
  const snapshot = { title: "历史简历", template: "custom:999999", style_overrides: {}, resolved_style: style,
    modules: [{ key: "basic", type: "basic", label: "基本信息", sort: 0, content: { name: "王小五" } }],
  };
  const versionId = Number(db.prepare("INSERT INTO resume_versions (resume_id, version, name, description, created_at, snapshot) VALUES (1, 99, '历史版本', '', '', ?)")
    .run(JSON.stringify(snapshot)).lastInsertRowid);
  try {
    const response = await previewPost(request({ ...validInput, versionId }));
    expect(response.status).toBe(200);
    const { resumeHtml } = await response.json();
    expect(resumeHtml).toContain("#a12345");
    expect(resumeHtml).toContain("font-size:13px");
    expect(resumeHtml).not.toContain("王小五");
  } finally {
    db.prepare("DELETE FROM resume_versions WHERE id = ?").run(versionId);
  }
});

it.each([null, { resumeId: 0 }, { resumeId: 999999 }])("真实预览校验输入和来源 %j", async (input) => {
  const response = await previewPost(request(input));
  expect([400, 404]).toContain(response.status);
  expect(await response.json()).toEqual({ error: expect.any(String) });
});

it("重复项目 ID 返回 400，且不生成重复作品集", async () => {
  const zip = vi.spyOn(generator, "createPortfolioZip");
  const response = await post(request({ resumeId: 1, selectedProjects: [{ projectId: 1 }, { projectId: 1, featured: false }] }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toMatch(/重复/);
  expect(zip).not.toHaveBeenCalled();
});

it("超过 50 个项目在查询业务数据前返回 400", async () => {
  const prepare = vi.spyOn(db, "prepare");
  const response = await post(request({ resumeId: 1, selectedProjects: Array.from({ length: 51 }, (_, i) => ({ projectId: i + 1 })) }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toMatch(/50/);
  expect(prepare.mock.calls.filter(([sql]) => !sql.includes("FROM runtime_state"))).toEqual([]);
});

it("50 个不同项目正常完整导出，不丢弃或重复", async () => {
  for (let i = 2; i <= 50; i++) {
    db.prepare("INSERT INTO projects (id, name, summary, created_at, updated_at) VALUES (?, ?, '{}', '', '')").run(i, `边界项目${i}`);
  }
  try {
    const response = await post(request({ resumeId: 1, selectedProjects: Array.from({ length: 50 }, (_, i) => ({ projectId: i + 1 })) }));
    expect(response.status).toBe(200);
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const html = await zip.file("index.html")!.async("string");
    for (let i = 2; i <= 50; i++) expect(html.split(`>边界项目${i}</h3>`)).toHaveLength(2);
  } finally {
    db.prepare("DELETE FROM projects WHERE id BETWEEN 2 AND 50").run();
  }
});

it("已选项目被删除时返回 409，提示刷新且不生成不完整 ZIP", async () => {
  const zip = vi.spyOn(generator, "createPortfolioZip");
  const response = await post(request({ resumeId: 1, selectedProjects: [{ projectId: 1 }, { projectId: 999999 }] }));
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatch(/999999.*刷新/);
  expect(zip).not.toHaveBeenCalled();
});

it("数据库中的超长项目总结在解析和生成 ZIP 前拒绝", async () => {
  db.prepare("UPDATE projects SET summary = ? WHERE id = 1").run(JSON.stringify({ overview: "文".repeat(1_500_000) }));
  const zip = vi.spyOn(generator, "createPortfolioZip");
  try {
    const response = await post(request({ resumeId: 1, selectedProjects: [{ projectId: 1 }] }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toMatch(/来源.*过大/);
    expect(zip).not.toHaveBeenCalled();
  } finally {
    db.prepare("UPDATE projects SET summary = '{}' WHERE id = 1").run();
  }
});

it.each(["javascript:void(0)", "data:text/html,test", "file:///tmp/test", "//example.com", "/demo", "demo.example.com", "https://", "https://exa\nmple.com"])(
  "真实导出拒绝非完整 HTTP/HTTPS 项目链接 %s", async (url) => {
    const zip = vi.spyOn(generator, "createPortfolioZip");
    const response = await post(request({ resumeId: 1, selectedProjects: [{ projectId: 1, customLinks: { demoUrl: url } }] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringMatching(/HTTP\/HTTPS/) });
    expect(zip).not.toHaveBeenCalled();
  },
);

it.each(["https://example.com/demo?q=1&x=2", "HTTP://example.com/demo", "", "   "])(
  "真实导出允许合法或未填写项目链接 %s", async (url) => {
    const response = await post(request({ resumeId: 1, selectedProjects: [{ projectId: 1, customLinks: { demoUrl: url } }] }));
    expect(response.status).toBe(200);
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const html = await zip.file("index.html")!.async("string");
    if (url.trim()) expect(html).toContain(url.replaceAll("&", "&amp;"));
    else expect(html).not.toContain("在线演示 →");
  },
);

it("损坏简历草稿模块返回 422，保留原文且不生成 ZIP", async () => {
  const content = '{"text":';
  db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (1, 'summary', 'summary', '自我评价', 1, ?, '')").run(content);
  const zip = vi.spyOn(generator, "createPortfolioZip");
  try {
    const response = await post(request(validInput));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: expect.stringMatching(/简历.*损坏.*修复/) });
    expect(zip).not.toHaveBeenCalled();
    expect(db.prepare("SELECT content FROM resume_modules WHERE resume_id = 1 AND module_key = 'summary'").get()).toEqual({ content });
  } finally {
    db.prepare("DELETE FROM resume_modules WHERE resume_id = 1 AND module_key = 'summary'").run();
  }
});

it("合法空简历模块仍可导出 ZIP", async () => {
  db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (1, 'summary', 'summary', '自我评价', 1, ?, '')").run(JSON.stringify({ text: "" }));
  try {
    const response = await post(request(validInput));
    expect(response.status).toBe(200);
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    expect(zip.file("resume.html")).not.toBeNull();
  } finally {
    db.prepare("DELETE FROM resume_modules WHERE resume_id = 1 AND module_key = 'summary'").run();
  }
});

it("指定有效发布版本时不受损坏草稿影响", async () => {
  const snapshot = portfolio.assemblePortfolioData(validInput).resumeSnapshot;
  db.prepare("INSERT INTO resume_versions (id, resume_id, version, name, description, created_at, snapshot) VALUES (1, 1, 1, '有效版本', '', '', ?)").run(JSON.stringify(snapshot));
  db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (1, 'summary', 'summary', '自我评价', 1, '{', '')").run();
  try {
    const response = await post(request({ ...validInput, versionId: 1 }));
    expect(response.status).toBe(200);
    expect(portfolio.assemblePortfolioData({ ...validInput, versionId: 1 }).resumeSnapshot).toEqual(snapshot);
  } finally {
    db.prepare("DELETE FROM resume_modules WHERE resume_id = 1 AND module_key = 'summary'").run();
    db.prepare("DELETE FROM resume_versions WHERE id = 1").run();
  }
});

it.each(["#123456; background: red", "#123456}body{display:none}", "url(https://example.com/track)", "#abc", "", "red"])(
  "真实 route 拒绝非法主色调 %s 且不生成 ZIP", async (accentColor) => {
    const zip = vi.spyOn(generator, "createPortfolioZip");
    const response = await post(request({ ...validInput, accentColor }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringMatching(/主色调/) });
    expect(zip).not.toHaveBeenCalled();
  },
);

it.each(["#12abEF", "#000000", "#FFFFFF"])("六位十六进制主色调 %s 可导出", async (accentColor) => {
  const response = await post(request({ ...validInput, accentColor }));
  expect(response.status).toBe(200);
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  expect(await zip.file("assets/style.css")!.async("string")).toContain(accentColor);
});

it.each(["{", '{"overview":42}'])("损坏总结 %s 不得静默导出为空项目", async (summary) => {
  db.prepare("UPDATE projects SET summary = ? WHERE id = 1").run(summary);
  const zip = vi.spyOn(generator, "createPortfolioZip");
  try {
    expect(() => portfolio.assemblePortfolioData({ resumeId: 1, selectedProjects: [{ projectId: 1 }] }))
      .toThrow(/项目.*1.*总结.*损坏/);
    expect(() => portfolio.loadPortfolioSources()).toThrow(portfolio.PortfolioError);
    const response = await post(request({ resumeId: 1, selectedProjects: [{ projectId: 1 }] }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: expect.stringMatching(/项目.*1.*总结.*损坏/) });
    expect(zip).not.toHaveBeenCalled();
    const { GET } = await import("@/app/api/portfolio/sources/route");
    expect((await GET(new Request("http://127.0.0.1/api/portfolio/sources"))).status).toBe(422);
    expect(db.prepare("SELECT summary FROM projects WHERE id = 1").get()).toEqual({ summary });
  } finally {
    db.prepare("UPDATE projects SET summary = '{}' WHERE id = 1").run();
  }
});

const withSelection = (item: unknown) => ({ ...validInput, selectedProjects: [item] });
const withConfig = (config: unknown) => ({ ...validInput, anonymizeConfig: config });
const invalidInputs: Array<[string, unknown]> = [
  ["null 根值", null], ["数字根值", 1], ["数组根值", []], ["字符串根值", "portfolio"],
  ["缺少简历", {}],
  ...[null, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].map((resumeId): [string, unknown] => [
    `非法 resumeId ${String(resumeId)}`, { ...validInput, resumeId },
  ]),
  ...[0, -1, 1.5, "1", false].map((versionId): [string, unknown] => [
    `非法 versionId ${String(versionId)}`, { ...validInput, versionId },
  ]),
  ...[null, 1, {}, "projects"].map((selectedProjects): [string, unknown] => [
    `非法项目列表 ${JSON.stringify(selectedProjects)}`, { ...validInput, selectedProjects },
  ]),
  ["null 项目项", withSelection(null)], ["数字项目项", withSelection(1)],
  ["数组项目项", withSelection([])], ["缺少项目 ID", withSelection({})],
  ...[0, -1, 1.5, "1"].map((projectId): [string, unknown] => [
    `非法 projectId ${String(projectId)}`, withSelection({ projectId }),
  ]),
  ["非法 featured", withSelection({ projectId: 1, featured: "true" })],
  ["非法 order", withSelection({ projectId: 1, order: "0" })],
  ["非有限 order", withSelection({ projectId: 1, order: Infinity })],
  ...[null, [], 1].map((customLinks): [string, unknown] => [
    `非法链接对象 ${JSON.stringify(customLinks)}`, withSelection({ projectId: 1, customLinks }),
  ]),
  ...["demoUrl", "repoUrl", "docUrl"].map((key): [string, unknown] => [
    `非法链接 ${key}`, withSelection({ projectId: 1, customLinks: { [key]: 1 } }),
  ]),
  ...["siteTitle", "siteSubtitle", "accentColor"].map((key): [string, unknown] => [
    `非法展示字段 ${key}`, { ...validInput, [key]: 1 },
  ]),
  ["非法主题", { ...validInput, themeMode: "dusk" }],
  ...["missing", null, 1, {}, '<script>'].map((siteTemplate): [string, unknown] => [
    `非法主页模板 ${JSON.stringify(siteTemplate)}`, { ...validInput, siteTemplate },
  ]),
  ["null 匿名配置", withConfig(null)], ["空匿名配置", withConfig({})],
  ...Object.keys(DEFAULT_ANONYMIZE_CONFIG).map((key): [string, unknown] => {
    const config = { ...DEFAULT_ANONYMIZE_CONFIG } as Record<string, unknown>;
    delete config[key];
    return [`缺少匿名字段 ${key}`, withConfig(config)];
  }),
  ...["name", "phone", "email", "location", "birthday", "links"].map((key): [string, unknown] => [
    `非法匿名模式 ${key}`, withConfig({ ...DEFAULT_ANONYMIZE_CONFIG, [key]: { enabled: true, mode: "invalid" } }),
  ]),
  ["非法匿名开关", withConfig({ ...DEFAULT_ANONYMIZE_CONFIG, phone: { enabled: "true", mode: "prefix_only" } })],
  ["非法头像开关", withConfig({ ...DEFAULT_ANONYMIZE_CONFIG, avatar: { enabled: 1 } })],
  ["非法名字占位符", withConfig({ ...DEFAULT_ANONYMIZE_CONFIG, name: { enabled: true, mode: "placeholder", customPlaceholder: 1 } })],
  ...[null, {}, [null], [1], [{}], [{ id: "rule", source: 1, replacement: "" }],
    [{ id: 1, source: "secret", replacement: "" }], [{ id: "rule", source: "secret", replacement: 1 }],
    [{ id: "rule", source: "secret", replacement: "", matchCase: "true" }],
  ].map((customRules): [string, unknown] => [
    `非法自定义规则 ${JSON.stringify(customRules)}`, withConfig({ ...DEFAULT_ANONYMIZE_CONFIG, customRules }),
  ]),
];

function request(body: unknown) {
  return new Request("http://127.0.0.1/api/portfolio/export", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("portfolio export input boundary", () => {
  it.each(invalidInputs)("领域在查询前以 PortfolioError 400 拒绝%s", (_label, input) => {
    const prepare = vi.spyOn(db, "prepare");
    let error: unknown;
    try { portfolio.assemblePortfolioData(input); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(portfolio.PortfolioError);
    expect(error).toMatchObject({ status: 400 });
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["null 项目列表", { ...validInput, selectedProjects: null }],
    ["数字项目列表", { ...validInput, selectedProjects: 1 }],
    ["对象项目列表", { ...validInput, selectedProjects: {} }],
    ["null 项目项", withSelection(null)],
    ["对象缺少项目 ID", withSelection({})],
    ["错误链接类型", withSelection({ projectId: 1, customLinks: { repoUrl: {} } })],
    ["残缺匿名配置", withConfig({ name: {} })],
    ["错误匿名模式", withConfig({ ...DEFAULT_ANONYMIZE_CONFIG, links: { enabled: true, mode: "keep" } })],
    ["错误匿名规则", withConfig({ ...DEFAULT_ANONYMIZE_CONFIG, customRules: [null] })],
  ])("真实 route 对%s返回 400，不读取业务数据或生成 ZIP", async (_label, input) => {
    const prepare = vi.spyOn(db, "prepare");
    const zip = vi.spyOn(generator, "createPortfolioZip");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await post(request(input));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(prepare.mock.calls.filter(([sql]) => !sql.includes("FROM runtime_state"))).toEqual([]);
    expect(zip).not.toHaveBeenCalled();
  });

  it("保留缺省项目列表、空版本和展示默认值", () => {
    const data = portfolio.assemblePortfolioData({ resumeId: 1, versionId: null });
    expect(data.projects).toEqual([]);
    expect(data.siteTitle).toBe("作品集简历 - 个人作品集");
    expect(data.siteSubtitle).toBe("");
    expect(data.accentColor).toBe("#b8722c");
    expect(data.themeMode).toBe("auto");
    expect(data.siteTemplate).toBe("flow");
    expect(data.anonymizeConfig).toEqual(DEFAULT_ANONYMIZE_CONFIG);
  });

  it("正常参数经真实领域、匿名处理和生成器导出完整 ZIP", async () => {
    const response = await post(request({
      resumeId: 1, themeMode: "light", accentColor: "#123456", siteTitle: "工程作品集", siteSubtitle: "精选项目",
      selectedProjects: [{ projectId: 1, featured: false, order: 0, customLinks: { repoUrl: "https://example.com/repo" } }],
      anonymizeConfig: { ...DEFAULT_ANONYMIZE_CONFIG, customRules: [{ id: "rule", source: "示例", replacement: "公开", matchCase: false }] },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    for (const file of ["index.html", "resume.html", "resume.md", "assets/app.js", "assets/style.css"]) {
      expect(zip.file(file)).not.toBeNull();
    }
    const html = await zip.file("index.html")!.async("string");
    expect(html).toContain("工程作品集");
    expect(html).toContain("公开项目");
    expect(html).toContain("王**");
    expect(html).not.toContain("王小五");
    expect(html).toContain("https://example.com/repo");
  });
});
