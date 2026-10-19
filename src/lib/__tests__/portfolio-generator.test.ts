import { describe, it, expect, vi } from "vitest";
import JSZip from "jszip";
import {
  generatePortfolioHtml,
  generatePortfolioCss,
  generateStandaloneResumeHtml,
  generateResumeMarkdown,
  generatePortfolioPreviewHtml,
  createPortfolioZip,
} from "../portfolio-generator";
import type { SafePortfolioData } from "../portfolio-anonymize";
import { DEFAULT_ANONYMIZE_CONFIG } from "../resume-anonymize";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { prepare, ResumeDoc } from "@/components/resume/doc";
import { BUILTIN_STYLES, TEMPLATE_KEYS, resolveStyle } from "../templates";

describe("portfolio-generator", () => {
  const sampleData: SafePortfolioData = {
    siteTitle: "李某某的工程作品集",
    siteSubtitle: "全栈架构与高并发系统",
    accentColor: "#2563eb",
    themeMode: "auto",
    candidateName: "李**",
    candidateTitle: "资深工程师",
    anonymizeConfig: DEFAULT_ANONYMIZE_CONFIG,
    resumeSnapshot: { resolved_style: resolveStyle("classic", []),
      title: "资深全栈工程师简历",
      template: "classic",
      style_overrides: {},
      modules: [
        {
          key: "basic",
          type: "basic",
          label: "基本信息",
          sort: 0,
          content: { name: "李**", title: "资深工程师" },
        },
        {
          key: "skills",
          type: "skills",
          label: "专业技能",
          sort: 1,
          content: { items: ["TypeScript", "Next.js", "SQLite", "Node.js"] },
        },
      ],
    },
    projects: [
      {
        id: 1,
        name: "高并发支付网关",
        featured: true,
        customLinks: {
          demoUrl: "https://demo.example.com",
          repoUrl: "https://github.com/example/gateway",
        },
        summary: {
          overview: "基于 Node.js 的微服务支付网关",
          architecture: "事件驱动与响应式架构",
          highlights: "QPS 突破 50000",
          responsibilities: "主导核心设计",
          challenges: "跨机房分布式锁一致性",
          techStack: "Node.js",
          brief: "网关",
          achievements: [],
        },
        safeSummary: {
          overview: "基于 Node.js 的微服务支付网关",
          architecture: "事件驱动与响应式架构",
          highlights: "QPS 突破 50000",
          responsibilities: "主导核心设计",
          challenges: "跨机房分布式锁一致性",
          techStack: "Node.js",
          brief: "网关",
          achievements: [],
        },
      },
    ],
  };

  it.each(["ordered", "unordered"] as const)("自我评价 %s 列表在主页、离线简历与 Markdown 中保持一致", (descriptionStyle) => {
    const data: SafePortfolioData = { ...sampleData, resumeSnapshot: { ...sampleData.resumeSnapshot, modules: [
      { key: "summary", type: "summary", label: "自我评价", sort: 0, content: {
        text: "<strong>第一项</strong>\n第二项",
        descriptionItems: ["<strong>第一项</strong>", "第二项"], descriptionStyle,
      } },
    ] } };
    const tag = descriptionStyle === "ordered" ? "ol" : "ul";
    expect(generatePortfolioHtml(data)).toContain(`<${tag}><li><strong>第一项</strong></li><li>第二项</li></${tag}>`);
    expect(generateStandaloneResumeHtml(data)).toMatch(new RegExp(`<${tag}\\b`));
    expect(generateResumeMarkdown(data)).toContain(descriptionStyle === "ordered" ? "1. **第一项**\n2. 第二项" : "- **第一项**\n- 第二项");
  });

  it("应生成自包含、转义安全的静态 HTML", () => {
    const html = generatePortfolioHtml(sampleData);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("李某某的工程作品集");
    expect(html).toContain("李**");
    expect(html).toContain("高并发支付网关");
    expect(html).toContain("https://demo.example.com");
    expect(html).toContain("assets/style.css");
    expect(html).toContain("assets/app.js");
  });

  it.each(TEMPLATE_KEYS)("脱敏在线简历沿用 %s 模板及简历级样式", (template) => {
    const snapshot = { ...sampleData.resumeSnapshot, template,
      style_overrides: { baseSize: 13, sectionGapBefore: 19, accent: "#ab2345" },
    };
    snapshot.resolved_style = resolveStyle(template, [], snapshot.style_overrides);
    const html = generateStandaloneResumeHtml({ ...sampleData, resumeSnapshot: snapshot });
    const expected = renderToStaticMarkup(createElement(ResumeDoc, {
      prepared: prepare(snapshot.title, snapshot.modules),
      style: resolveStyle(template, [], snapshot.style_overrides),
    }));
    expect(html).toContain(expected);
    expect(html).toContain("width: 210mm");
    expect(html).not.toContain("脱敏版离线简历</div>");
  });

  it("脱敏在线简历使用版本冻结的完整自定义样式", () => {
    const style = { ...BUILTIN_STYLES.banner_twocol, accent: "#ab2345", baseSize: 13,
      asidePosition: "left" as const, asideWidth: 62, asideModules: ["skills"], font: "serif" as const,
    };
    const snapshot = { ...sampleData.resumeSnapshot, template: "custom:999", resolved_style: style,
      style_overrides: { accent: "#000000" },
    };
    const expected = renderToStaticMarkup(createElement(ResumeDoc, {
      prepared: prepare(snapshot.title, snapshot.modules), style,
    }));
    expect(generateStandaloneResumeHtml({ ...sampleData, resumeSnapshot: snapshot })).toContain(expected);
  });

  it("主页以简历项目经历为主体，不展示项目库的五维技术复盘", () => {
    const data: SafePortfolioData = { ...sampleData, resumeSnapshot: { ...sampleData.resumeSnapshot,
      modules: [...sampleData.resumeSnapshot.modules, { key: "projects", type: "projects", label: "项目经历", sort: 2,
        content: [{ id: "p1", name: "协作平台", role: "前端开发", start: "2023", end: "2024", descriptionItems: ["负责协作模块交付"], descriptionStyle: "unordered" }] }],
    } };
    const html = generatePortfolioHtml(data);
    expect(html).toContain("协作平台");
    expect(html).toContain("负责协作模块交付");
    expect(html).not.toContain("查看技术细节");
    expect(html).not.toContain("事件驱动与响应式架构");
    expect(html).toContain('id="resume-scene"');
    expect(html).toContain('data-reveal');
  });

  it("真实预览与导出复用相同页面，只将 CSS 和脚本内联", () => {
    const html = generatePortfolioHtml(sampleData);
    const preview = generatePortfolioPreviewHtml(sampleData);
    expect(preview).toContain(`<style>${generatePortfolioCss(sampleData.accentColor)}</style>`);
    expect(preview).toContain('id="resume-scene"');
    expect(preview).not.toContain('src="assets/app.js"');
    expect(preview.replace(/<style>[\s\S]*?<\/style>/, '<link rel="stylesheet" href="assets/style.css" />')
      .replace(/<script>[\s\S]*?<\/script>/, '<script src="assets/app.js"></script>')).toBe(html);
  });

  it.each(["focus", "chronicle", "sidebar"] as const)("%s 主页模板贯穿预览与 ZIP，完整简历样式独立保留", async (siteTemplate) => {
    const data = { ...sampleData, siteTemplate };
    const zip = await JSZip.loadAsync(await createPortfolioZip(data));
    const html = await zip.file("index.html")!.async("string");
    const css = await zip.file("assets/style.css")!.async("string");
    const js = await zip.file("assets/app.js")!.async("string");
    expect(html).toContain(`data-template="${siteTemplate}"`);
    expect(css).toContain(`[data-template="${siteTemplate}"]`);
    expect(js).toContain(`var scene = '${siteTemplate}'`);
    expect(generatePortfolioPreviewHtml(data)).toBe(html
      .replace('<link rel="stylesheet" href="assets/style.css" />', () => `<style>${css}</style>`)
      .replace('<script src="assets/app.js"></script>', () => `<script>${js}</script>`));
    expect(await zip.file("resume.html")!.async("string")).toBe(generateStandaloneResumeHtml(sampleData));
  });

  it("应对潜在 XSS 脚本做严密实体转义", () => {
    const maliciousData: SafePortfolioData = {
      ...sampleData,
      siteTitle: '测试<script>alert("XSS")</script>',
      candidateName: '"><img src=x onerror=alert(1)>',
    };
    const html = generatePortfolioHtml(maliciousData);
    expect(html).not.toContain('<script>alert("XSS")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("应生成包含深浅色主题变量的纯净 CSS", () => {
    const css = generatePortfolioCss("#10b981");
    expect(css).toContain(":root {");
    expect(css).toContain('[data-theme="dark"] {');
    expect(css).toContain("#10b981");
    // 确保没有外部 CDN 引入
    expect(css).not.toContain("http://");
    expect(css).not.toContain("https://");
  });

  it("应将简历字段排版为主页、离线页面和 Markdown 正文", () => {
    const data: SafePortfolioData = {
      ...sampleData,
      resumeSnapshot: {
        ...sampleData.resumeSnapshot,
        modules: [
          { key: "basic", type: "basic", label: "基本信息", sort: 0, content: {
            name: "李**", phone: "181********", email: "l***@example.com", location: "厦门",
          } },
          { key: "education", type: "education", label: "教育经历", sort: 1, content: [
            { id: "e1", school: "福州大学", degree: "本科", field: "计算机科学", start: "2019", end: "2023", description: "专业排名前 20%" },
          ] },
          { key: "work", type: "work", label: "工作经历", sort: 2, content: [
            { id: "w1", company: "微财数科", title: "Java 开发工程师", start: "2024", end: "至今",
              description: "旧描述", descriptionItems: ["服务可用率 <strong>99.9%</strong>", "支持日均 3 万+ 咨询"],
              descriptionStyle: "unordered", subItems: [{ id: "s1", label: "方向", value: "客服系统" }],
            },
          ] },
          { key: "skills", type: "skills", label: "专业技能", sort: 3, content: { items: ["TypeScript", "SQLite"] } },
          { key: "summary", type: "summary", label: "自我评价", sort: 4, content: { text: "注重<strong>可靠性</strong>" } },
        ],
      },
    };

    const home = generatePortfolioHtml(data);
    expect(home).toContain("微财数科");
    expect(home).toContain("福州大学");
    expect(home).toContain("2024 ~ 至今");

    const html = generateStandaloneResumeHtml(data);
    expect(html).toContain("181********");
    expect(html).toContain("福州大学");
    expect(html).toContain("专业排名前 20%");
    expect(html).toContain("微财数科");
    expect(html).toContain('服务可用率 <strong style="font-weight:600">99.9%</strong>');
    expect(html).toContain("方向");
    expect(html).toContain('注重<strong style="font-weight:600">可靠性</strong>');
    expect(html).not.toContain('"company":');
    expect(html).not.toContain("&lt;strong&gt;");

    const markdown = generateResumeMarkdown(data);
    expect(markdown).toContain("### 福州大学 | 本科 | 计算机科学");
    expect(markdown).toContain("专业排名前 20%");
    expect(markdown).toContain("### 微财数科 | Java 开发工程师");
    expect(markdown).toContain("- 服务可用率 **99.9%**");
    expect(markdown).toContain("- TypeScript");
    expect(markdown).not.toContain("```json");
    expect(markdown).not.toContain('"company":');
  });

  it("离线简历应保留安全加粗并移除可执行标签", () => {
    const data: SafePortfolioData = {
      ...sampleData,
      resumeSnapshot: {
        ...sampleData.resumeSnapshot,
        modules: [{ key: "summary", type: "summary", label: "自我评价", sort: 0,
          content: { text: "注重<strong>交付</strong><img src=x onerror=alert(1)>" } }],
      },
    };

    const html = generateStandaloneResumeHtml(data);
    expect(html).toContain('注重<strong style="font-weight:600">交付</strong>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=");
  });

  it("应打包出结构完整的静态站点 Zip 文件", async () => {
    const buffer = await createPortfolioZip(sampleData);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file("index.html")).toBeDefined();
    expect(zip.file("resume.html")).toBeDefined();
    expect(zip.file("resume.md")).toBeDefined();
    expect(zip.file("README.md")).toBeDefined();
    expect(zip.file("assets/style.css")).toBeDefined();
    expect(zip.file("assets/app.js")).toBeDefined();

    const readmeContent = await zip.file("README.md")?.async("string");
    expect(readmeContent).toContain("GitHub Pages");

    const resumeHtml = await zip.file("resume.html")?.async("string");
    const resumeMd = await zip.file("resume.md")?.async("string");
    expect(resumeHtml).toBe(generateStandaloneResumeHtml(sampleData));
    expect(resumeHtml).toContain("TypeScript ｜ Next.js ｜ SQLite ｜ Node.js");
    expect(resumeHtml).not.toContain('"items":');
    expect(resumeMd).toContain("- TypeScript");
    expect(resumeMd).not.toContain("```json");
  });

  it("HTML 实体展开超预算时在压缩前拒绝", async () => {
    const compress = vi.spyOn(JSZip.prototype, "generateAsync");
    try {
      // 原始文本小于 4 MiB；主页和离线简历中的 & 被展开为 &amp;。
      const data: SafePortfolioData = { ...sampleData, siteTitle: "&".repeat(3_500_000) };
      await expect(createPortfolioZip(data)).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/生成文件.*过大/) });
      expect(compress).not.toHaveBeenCalled();
    } finally {
      compress.mockRestore();
    }
  });

  it("已取消的导出不开始生成和压缩", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createPortfolioZip(sampleData, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
