import { describe, expect, it } from "vitest";
import { resumeToMarkdown } from "../resume-markdown";
import type { ModuleData } from "@/lib/modules";

describe("resumeToMarkdown 纯函数测试", () => {
  it("处理空模块列表与默认标题", () => {
    const md = resumeToMarkdown("", []);
    expect(md).toBe("# 简历\n");
  });

  it("正确将完整简历模块渲染为格式化 Markdown", () => {
    const modules: ModuleData[] = [
      {
        key: "basic",
        type: "basic",
        label: "基本信息",
        sort: 0,
        content: {
          name: "王小明",
          phone: "13900001111",
          email: "wang@test.com",
          location: "北京市",
          birthday: "1996年",
          links: "https://myblog.com",
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
            company: "[某头部互联网公司]",
            title: "高级架构师",
            start: "2021-03",
            end: "2024-05",
            subItems: [{ label: "核心产品", value: "云原生微服务平台" }],
            descriptionStyle: "unordered",
            descriptionItems: ["主导整体云平台架构设计", "负责核心性能优化"],
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
            name: "[保密项目A]",
            role: "技术负责人",
            start: "2023-01",
            end: "2023-10",
            description: "负责从 0 到 1 构建高并发网关",
          },
        ],
      },
      {
        key: "skills",
        type: "skills",
        label: "专业技能",
        sort: 3,
        content: {
          items: ["TypeScript", "Next.js", "Docker"],
        },
      },
      {
        key: "summary",
        type: "summary",
        label: "自我评价",
        sort: 4,
        content: {
          text: "热爱前沿技术探索，具备深厚架构底蕴。",
        },
      },
    ];

    const md = resumeToMarkdown("王小明的架构师简历", modules);

    expect(md).toContain("# 王小明的架构师简历");
    expect(md).toContain("王小明 · 13900001111 · wang@test.com · 北京市 · 1996年");
    expect(md).toContain("https://myblog.com");

    expect(md).toContain("## 工作经历");
    expect(md).toContain("### [某头部互联网公司] | 高级架构师");
    expect(md).toContain("2021-03 ~ 2024-05");
    expect(md).toContain("**核心产品**：云原生微服务平台");
    expect(md).toContain("- 主导整体云平台架构设计");

    expect(md).toContain("## 项目经历");
    expect(md).toContain("### [保密项目A] | 技术负责人");
    expect(md).toContain("负责从 0 到 1 构建高并发网关");

    expect(md).toContain("## 专业技能");
    expect(md).toContain("- TypeScript\n- Next.js\n- Docker");

    expect(md).toContain("## 自我评价");
    expect(md).toContain("热爱前沿技术探索，具备深厚架构底蕴。");
  });

  it("基本信息中填写性别和年龄时能正确渲染进 Markdown", () => {
    const modules: ModuleData[] = [
      {
        key: "basic",
        type: "basic",
        label: "基本信息",
        sort: 0,
        content: {
          name: "李华",
          gender: "男",
          age: "28岁",
          phone: "13800002222",
          email: "lihua@example.com",
        },
      },
    ];

    const md = resumeToMarkdown("李华的简历", modules);
    expect(md).toContain("李华 · 男 · 28岁 · 13800002222 · lihua@example.com");
  });

  it("基本信息按自定义 fieldOrder 顺序输出 Markdown 页眉行", () => {
    const modules: ModuleData[] = [
      {
        key: "basic",
        type: "basic",
        label: "基本信息",
        sort: 0,
        content: {
          name: "李华",
          gender: "男",
          age: "28岁",
          location: "深圳",
          phone: "13800002222",
          email: "lihua@example.com",
          fieldOrder: ["location", "phone", "email", "gender", "age", "birthday", "links"],
        },
      },
    ];

    const md = resumeToMarkdown("李华的简历", modules);
    expect(md).toContain("李华 · 深圳 · 13800002222 · lihua@example.com · 男 · 28岁");
  });
});
