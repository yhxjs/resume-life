import { resolveStyle } from "@/lib/templates";
import { describe, it, expect } from "vitest";
import { anonymizeProjectSummary, processPortfolioAnonymization } from "../portfolio-anonymize";
import type { AssembledPortfolioData } from "../portfolio-types";
import { DEFAULT_ANONYMIZE_CONFIG } from "../resume-anonymize";
import { createPortfolioZip } from "../portfolio-generator";
import JSZip from "jszip";

describe("portfolio-anonymize", () => {
  it.each(["标题", "富文本", "项目总结"])("%s 的脱敏替换在超出预算前中止", (surface) => {
    const data: AssembledPortfolioData = {
      siteTitle: surface === "标题" ? "x".repeat(1500) : "作品集", siteSubtitle: "", accentColor: "#123456", themeMode: "auto",
      anonymizeConfig: { ...DEFAULT_ANONYMIZE_CONFIG, customRules: [{ id: "expand", source: "x", replacement: "y".repeat(4000) }] },
      resumeSnapshot: { resolved_style: resolveStyle("classic", []), title: "简历", template: "classic", style_overrides: {}, modules: surface === "富文本"
        ? [{ key: "summary", type: "summary", label: "自评", sort: 0, content: { text: `<strong>${"x".repeat(1500)}</strong>` } }] : [] },
      projects: surface === "项目总结" ? [{ id: 1, name: "项目", customLinks: {}, featured: true,
        summary: { overview: "x".repeat(1500), architecture: "", highlights: "", responsibilities: "", challenges: "", techStack: "", brief: "", achievements: [] } }] : [],
    };
    expect(() => processPortfolioAnonymization(data)).toThrow(expect.objectContaining({ status: 413 }));
  });

  it("自定义姓名占位符中的 $& 不会恢复标题原姓名", () => {
    const safe = processPortfolioAnonymization({
      siteTitle: "张小明的作品集", siteSubtitle: "张小明的展示", accentColor: "#2563eb", themeMode: "auto",
      anonymizeConfig: { ...DEFAULT_ANONYMIZE_CONFIG, name: { enabled: true, mode: "placeholder", customPlaceholder: "Candidate $&" } },
      resumeSnapshot: { resolved_style: resolveStyle("classic", []), title: "张小明的简历", template: "classic", style_overrides: {},
        modules: [{ key: "basic", type: "basic", label: "基本信息", sort: 0, content: { name: "张小明" } }] },
      projects: [],
    });
    expect(safe.siteTitle).toBe("Candidate $&的作品集");
    expect(safe.resumeSnapshot.title).not.toContain("张小明");
  });
  it("最终 ZIP 的标题字段不保留原姓名或自定义敏感词", async () => {
    const originalName = "审计测试人甲";
    const data: AssembledPortfolioData = {
      siteTitle: `${originalName}的作品集`,
      siteSubtitle: `${originalName} · 秘密项目`,
      accentColor: "#2563eb",
      themeMode: "auto",
      anonymizeConfig: { ...DEFAULT_ANONYMIZE_CONFIG, customRules: [{ id: "project", source: "秘密项目", replacement: "公开项目" }] },
      resumeSnapshot: { resolved_style: resolveStyle("classic", []),
        title: `${originalName} · 秘密项目`, template: "classic", style_overrides: {},
        modules: [{ key: "basic", type: "basic", label: "基本信息", sort: 0, content: { name: originalName } }],
      },
      projects: [],
    };
    const safe = processPortfolioAnonymization(data);
    expect(safe.resumeSnapshot.title).not.toContain(originalName);
    const zip = await JSZip.loadAsync(await createPortfolioZip(safe));
    for (const item of Object.values(zip.files).filter((item) => !item.dir)) {
      const text = await item.async("string");
      expect(text).not.toContain(originalName);
      expect(text).not.toContain("秘密项目");
    }
    expect(data.siteTitle).toContain(originalName);
  });
  it("应正确清洗项目总结中的敏感词", () => {
    const rawSummary = {
      overview: "负责腾讯云后台架构开发",
      architecture: "采用微信支付专线微服务",
      highlights: "日交易额破亿",
      responsibilities: "核心研发负责人",
      challenges: "突破跨机房网络延迟瓶颈",
      techStack: "Go, Kubernetes",
      brief: "架构师",
      achievements: ["稳定性 99.99%"],
    };

    const config = {
      ...DEFAULT_ANONYMIZE_CONFIG,
      customRules: [
        { id: "1", source: "腾讯云", replacement: "[某头部云厂商]" },
        { id: "2", source: "微信支付", replacement: "[某核心支付系统]" },
      ],
    };

    const safe = anonymizeProjectSummary(rawSummary, config);

    expect(safe.overview).toBe("负责[某头部云厂商]后台架构开发");
    expect(safe.architecture).toBe("采用[某核心支付系统]专线微服务");
    expect(safe.highlights).toBe("日交易额破亿");
  });

  it("应全面脱敏个人信息与模块数据", () => {
    const data: AssembledPortfolioData = {
      siteTitle: "个人作品集",
      siteSubtitle: "全栈工程师",
      accentColor: "#2563eb",
      themeMode: "auto",
      anonymizeConfig: {
        ...DEFAULT_ANONYMIZE_CONFIG,
        name: { enabled: true, mode: "surname_only" },
        phone: { enabled: true, mode: "prefix_only" },
        email: { enabled: true, mode: "mask_account" },
      },
      resumeSnapshot: { resolved_style: resolveStyle("classic", []),
        title: "张三的简历",
        template: "classic",
        style_overrides: {},
        modules: [
          {
            key: "basic",
            type: "basic",
            label: "基本信息",
            sort: 0,
            content: {
              name: "张小明",
              title: "前端工程师",
              phone: "13800138000",
              email: "xiaoming@example.com",
            },
          },
        ],
      },
      projects: [],
    };

    const processed = processPortfolioAnonymization(data);
    expect(processed.candidateName).toBe("张**");
    const safeBasic = processed.resumeSnapshot.modules[0]?.content as Record<string, string>;
    expect(safeBasic.phone).toBe("138********");
    expect(safeBasic.email).toContain("*");
  });
});
