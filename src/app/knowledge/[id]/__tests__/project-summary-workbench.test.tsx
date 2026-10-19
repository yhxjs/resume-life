// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectSummaryWorkbench } from "../project-summary-workbench";

describe("ProjectSummaryWorkbench", () => {
  afterEach(cleanup);
  it("多个成果输入可通过稳定名称定位", () => {
    render(<ProjectSummaryWorkbench summaryDraft={{ overview: "", architecture: "", highlights: "", responsibilities: "", challenges: "", techStack: "", brief: "", achievements: ["成果甲", "成果乙"] }} pendingDraft={false} summarizing={false} sumStatus={null} typewriter={{ displayedText: "", isTyping: false }} materialCount={1} onSummarize={vi.fn()} onDiscardDraft={vi.fn()} onSaveSummary={vi.fn()} onChange={vi.fn()} />);
    expect((screen.getByRole("textbox", { name: "项目成果1" }) as HTMLTextAreaElement).value).toBe("成果甲");
    expect((screen.getByRole("textbox", { name: "项目成果2" }) as HTMLTextAreaElement).value).toBe("成果乙");
  });
  it("在 summarizing 为 true 时正确渲染流式文本和分析中提示", () => {
    const html = renderToStaticMarkup(
      <ProjectSummaryWorkbench
        summaryDraft={null}
        pendingDraft={false}
        summarizing={true}
        sumStatus={null}
        typewriter={{ displayedText: "已分析业务难点：Redis 分布式锁...", isTyping: true }}
        materialCount={3}
        onSummarize={vi.fn()}
        onDiscardDraft={vi.fn()}
        onSaveSummary={vi.fn()}
        onChange={vi.fn()}
      />
    );

    expect(html).toContain("AI 架构师正在深入分析材料，构思五维 STAR 提炼与简历三要素");
    expect(html).toContain("已分析业务难点：Redis 分布式锁...");
    expect(html).toContain("max-h-56");
    expect(html).toContain("overflow-y-auto");
  });

  it("在未总结时展示生成总结引导按钮", () => {
    const html = renderToStaticMarkup(
      <ProjectSummaryWorkbench
        summaryDraft={null}
        pendingDraft={false}
        summarizing={false}
        sumStatus={null}
        typewriter={{ displayedText: "", isTyping: false }}
        materialCount={2}
        onSummarize={vi.fn()}
        onDiscardDraft={vi.fn()}
        onSaveSummary={vi.fn()}
        onChange={vi.fn()}
      />
    );

    expect(html).toContain("立即提炼五维亮点与简历三要素");
    expect(html).not.toContain("AI 架构师正在深入分析材料");
  });

  it("正确展示简历专供素材（技术栈、简要概述、成果单项列表）与五维 STAR 面板", () => {
    const html = renderToStaticMarkup(
      <ProjectSummaryWorkbench
        summaryDraft={{
          overview: "五维概述",
          architecture: "微服务",
          highlights: "优化吞吐",
          responsibilities: "技术主导",
          challenges: "复杂事务",
          techStack: "React 19, TypeScript, SQLite",
          brief: "高可用协同工作台",
          achievements: ["指标提升 40%", "重塑拖拽引擎"],
        }}
        pendingDraft={false}
        summarizing={false}
        sumStatus={null}
        typewriter={{ displayedText: "", isTyping: false }}
        materialCount={2}
        onSummarize={vi.fn()}
        onDiscardDraft={vi.fn()}
        onSaveSummary={vi.fn()}
        onChange={vi.fn()}
      />
    );

    expect(html).toContain("简历专供素材（技术栈 · 简述 · 核心成果）");
    expect(html).toContain("React 19, TypeScript, SQLite");
    expect(html).toContain("高可用协同工作台");
    expect(html).toContain("指标提升 40%");
    expect(html).toContain("重塑拖拽引擎");
    expect(html).toContain('aria-label="项目成果1"');
    expect(html).toContain('aria-label="项目成果2"');
    expect(html).toContain("STAR 结构化亮点提炼面板（深度面试备战）");
    expect(html).toContain("五维概述");
  });
});
