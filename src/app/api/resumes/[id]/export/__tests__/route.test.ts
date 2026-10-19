import { describe, expect, it, vi } from "vitest";
import { GET, POST } from "../route";
import { DEFAULT_ANONYMIZE_CONFIG } from "@/lib/resume-anonymize";
import { loadResume } from "@/lib/resumes";
import { inspectResumeForExport } from "@/lib/resume-export-check";

vi.mock("@/lib/resumes", () => ({
  loadResume: vi.fn((id: number) => {
    if (id === 1) {
      return {
        resume: {
          id: 1,
          title: "张三的资深前端简历",
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
              location: "北京市朝阳区",
              birthday: "1995-05-20",
              links: "github.com/zhangsan",
            },
          },
          {
            key: "work",
            type: "work",
            label: "工作经历",
            sort: 1,
            content: [
              {
                id: "w1",
                company: "字节跳动",
                title: "高级前端架构师",
                start: "2022-03",
                end: "至今",
                subItems: [{ label: "核心技术栈", value: "React, Next.js, TypeScript" }],
                descriptionStyle: "unordered",
                descriptionItems: ["主导 Project-Zeus 微前端架构落地", "优化 首屏加载速度提升 50%"],
              },
            ],
          },
          {
            key: "projects",
            type: "projects",
            label: "项目经历",
            sort: 2,
            content: [
              {
                id: "p1",
                name: "简历生命周期管理平台",
                role: "核心开发者",
                start: "2023-01",
                end: "2023-12",
                descriptionStyle: "ordered",
                descriptionItems: ["负责富文本解析与 Markdown 导出模块", "完成自动化测试用例覆盖"],
              },
            ],
          },
          {
            key: "education",
            type: "education",
            label: "教育经历",
            sort: 3,
            content: [
              {
                id: "e1",
                school: "清华大学",
                degree: "硕士",
                field: "计算机科学与技术",
                start: "2018-09",
                end: "2021-06",
                description: "优秀毕业生，发表论文 2 篇",
              },
            ],
          },
          {
            key: "skills",
            type: "skills",
            label: "专业技能",
            sort: 4,
            content: {
              items: ["精通 React / Vue / TypeScript", "精通 Node.js 服务端研发"],
            },
          },
          {
            key: "summary",
            type: "summary",
            label: "自我评价",
            sort: 5,
            content: {
              text: "具备优秀的工程化思维与团队协作能力。",
            },
          },
        ],
      };
    }
    return null;
  }),
}));

describe("GET & POST /api/resumes/[id]/export", () => {
  it("POST 确认数字后成功导出完整原始简历", async () => {
    const confirmedIssueIds = inspectResumeForExport({ modules: loadResume(1)!.modules }).blockingIssues.map((issue) => issue.id);
    const req = new Request("http://localhost/api/resumes/1/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmedIssueIds }) });
    const res = await POST(req, { params: Promise.resolve({ id: "1" }) });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    const disposition = res.headers.get("Content-Disposition");
    expect(disposition).toContain('filename="resume-1.md"');
    expect(disposition).toContain("filename*=UTF-8''");

    const text = await res.text();
    expect(text).toContain("# 张三的资深前端简历");
    expect(text).toContain("张三 · 13800000000 · zhangsan@example.com · 北京市朝阳区 · 1995-05-20");
    expect(text).toContain("github.com/zhangsan");
    expect(text).toContain("字节跳动");
    expect(text).toContain("Project-Zeus");
  });

  it("POST 携带 anonymizeConfig 成功导出脱敏后的 Markdown", async () => {
    const req = new Request("http://localhost/api/resumes/1/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmedIssueIds: inspectResumeForExport({ modules: loadResume(1)!.modules }).blockingIssues.map((issue) => issue.id),
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
    const text = await res.text();

    // 标题被脱敏标识包裹
    expect(text).toContain("# [脱敏版] 张*的资深前端简历");
    // 联系信息与地址已脱敏（手机号默认只保留前三位）
    expect(text).toContain("张* · 138******** · z***@example.com · 北京市 · 1995年");
    expect(text).not.toContain("13800000000");
    expect(text).not.toContain("zhangsan@example.com");
    expect(text).not.toContain("github.com/zhangsan");

    // 经历中的敏感词被替换
    expect(text).toContain("### [某头部大厂] | 高级前端架构师");
    expect(text).toContain("[保密核心架构]");
    expect(text).not.toContain("字节跳动");
    expect(text).not.toContain("Project-Zeus");
  });

  it("当 ID 无效时返回 400", async () => {
    const req = new Request("http://localhost/api/resumes/abc/export");
    const res = await GET(req, { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("无效的简历 ID");
  });

  it("当简历不存在时返回 404", async () => {
    const req = new Request("http://localhost/api/resumes/999/export");
    const res = await GET(req, { params: Promise.resolve({ id: "999" }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("简历不存在");
  });
});
