import { describe, expect, it, vi } from "vitest";
import { GET, POST } from "../route";
import { DEFAULT_ANONYMIZE_CONFIG } from "@/lib/resume-anonymize";

import type { ResumeWithModules } from "@/lib/resumes";

const mockPdfRender = vi.hoisted(() => ({
  generateResumePdf: vi.fn(async () => Buffer.from("%PDF-1.4 mock pdf content")),
  renderResumeToHtml: vi.fn((data: ResumeWithModules) => `<html><body><h1>${data.resume.title}</h1><div>${JSON.stringify(data.modules)}</div></body></html>`),
  loadCustomTemplate: vi.fn(() => ({})),
}));

vi.mock("@/lib/pdf-render", () => ({
  generateResumePdf: mockPdfRender.generateResumePdf,
  renderResumeToHtml: mockPdfRender.renderResumeToHtml,
  loadCustomTemplate: mockPdfRender.loadCustomTemplate,
  PdfExportBusyError: class extends Error {},
  PdfExportCancelledError: class extends Error {},
  PdfExportTimeoutError: class extends Error {},
}));

vi.mock("@/lib/resumes", () => ({
  loadResume: vi.fn((id: number) => {
    if (id === 1) {
      return {
        resume: {
          id: 1,
          title: "张三的个人简历",
          template: "classic",
          created_at: "2026-01-01",
          updated_at: "2026-01-02",
        },
        modules: [
          {
            key: "basic",
            type: "basic",
            label: "基本信息",
            sort: 0,
            content: {
              name: "张三",
              phone: "13800000000",
              email: "zhangsan@example.com",
            },
          },
          {
            key: "work",
            type: "work",
            label: "Project-Zeus 工作经历",
            sort: 1,
            content: [
              {
                id: "w1",
                company: "字节跳动",
                title: "前端工程师",
                description: "主导 Project-Zeus 的研发",
              },
            ],
          },
        ],
      };
    }
    return null;
  }),
}));

describe("PDF Export Route (GET & POST)", () => {
  it("GET 请求正常返回原始 PDF 数据流", async () => {
    const req = new Request("http://localhost/api/resumes/1/export/pdf");
    const res = await GET(req, { params: Promise.resolve({ id: "1" }) });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    const disposition = res.headers.get("Content-Disposition");
    expect(disposition).toContain("filename*=UTF-8''%E5%BC%A0%E4%B8%89%E7%9A%84%E4%B8%AA%E4%BA%BA%E7%AE%80%E5%8E%86.pdf");

    // 检查给 HTML 渲染器的数据
    const lastCall = mockPdfRender.renderResumeToHtml.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const dataPassed = lastCall![0];
    expect(dataPassed.resume.title).toBe("张三的个人简历");
    expect(dataPassed.modules[1]!.label).toBe("Project-Zeus 工作经历");
    const basicContent = dataPassed.modules[0]!.content as Record<string, string>;
    expect(basicContent.name).toBe("张三");
    expect(basicContent.phone).toBe("13800000000");
  });

  it("POST 请求携带 anonymizeConfig 输出脱敏后的 PDF 并重命名", async () => {
    const req = new Request("http://localhost/api/resumes/1/export/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anonymizeConfig: {
          ...DEFAULT_ANONYMIZE_CONFIG,
          customRules: [
            { id: "1", source: "字节跳动", replacement: "[某头部大厂]" },
            { id: "2", source: "Project-Zeus", replacement: "[保密核心架构]" },
          ],
        },
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "1" }) });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");

    // 检查文件名带有 [脱敏版] 编码前缀
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(decodeURIComponent(disposition)).toContain("[脱敏版]");

    // 检查传递给 HTML 渲染器的脱敏数据
    const lastCall = mockPdfRender.renderResumeToHtml.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const dataPassed = lastCall![0];
    expect(dataPassed.resume.title).toContain("[脱敏版]");
    expect(dataPassed.modules[1]!.label).toBe("[保密核心架构] 工作经历");
    const basicContent = dataPassed.modules[0]!.content as Record<string, string>;
    expect(basicContent.name).toBe("张*");
    expect(basicContent.phone).toBe("138********");
    expect(basicContent.email).toBe("z***@example.com");

    const workPassed = (dataPassed.modules[1]!.content as Array<Record<string, string>>)[0]!;
    expect(workPassed.company).toBe("[某头部大厂]");
    expect(workPassed.description).toBe("主导 [保密核心架构] 的研发");
  });

  it("当 ID 非法时返回 400", async () => {
    const req = new Request("http://localhost/api/resumes/invalid/export/pdf");
    const res = await GET(req, { params: Promise.resolve({ id: "invalid" }) });
    expect(res.status).toBe(400);
  });
});
