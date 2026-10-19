import { beforeEach, describe, expect, it, vi } from "vitest";
import mammoth from "mammoth";
import { GET, POST } from "../route";
import { loadResume, type ResumeWithModules } from "@/lib/resumes";
import { defaultContent } from "@/lib/modules";
import { DEFAULT_ANONYMIZE_CONFIG } from "@/lib/resume-anonymize";
import { inspectResumeForExport } from "@/lib/resume-export-check";
import { readUploadFile } from "@/lib/upload-storage";
import JSZip from "jszip";
import sharp from "sharp";

vi.mock("@/lib/resumes", () => ({ loadResume: vi.fn() }));
vi.mock("@/lib/upload-storage", () => ({
  uploadPathFromUrl: vi.fn((url: string) => url.startsWith("/api/uploads/") ? `D:/uploads/${url.split("/").pop()}` : null),
  readUploadFile: vi.fn(() => null),
}));

let data: ResumeWithModules;
const context = (id = "1") => ({ params: Promise.resolve({ id }) });
const post = (body: unknown = {}) => new Request("http://localhost/api/resumes/1/export/docx", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  data = {
    resume: { id: 1, title: "张三的简历", template: "classic", style_overrides: {}, created_at: "", updated_at: "" },
    modules: [
      { key: "basic", type: "basic", label: "基本信息", sort: 0, content: {
        ...defaultContent("basic"), name: "张三", phone: "13800000000", email: "zhangsan@example.com",
      } },
      { key: "summary", type: "summary", label: "自我评价", sort: 1, content: { text: "擅长团队协作" } },
    ], warnings: [], corruptedKeys: [],
  };
  vi.mocked(loadResume).mockReset().mockImplementation((id) => id === 1 ? data : null);
  vi.mocked(readUploadFile).mockReset().mockReturnValue(null);
});

describe("GET/POST /api/resumes/[id]/export/docx", () => {
  it.each(["GET", "POST"])("%s 返回可读的真实 DOCX 和中文附件名", async (method) => {
    const res = method === "GET" ? await GET(new Request("http://localhost"), context()) : await POST(post(), context());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(res.headers.get("content-disposition")).toContain('filename="resume-1.docx"');
    expect(decodeURIComponent(res.headers.get("content-disposition")!)).toContain("张三的简历.docx");
    const buffer = Buffer.from(await res.arrayBuffer());
    expect(Number(res.headers.get("content-length"))).toBe(buffer.length);
    expect((await mammoth.extractRawText({ buffer })).value).toContain("擅长团队协作");
  });

  it("返回非法 ID 和不存在的简历错误", async () => {
    expect((await GET(new Request("http://localhost"), context("abc"))).status).toBe(400);
    expect((await POST(post(), context("999"))).status).toBe(404);
  });

  it("数字必须确认且 GET 不能绕过检查", async () => {
    data.modules[1]!.content = { text: "效率提升 40%" };
    expect((await GET(new Request("http://localhost"), context())).status).toBe(409);
    expect((await POST(post(), context())).status).toBe(409);
    const confirmedIssueIds = inspectResumeForExport(data).blockingIssues.map((issue) => issue.id);
    expect((await POST(post({ confirmedIssueIds }), context())).status).toBe(200);
  });

  it("残留占位符即使提交确认仍不能导出", async () => {
    data.modules[1]!.content = { text: "[待补充]" };
    const confirmedIssueIds = inspectResumeForExport(data).blockingIssues.map((issue) => issue.id);
    expect((await POST(post({ confirmedIssueIds }), context())).status).toBe(409);
  });

  it("仅明确选择跳过核对的 POST 可导出占位符", async () => {
    data.modules[1]!.content = { text: "[待补充]" };
    expect((await GET(new Request("http://localhost"), context())).status).toBe(409);
    expect((await POST(post({ skipExportCheck: "true" }), context())).status).toBe(409);
    expect((await POST(post({ skipExportCheck: true }), context())).status).toBe(200);
  });

  it("脱敏文档正文、标题和附件名不泄漏原始信息且不修改存储数据", async () => {
    data.modules[1]!.label = "Project-Zeus 简介";
    const before = structuredClone(data);
    const res = await POST(post({ anonymizeConfig: { ...DEFAULT_ANONYMIZE_CONFIG,
      customRules: [{ id: "r1", source: "Project-Zeus", replacement: "保密系统" }],
    } }), context());
    expect(res.status).toBe(200);
    const text = (await mammoth.extractRawText({ buffer: Buffer.from(await res.arrayBuffer()) })).value;
    expect(text).toContain("张*");
    expect(text).toContain("保密系统 简介");
    for (const secret of ["张三", "13800000000", "zhangsan@example.com", "Project-Zeus"]) {
      expect(text).not.toContain(secret);
      expect(decodeURIComponent(res.headers.get("content-disposition")!)).not.toContain(secret);
    }
    expect(data).toEqual(before);
  });

  it("脱敏替换结果中的占位符仍然阻断导出", async () => {
    const res = await POST(post({ anonymizeConfig: { ...DEFAULT_ANONYMIZE_CONFIG,
      customRules: [{ id: "r1", source: "擅长团队协作", replacement: "[待补充]" }],
    } }), context());
    expect(res.status).toBe(409);
  });

  it("内置横幅模板嵌入已保存的头像；默认脱敏导出会剥离头像", async () => {
    data.resume.template = "banner_navy";
    data.modules[0]!.content = { ...defaultContent("basic"), name: "张三", avatar: "/api/uploads/photo.webp" };
    const webp = await sharp({ create: { width: 96, height: 96, channels: 3, background: "#ff0000" } }).webp().toBuffer();
    vi.mocked(readUploadFile).mockReturnValue({ bytes: webp, contentType: "image/webp" });

    const regular = await POST(post(), context());
    expect(regular.status).toBe(200);
    const regularZip = await JSZip.loadAsync(Buffer.from(await regular.arrayBuffer()));
    expect(Object.keys(regularZip.files).some((name) => /^word\/media\/.*\.png$/.test(name))).toBe(true);
    expect(await regularZip.file("word/document.xml")!.async("string")).toContain('w:fill="1E3A8A"');
    expect(readUploadFile).toHaveBeenCalledWith("photo.webp");

    const masked = await POST(post({ anonymizeConfig: DEFAULT_ANONYMIZE_CONFIG }), context());
    expect(masked.status).toBe(200);
    const maskedZip = await JSZip.loadAsync(Buffer.from(await masked.arrayBuffer()));
    expect(Object.keys(maskedZip.files).some((name) => name.startsWith("word/media/"))).toBe(false);
  });

  it("无效 JSON 不静默回退为未脱敏下载", async () => {
    const req = new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect((await POST(req, context())).status).toBe(400);
    expect((await POST(post(null), context())).status).toBe(400);
  });

  it("超限请求被拒绝", async () => {
    const req = new Request("http://localhost", { method: "POST", headers: {
      "Content-Type": "application/json", "Content-Length": "1048577",
    }, body: "{}" });
    expect((await POST(req, context())).status).toBe(413);
  });
});
