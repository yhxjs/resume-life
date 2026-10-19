import { beforeEach, describe, expect, it, vi } from "vitest";
import mammoth from "mammoth";
import { POST as postMarkdown } from "../route";
import { POST as postPdf } from "../pdf/route";
import { POST as postDocx } from "../docx/route";
import { DEFAULT_ANONYMIZE_CONFIG } from "@/lib/resume-anonymize";
import { MAX_JSON_REQUEST_BYTES } from "@/lib/request-limits";
import { defaultContent } from "@/lib/modules";
import type { ResumeWithModules } from "@/lib/resumes";

const pdf = vi.hoisted(() => ({
  renderResumeToHtml: vi.fn((data: ResumeWithModules) => JSON.stringify(data)),
  generateResumePdf: vi.fn(async (html: string) => Buffer.from(html)),
}));
vi.mock("@/lib/pdf-render", () => ({
  ...pdf,
  loadCustomTemplate: vi.fn(),
  PdfExportBusyError: class extends Error {},
  PdfExportCancelledError: class extends Error {},
  PdfExportTimeoutError: class extends Error {},
}));
vi.mock("@/lib/resumes", () => ({ loadResume: vi.fn() }));

import { loadResume } from "@/lib/resumes";

const context = () => ({ params: Promise.resolve({ id: "1" }) });
const request = (body: string, contentType: string | null = "application/json", extraHeaders: Record<string, string> = {}) => {
  const headers = new Headers(extraHeaders);
  if (contentType !== null) headers.set("Content-Type", contentType);
  const req = new Request("http://localhost/export", { method: "POST", headers, body });
  if (contentType === null) req.headers.delete("Content-Type");
  return req;
};

const invalidConfigs: [string, unknown][] = [
  ["null", null],
  ["空配置", {}],
  ["数组配置", []],
  ["布尔配置", false],
  ["缺少 phone", Object.fromEntries(Object.entries(DEFAULT_ANONYMIZE_CONFIG).filter(([key]) => key !== "phone"))],
  ["非法名字占位符", { ...DEFAULT_ANONYMIZE_CONFIG, name: { ...DEFAULT_ANONYMIZE_CONFIG.name, customPlaceholder: 1 } }],
  ["缺少自定义规则", { ...DEFAULT_ANONYMIZE_CONFIG, customRules: undefined }],
  ["规则不是数组", { ...DEFAULT_ANONYMIZE_CONFIG, customRules: {} }],
  ["规则不是对象", { ...DEFAULT_ANONYMIZE_CONFIG, customRules: [null] }],
  ["规则缺少 id", { ...DEFAULT_ANONYMIZE_CONFIG, customRules: [{ source: "保密词", replacement: "替换词" }] }],
  ["规则 source 非字符串", { ...DEFAULT_ANONYMIZE_CONFIG, customRules: [{ id: "1", source: 1, replacement: "替换词" }] }],
  ["规则 replacement 非字符串", { ...DEFAULT_ANONYMIZE_CONFIG, customRules: [{ id: "1", source: "保密词", replacement: null }] }],
  ["规则 matchCase 非布尔", { ...DEFAULT_ANONYMIZE_CONFIG, customRules: [{ id: "1", source: "保密词", replacement: "替换词", matchCase: "false" }] }],
];
for (const key of ["name", "phone", "email", "location", "birthday", "links", "avatar"] as const) {
  invalidConfigs.push([`${key} enabled 非布尔`, { ...DEFAULT_ANONYMIZE_CONFIG, [key]: { ...DEFAULT_ANONYMIZE_CONFIG[key], enabled: "false" } }]);
  if (key !== "avatar") {
    invalidConfigs.push([`${key} mode 非法，即使已关闭`, { ...DEFAULT_ANONYMIZE_CONFIG, [key]: { enabled: false, mode: "invalid" } }]);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadResume).mockReturnValue({
    resume: { id: 1, title: "合成候选人的简历", template: "classic", style_overrides: {}, created_at: "", updated_at: "" },
    modules: [{ key: "basic", type: "basic", label: "基本信息", sort: 0,
      content: { ...defaultContent("basic"), name: "合成候选人", phone: "13800000000", email: "synthetic@example.com" } }],
    warnings: [], corruptedKeys: [],
  });
});

describe.each([["Markdown", postMarkdown], ["PDF", postPdf], ["DOCX", postDocx]] as const)("%s 导出请求边界", (format, post) => {
  async function expectRejected(req: Request, status: number) {
    const response = await post(req, context());
    expect(response.status).toBe(status);
    expect(response.headers.has("Content-Disposition")).toBe(false);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toHaveProperty("error");
    expect(pdf.renderResumeToHtml).not.toHaveBeenCalled();
    expect(pdf.generateResumePdf).not.toHaveBeenCalled();
  }

  it.each(["", '{"anonymizeConfig":', "null", "[]", "false", "1"])("拒绝空、截断或非对象 JSON：%s", async (body) => {
    await expectRejected(request(body), 400);
  });

  it.each([null, "text/plain", "application/x-www-form-urlencoded"])("拒绝不支持的 Content-Type：%s", async (contentType) => {
    await expectRejected(request("{}", contentType), 415);
  });

  it("拒绝声明超过 1 MiB 的请求且不下载原文", async () => {
    await expectRejected(request("{}", "application/json", { "Content-Length": String(MAX_JSON_REQUEST_BYTES + 1) }), 413);
  });

  it("拒绝未声明 Content-Length 的实际超限请求", async () => {
    await expectRejected(request(JSON.stringify({ padding: "x".repeat(MAX_JSON_REQUEST_BYTES) })), 413);
  });

  it.each(invalidConfigs)("拒绝无效脱敏配置：%s", async (_, anonymizeConfig) => {
    await expectRejected(request(JSON.stringify({ anonymizeConfig })), 400);
  });

  it("合法空对象保持不脱敏导出", async () => {
    const response = await post(request("{}", "application/json; charset=utf-8"), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(decodeURIComponent(response.headers.get("Content-Disposition")!)).toContain("合成候选人");
  });

  it("合法脱敏配置仍去除正文和附件名中的合成敏感信息", async () => {
    const response = await post(request(JSON.stringify({ anonymizeConfig: DEFAULT_ANONYMIZE_CONFIG })), context());
    expect(response.status).toBe(200);
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = format === "DOCX" ? (await mammoth.extractRawText({ buffer })).value : buffer.toString("utf-8");
    for (const secret of ["合成候选人", "13800000000", "synthetic@example.com"]) {
      expect(text).not.toContain(secret);
      expect(decodeURIComponent(response.headers.get("Content-Disposition")!)).not.toContain(secret);
    }
  });

  it("合法非默认配置保留关闭的电话脱敏并替换自定义标题敏感词", async () => {
    const anonymizeConfig = { ...DEFAULT_ANONYMIZE_CONFIG,
      name: { enabled: false, mode: "keep" }, phone: { enabled: false, mode: "mask_middle" },
      email: { enabled: true, mode: "remove" }, links: { enabled: false, mode: "domain_only" },
      customRules: [{ id: "custom", source: "合成候选人", replacement: "匿名代号", matchCase: false }],
    };
    const response = await post(request(JSON.stringify({ anonymizeConfig })), context());
    expect(response.status).toBe(200);
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = format === "DOCX" ? (await mammoth.extractRawText({ buffer })).value : buffer.toString("utf-8");
    expect(text).toContain("13800000000");
    expect(text).toContain("匿名代号");
    expect(text).not.toContain("合成候选人");
    expect(text).not.toContain("synthetic@example.com");
    const filename = decodeURIComponent(response.headers.get("Content-Disposition")!);
    expect(filename).toContain("匿名代号");
    expect(filename).not.toContain("合成候选人");
  });
});
