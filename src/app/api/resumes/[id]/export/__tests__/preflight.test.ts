import { describe, expect, it, vi } from "vitest";
import { inspectResumeForExport } from "@/lib/resume-export-check";
import type { ModuleData } from "@/lib/modules";
import { GET as getMd, POST as postMd } from "../route";
import { GET as getPdf, POST as postPdf } from "../pdf/route";
import { DEFAULT_ANONYMIZE_CONFIG } from "@/lib/resume-anonymize";

const data = vi.hoisted(() => ({ resume: { id: 1, title: "合成简历", template: "classic" }, modules: [] as ModuleData[] }));
const render = vi.hoisted(() => vi.fn(async () => Buffer.from("%PDF-1.4")));
vi.mock("@/lib/resumes", () => ({ loadResume: () => data }));
vi.mock("@/lib/pdf-render", () => ({ generateResumePdf: render, renderResumeToHtml: () => "<html></html>",
  loadCustomTemplate: vi.fn(), PdfExportBusyError: class extends Error {}, PdfExportCancelledError: class extends Error {}, PdfExportTimeoutError: class extends Error {} }));
const params = () => ({ params: Promise.resolve({ id: "1" }) });

describe("服务端导出前检查", () => {
  it.each([["Markdown", getMd, postMd], ["PDF", getPdf, postPdf]] as const)("%s 必须确认数字，正文变化后旧确认失效", async (_, get, post) => {
    data.modules = [{ key: "summary", type: "summary", label: "简介", sort: 0, content: { text: "提升 40% 的效率" } }];
    const blocked = await get(new Request("http://localhost/export"), params());
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).issues[0].moduleKey).toBe("summary");
    const confirmedIssueIds = inspectResumeForExport({ modules: data.modules }).blockingIssues.map((issue) => issue.id);
    const request = () => new Request("http://localhost/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmedIssueIds }) });
    expect((await post(request(), params())).status).toBe(200);
    data.modules[0]!.content = { text: "提升 40% 的收入" };
    expect((await post(request(), params())).status).toBe(409);
  });
  it("占位符不可通过传入确认 ID 绕过", async () => {
    data.modules = [{ key: "summary", type: "summary", label: "简介", sort: 0, content: { text: "[待确认示例：40%]" } }];
    const confirmedIssueIds = inspectResumeForExport({ modules: data.modules }).issues.map((issue) => issue.id);
    const res = await postMd(new Request("http://localhost/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmedIssueIds }) }), params());
    expect(res.status).toBe(409);
  });
  it.each([["Markdown", getMd, postMd], ["PDF", getPdf, postPdf]] as const)("%s 仅明确选择跳过核对的 POST 可导出占位符", async (_, get, post) => {
    data.modules = [{ key: "summary", type: "summary", label: "简介", sort: 0, content: { text: "[待确认示例：40%]" } }];
    expect((await get(new Request("http://localhost/export"), params())).status).toBe(409);
    const request = (skipExportCheck: unknown) => new Request("http://localhost/export", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skipExportCheck }),
    });
    expect((await post(request("true"), params())).status).toBe(409);
    expect((await post(request(true), params())).status).toBe(200);
  });
  it.each([["Markdown", postMd], ["PDF", postPdf]] as const)("%s 检查脱敏替换后的实际输出", async (_, post) => {
    data.modules = [{ key: "summary", type: "summary", label: "简介", sort: 0, content: { text: "保密成果" } }];
    const res = await post(new Request("http://localhost/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      anonymizeConfig: { ...DEFAULT_ANONYMIZE_CONFIG, customRules: [{ id: "1", source: "保密成果", replacement: "[待确认示例：30%]" }] },
    }) }), params());
    expect(res.status).toBe(409);
  });
});
