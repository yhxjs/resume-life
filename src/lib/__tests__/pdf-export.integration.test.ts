import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { extractTextFromFile } from "@/lib/parse-file";
import type { ResumeWithModules } from "@/lib/resumes";

let directory: string;
let database: DatabaseSync | undefined;

beforeEach(() => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-pdf-export-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
});

afterEach(() => {
  database?.close();
  database = undefined;
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-pdf-export-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("Resume PDF Export & Re-import Pipeline", () => {
  async function customResume(style: string): Promise<number> {
    const { getDb } = await import("@/lib/db");
    database = getDb();
    database.prepare("INSERT INTO resume_templates (id, name, style, created_at, updated_at) VALUES (1, '自定义', ?, '', '')")
      .run(style);
    const row = database.prepare("INSERT INTO resumes (title, template, created_at, updated_at) VALUES ('待导出', 'custom:1', '', '') RETURNING id")
      .get() as { id: number };
    return row.id;
  }

  it("自定义模板 JSON 损坏时导出失败，不生成经典版 PDF", async () => {
    const resumeId = await customResume("{broken");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { GET } = await import("@/app/api/resumes/[id]/export/pdf/route");
      const response = await GET(new Request(`http://localhost/api/resumes/${resumeId}/export/pdf`),
        { params: Promise.resolve({ id: String(resumeId) }) });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: expect.stringMatching(/模板.*损坏.*修复/) });
      expect(response.headers.get("Content-Type")).not.toBe("application/pdf");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("自定义模板样式不是对象时导出失败", async () => {
    const resumeId = await customResume("null");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { GET } = await import("@/app/api/resumes/[id]/export/pdf/route");
      const response = await GET(new Request(`http://localhost/api/resumes/${resumeId}/export/pdf`),
        { params: Promise.resolve({ id: String(resumeId) }) });
      expect(response.status).toBe(422);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("内置模板导出不受无关自定义模板坏记录影响", async () => {
    const customId = await customResume("{broken");
    database!.prepare("UPDATE resumes SET template = 'classic' WHERE id = ?").run(customId);
    const { GET } = await import("@/app/api/resumes/[id]/export/pdf/route");
    const response = await GET(new Request(`http://localhost/api/resumes/${customId}/export/pdf`),
      { params: Promise.resolve({ id: String(customId) }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
  }, 30_000);

  it("有效自定义模板导出不受无关坏记录影响", async () => {
    const resumeId = await customResume("{}");
    database!.prepare("INSERT INTO resume_templates (id, name, style, created_at, updated_at) VALUES (2, '损坏', '{broken', '', '')").run();
    const { GET } = await import("@/app/api/resumes/[id]/export/pdf/route");
    const response = await GET(new Request(`http://localhost/api/resumes/${resumeId}/export/pdf`),
      { params: Promise.resolve({ id: String(resumeId) }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
  }, 30_000);

  it("PDF 不请求外部头像地址，也不把它写入 HTML", async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end("not an image");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server port");
      const externalAvatar = `http://127.0.0.1:${address.port}/avatar.png`;
      const { renderResumeToHtml, generateResumePdf } = await import("@/lib/pdf-render");
      const data: ResumeWithModules = {
        resume: { id: 1, title: "头像边界", template: "classic", style_overrides: {}, created_at: "", updated_at: "" },
        modules: [{ key: "basic", type: "basic", label: "基本信息", sort: 0, content: { name: "测试", avatar: externalAvatar } }],
        warnings: [], corruptedKeys: [],
      };
      const html = renderResumeToHtml(data, []);
      await generateResumePdf(html);
      await generateResumePdf(`<html><body><img src="${externalAvatar}"></body></html>`);
      expect(html).not.toContain(externalAvatar);
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("本站上传头像仍内嵌到 PDF", async () => {
    const { saveUploadFile } = await import("@/lib/upload-storage");
    const file = await saveUploadFile(Buffer.from("89504e470d0a1a0a", "hex"), ".png");
    const { renderResumeToHtml } = await import("@/lib/pdf-render");
    const data: ResumeWithModules = {
      resume: { id: 1, title: "上传头像", template: "classic", style_overrides: {}, created_at: "", updated_at: "" },
      modules: [{ key: "basic", type: "basic", label: "基本信息", sort: 0, content: { name: "测试", avatar: file.url } }],
      warnings: [], corruptedKeys: [],
    };
    const html = renderResumeToHtml(data, []);
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toContain(file.url);
    data.modules[0] = { ...data.modules[0]!, content: { name: "测试", avatar: `${file.url}?v=8f130bae-f339-493b-a69b-b41d9f471323` } };
    const versionedHtml = renderResumeToHtml(data, []);
    expect(versionedHtml).toContain("data:image/png;base64,");
    expect(versionedHtml).not.toContain(file.url);
  });

  it("自定义模板查询失败时导出失败，不生成经典版 PDF", async () => {
    const resumeId = await customResume("{}");
    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (this === database && sql.startsWith("SELECT id, name, style, created_at")) {
        throw new Error("synthetic template read failure");
      }
      return originalPrepare.call(this, sql);
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { GET } = await import("@/app/api/resumes/[id]/export/pdf/route");
      const response = await GET(new Request(`http://localhost/api/resumes/${resumeId}/export/pdf`),
        { params: Promise.resolve({ id: String(resumeId) }) });
      expect(response.status).toBe(500);
      expect(response.headers.get("Content-Type")).not.toBe("application/pdf");
    } finally {
      prepareSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });

  it("导出 PDF 后能被 extractTextFromFile 成功重新读取出正文", async () => {
    const { DATA_DIR, getDb } = await import("@/lib/db");
    expect(DATA_DIR).toBe(directory);
    const db = getDb();
    database = db;
    const now = new Date().toISOString();
    const insert = db.prepare(
      "INSERT INTO resumes (title, template, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id"
    ).get("测试工程师简历", "classic", now, now) as { id: number };
    const resumeId = insert.id;
    const insertModule = db.prepare(
      "INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    insertModule.run(
      resumeId, "basic", "basic", "基本信息", 1,
      JSON.stringify({ name: "李雷", phone: "13900000000", email: "lilei@example.com" }), now,
    );
    insertModule.run(
      resumeId, "work", "work", "工作经历", 2,
      JSON.stringify([{
        company: "雷霆科技有限公司",
        title: "资深架构师",
        start: "2020-01",
        end: "2024-05",
        description: "主导微服务架构重构与自动化交付系统搭建。",
      }]), now,
    );

    const req = new Request(`http://127.0.0.1:3000/api/resumes/${resumeId}/export/pdf`);
    const { GET } = await import("@/app/api/resumes/[id]/export/pdf/route");
    const res = await GET(req, { params: Promise.resolve({ id: String(resumeId) }) });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");

    const pdfArrayBuffer = await res.arrayBuffer();
    const pdfBuffer = Buffer.from(pdfArrayBuffer);
    expect(pdfBuffer.length).toBeGreaterThan(1000);

    // 重新导入测试：使用 extractTextFromFile 解析导出的 PDF
    const extractedText = await extractTextFromFile("exported-resume.pdf", pdfBuffer);
    expect(extractedText.length).toBeGreaterThan(0);
    // 应该包含简历里的文字，而不是单纯的分页占位符
    expect(extractedText).not.toMatch(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/);
  }, 30000);

  it("renderResumeToHtml 包含 CSS Reset 与 Geist Variable 字体栈以确保样式一致", async () => {
    const { renderResumeToHtml } = await import("@/lib/pdf-render");
    const testData: ResumeWithModules = {
      resume: { id: 1, title: "测试用户", template: "banner_navy", style_overrides: {}, created_at: "", updated_at: "" },
      modules: [
        {
          key: "basic",
          type: "basic",
          label: "基本信息",
          sort: 1,
          content: { name: "测试用户", phone: "13900000000", email: "test@example.com", location: "测试城市", birthday: "", links: "" },
        },
        {
          key: "summary",
          type: "summary",
          label: "个人总结",
          sort: 2,
          content: { text: "个人总结描述内容" },
        },
      ],
      warnings: [],
      corruptedKeys: [],
    };
    const html = renderResumeToHtml(testData, []);
    // 验证包含全局 preflight reset
    expect(html).toContain("body, h1, h2, h3, h4, h5, h6, p, ul, ol");
    expect(html).toContain("margin: 0;");
    // 验证包含 Geist Variable 字体
    expect(html).toContain("Geist Variable");
    // 联系方式目前为可换行的 div；验证实际元素的样式，不绑定已移除的 p 标签。
    expect(html).toMatch(/<h1[^>]*style="[^"]*margin:\s*0/);
    const contactTag = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>\s*(<div\b[^>]*>)/)?.[1];
    expect(contactTag).toMatch(/style="[^"]*margin:\s*0(?:;|")/);
    expect(html).toContain("13900000000");
    expect(html).toContain("test@example.com");
  });
});
