// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LlmDailyTrendChart, LlmDistributionChart } from "../llm-usage-charts";
import type { LlmDailyUsage, LlmFeatureUsage, LlmModelUsage } from "@/lib/llm-call-log";

const MOCK_DAILY: LlmDailyUsage[] = [
  {
    date: "2026-10-15",
    calls: 5,
    failed: 1,
    inputTokens: 1200,
    outputTokens: 400,
    cachedTokens: 300,
  },
  {
    date: "2026-10-16",
    calls: 10,
    failed: 0,
    inputTokens: 3000,
    outputTokens: 1000,
    cachedTokens: 800,
  },
  {
    date: "2026-10-17",
    calls: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
  },
];

const MOCK_FEATURES: LlmFeatureUsage[] = [
  { feature: "简历润色", calls: 12, tokens: 12500, inputTokens: 10000, outputTokens: 2500 },
  { feature: "模拟面试", calls: 3, tokens: 4500, inputTokens: 3500, outputTokens: 1000 },
];

const MOCK_MODELS: LlmModelUsage[] = [
  { model: "claude-3-5-sonnet", calls: 10, tokens: 11000, inputTokens: 9000, outputTokens: 2000 },
  { model: "gpt-4o", calls: 5, tokens: 6000, inputTokens: 4500, outputTokens: 1500 },
];

describe("LlmDailyTrendChart 每日走势图组件", () => {
  afterEach(() => cleanup());

  it("正常渲染图表标题、SVG 及切换按钮", () => {
    render(<LlmDailyTrendChart daily={MOCK_DAILY} />);

    expect(screen.getByText("用量趋势走势")).toBeDefined();
    expect(screen.getByRole("img", { name: "每日用量趋势图" })).toBeDefined();

    const tokensBtn = screen.getByRole("button", { name: "Tokens 消耗" });
    const callsBtn = screen.getByRole("button", { name: "调用次数" });
    const barBtn = screen.getByRole("button", { name: "柱状图" });
    const areaBtn = screen.getByRole("button", { name: "平滑折线" });

    expect(tokensBtn.getAttribute("aria-pressed")).toBe("true");
    expect(callsBtn.getAttribute("aria-pressed")).toBe("false");
    expect(barBtn.getAttribute("aria-pressed")).toBe("true");
    expect(areaBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("点击切换指标与图表类型", () => {
    render(<LlmDailyTrendChart daily={MOCK_DAILY} />);

    const callsBtn = screen.getByRole("button", { name: "调用次数" });
    fireEvent.click(callsBtn);
    expect(callsBtn.getAttribute("aria-pressed")).toBe("true");

    const areaBtn = screen.getByRole("button", { name: "平滑折线" });
    fireEvent.click(areaBtn);
    expect(areaBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("无数据时展示空状态文案", () => {
    render(<LlmDailyTrendChart daily={[]} />);
    expect(screen.getByText("所选时间区间内无调用数据")).toBeDefined();
  });
});

describe("LlmDistributionChart 分布结构图组件", () => {
  afterEach(() => cleanup());

  it("正常渲染功能分布与百分比进度条", () => {
    render(<LlmDistributionChart byFeature={MOCK_FEATURES} byModel={MOCK_MODELS} />);

    expect(screen.getByText("用量分布结构")).toBeDefined();
    expect(screen.getByText("简历润色")).toBeDefined();
    expect(screen.getByText("模拟面试")).toBeDefined();

    // 默认展示功能来源
    const featureBtn = screen.getByRole("button", { name: "功能来源" });
    expect(featureBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("切换至模型规格维度展示模型数据", () => {
    render(<LlmDistributionChart byFeature={MOCK_FEATURES} byModel={MOCK_MODELS} />);

    const modelBtn = screen.getByRole("button", { name: "模型规格" });
    fireEvent.click(modelBtn);
    expect(modelBtn.getAttribute("aria-pressed")).toBe("true");

    expect(screen.getByText("claude-3-5-sonnet")).toBeDefined();
    expect(screen.getByText("gpt-4o")).toBeDefined();
  });

  it("数据为空时展示暂无分布统计记录", () => {
    render(<LlmDistributionChart byFeature={[]} byModel={[]} />);
    expect(screen.getByText("暂无分布统计记录")).toBeDefined();
  });
});
