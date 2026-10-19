import { describe, it, expect } from "vitest";
import { chromium } from "playwright-core";
import { PDFParse } from "pdf-parse";
import { renderResumeToHtml } from "@/lib/pdf-render";
import type { ResumeWithModules } from "@/lib/resumes";
import type { ModuleData } from "@/lib/modules";

interface PdfTextItem {
  str: string;
  transform: number[];
}

interface PdfPageLike {
  getTextContent: () => Promise<{ items: (PdfTextItem | { str?: unknown; transform?: unknown })[] }>;
}

interface PdfDocLike {
  numPages: number;
  getPage: (pageNum: number) => Promise<PdfPageLike>;
}

interface PdfParserLike {
  load: () => Promise<void>;
  doc: PdfDocLike;
}

describe("PDF Pagination Spacing Verification", () => {
  const mockModulesShort: ModuleData[] = [
    {
      key: "basic",
      type: "basic",
      label: "基本信息",
      sort: 1,
      content: {
        name: "张三",
        phone: "13800138000",
        email: "zhangsan@example.com",
        location: "北京",
      },
    },
    {
      key: "skills",
      type: "skills",
      label: "专业技能",
      sort: 2,
      content: ["技能1", "技能2"],
    },
  ];

  const mockModulesLong: ModuleData[] = [
    {
      key: "basic",
      type: "basic",
      label: "基本信息",
      sort: 1,
      content: {
        name: "张三",
        phone: "13800138000",
        email: "zhangsan@example.com",
        location: "北京",
      },
    },
    {
      key: "skills",
      type: "skills",
      label: "专业技能",
      sort: 2,
      content: [
        "Java 核心：精通 Java 语法，集合框架，并发编程及 JVM 调优机制与垃圾回收策略。",
        "框架与中间件：深入理解 Spring Boot、Spring Cloud、Dubbo 微服务生态及底层原理。",
        "存储与缓存：熟练掌握 MySQL 数据库设计、SQL 性能调优，熟练掌握 Redis 缓存设计与高可用架构。",
        "消息队列：掌握 Kafka、RocketMQ 消息中间件，具备消息幂等性与分布式事务处理经验。",
        "前端与测试：了解 Vue.js，熟悉 Postman、Knife4j、JMeter 等接口调试与测试工具。",
        "部署与其他：了解 Tomcat、Nginx 及 Lua，具备应用部署与线上问题排查经验。",
      ],
    },
    {
      key: "self",
      type: "summary",
      label: "自我评价",
      sort: 3,
      content:
        "具备企业级 Java 后端开发经验，参与客服系统多个核心模块建设，覆盖话务与 IVR、工单自动化、实时监控、外部系统接入及 AI 辅助等场景。熟悉 Spring Boot、Dubbo、Kafka、Redis、MySQL/MyBatis，具备消息幂等、并发一致性、任务补偿及实时推送等实践经验，能够完成需求分析、方案设计、编码测试、上线维护与线上问题排查。",
    },
    {
      key: "work",
      type: "work",
      label: "工作经历",
      sort: 4,
      content: Array.from({ length: 14 }).map((_, i) => ({
        company: `某某科技集团有限公司第 ${i + 1} 事业部`,
        title: "资深 Java 后端开发工程师",
        start: "2020-03",
        end: "2023-08",
        description:
          "负责核心系统的微服务设计与研发，主导架构重构，性能提升30%，支撑千万级DAU稳定运行。\n1. 负责消息队列集群治理与消息幂等性方案落地；\n2. 优化高并发场景下的MySQL连接池与慢查询索引；\n3. 搭建线上故障全链路排查平台并制定SOP。",
      })),
    },
  ];

  async function generateAndAnalyzePdf(data: ResumeWithModules) {
    const html = renderResumeToHtml(data, []);

    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
    });
    await browser.close();

    const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) }) as unknown as PdfParserLike;
    await parser.load();
    const doc = parser.doc;

    const pageStats: { pageNum: number; topDistanceMm: number; bottomDistanceMm: number; topText: string; bottomText: string }[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const tc = await p.getTextContent();
      const items = tc.items
        .filter((it): it is PdfTextItem => typeof it.str === "string" && it.str.trim().length > 0 && Array.isArray(it.transform))
        .map((it) => ({ text: it.str.trim(), y: it.transform[5] ?? 0 }));
      items.sort((a, b) => b.y - a.y);
      const topDistancePt = 841.89 - (items[0]?.y ?? 0);
      const topDistanceMm = (topDistancePt * 25.4) / 72;
      const bottomDistancePt = items[items.length - 1]?.y ?? 0;
      const bottomDistanceMm = (bottomDistancePt * 25.4) / 72;
      pageStats.push({
        pageNum: i,
        topDistanceMm,
        bottomDistanceMm,
        topText: items[0]?.text || "",
        bottomText: items[items.length - 1]?.text || "",
      });
    }
    return { numPages: doc.numPages, pageStats };
  }

  it("Classic template 1-page stays 1 page", async () => {
    const data: ResumeWithModules = {
      resume: { id: 1, title: "经典单页", template: "classic", style_overrides: {}, created_at: "", updated_at: "" },
      modules: mockModulesShort,
      warnings: [],
      corruptedKeys: [],
    };
    const res = await generateAndAnalyzePdf(data);
    expect(res.numPages).toBe(1);
    expect(res.pageStats[0]?.topDistanceMm).toBeGreaterThanOrEqual(11);
    expect(res.pageStats[0]?.bottomDistanceMm).toBeGreaterThanOrEqual(11);
  }, 60_000);

  it("Modern template multi-page has top and bottom margin on every page", async () => {
    const data: ResumeWithModules = {
      resume: { id: 2, title: "现代多页", template: "modern", style_overrides: {}, created_at: "", updated_at: "" },
      modules: mockModulesLong,
      warnings: [],
      corruptedKeys: [],
    };
    const res = await generateAndAnalyzePdf(data);
    expect(res.numPages).toBeGreaterThanOrEqual(2);
    for (const stat of res.pageStats) {
      expect(stat.topDistanceMm).toBeGreaterThanOrEqual(11);
      expect(stat.bottomDistanceMm).toBeGreaterThanOrEqual(11);
    }
  }, 60_000);

  it("Banner template multi-page has top and bottom margin on every page", async () => {
    const data: ResumeWithModules = {
      resume: { id: 3, title: "横幅多页", template: "banner_navy", style_overrides: {}, created_at: "", updated_at: "" },
      modules: mockModulesLong,
      warnings: [],
      corruptedKeys: [],
    };
    const res = await generateAndAnalyzePdf(data);
    expect(res.numPages).toBeGreaterThanOrEqual(2);
    for (const stat of res.pageStats) {
      if (stat.pageNum > 1) {
        expect(stat.topDistanceMm).toBeGreaterThanOrEqual(11);
      }
      expect(stat.bottomDistanceMm).toBeGreaterThanOrEqual(11);
    }
  }, 60_000);

  it("Long entry splits across pages without leaving huge blank bottom space on page 1", async () => {
    const data: ResumeWithModules = {
      resume: { id: 4, title: "长项目跨页", template: "banner_navy", style_overrides: {}, created_at: "", updated_at: "" },
      modules: [
        {
          key: "basic",
          type: "basic",
          label: "基本信息",
          sort: 1,
          content: { name: "李四", phone: "13800138000", email: "lisi@example.com" },
        },
        {
          key: "self",
          type: "summary",
          label: "自我评价",
          sort: 2,
          content: "具备企业级 Java 后端开发经验，参与客服系统与信贷系统多个核心模块建设，熟悉 Spring Boot、Dubbo、Kafka、Redis、MySQL/MyBatis，具备消息幂等、并发一致性、任务补偿及实时推送等实践经验。",
        },
        {
          key: "work",
          type: "work",
          label: "工作经历",
          sort: 3,
          content: Array.from({ length: 4 }).map((_, i) => ({
            company: `某某互联网金融有限公司事业部 ${i + 1}`,
            title: "Java 开发工程师",
            start: "2021-07",
            end: "2023-08",
            description: "负责核心系统的微服务设计与研发，主导架构重构。\n1. 负责消息队列集群治理与消息幂等性方案落地；\n2. 优化高并发场景下的MySQL连接池与慢查询索引；\n3. 搭建线上故障全链路排查平台并制定SOP；\n4. 支撑千万级DAU稳定运行。",
          })),
        },
        {
          key: "projects",
          type: "projects",
          label: "项目经历",
          sort: 4,
          content: [
            {
              name: "获客API平台与信贷核心系统",
              role: "核心研发",
              start: "2023-08",
              end: "2024-05",
              description: Array.from({ length: 12 })
                .map((_, i) => `${i + 1}. 主导助贷核心架构设计与流程编排落地，负责第${i + 1}阶段接口高并发改造，通过异步化与缓存优化支撑日均百万级并发请求，实现全链路灰度与降级容灾方案。`)
                .join("\n"),
            },
            {
              name: "商业化运营中台与流量投放系统",
              role: "核心研发",
              start: "2024-06",
              end: "2025-01",
              description: "主导商业化运营中台重构与迭代。\n1. 构建灵活的AB实验与规则引擎；\n2. 支撑日常上万次动态决策与投放流转。",
            },
          ],
        },
      ],
      warnings: [],
      corruptedKeys: [],
    };
    const res = await generateAndAnalyzePdf(data);
    expect(res.numPages).toBeGreaterThanOrEqual(2);
    // 第一页底部应当自然填充分页，底部距离不能超过 45mm（避免整块推迟产生巨大空白）
    expect(res.pageStats[0]?.bottomDistanceMm).toBeLessThan(45);
  }, 60_000);
});
