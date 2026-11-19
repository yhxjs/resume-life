// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplicationFunnelView } from "../funnel-view/application-funnel-view";
import { ApplicationDialog } from "../application-dialog";
import { calculateBatchFunnelMetrics, calculateFunnelMetrics } from "@/lib/application-funnel";
import type { FunnelApplication } from "@/lib/applications-types";
import { FunnelStrip } from "../funnel-strip";

afterEach(cleanup);

const apps: FunnelApplication[] = [{
  id: 1, stage: "applied", batch_name: "春招", hiring_stage: "resume_screening",
  terminal_stage: null, terminal_reason: "", stage_history: [],
}];

describe("履历漏斗页面", () => {
  it("展示手动批次筛选和三个招聘环节的独立结果列", () => {
    const html = renderToStaticMarkup(<ApplicationFunnelView metrics={calculateFunnelMetrics(apps)} batches={calculateBatchFunnelMetrics(apps)} />);
    for (const text of ["投递批次", "春招", "简历筛选", "技术面", "HR 面", "进行中", "已通过", "已终止", "未结算"]) expect(html).toContain(text);
    expect(html).toContain("历史记录");
    expect(html).not.toContain("简历初筛流失较大");
  });
  it("零数据不显示 NaN 或虚构的 100%", () => {
    const html = renderToStaticMarkup(<ApplicationFunnelView metrics={calculateFunnelMetrics([])} batches={[]} />);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("100%");
    expect(html).toContain("暂无投递记录");
  });
  it("空分母显示破折号，有进行中记录但没有 Offer 时显示真实 0%", () => {
    const { rerender } = render(<ApplicationFunnelView metrics={calculateFunnelMetrics([])} batches={[]} />);
    const summary = screen.getByRole("region", { name: "投递统计概览" });
    const card = (label: string) => within(summary).getByText(label, { exact: true }).parentElement!;
    expect(card("已结束记录 Offer 占比").textContent).toContain("—");
    expect(card("全部记录 Offer 占比").textContent).toContain("—");
    expect(summary.textContent).not.toContain("0%");
    rerender(<ApplicationFunnelView metrics={calculateFunnelMetrics(apps)} batches={calculateBatchFunnelMetrics(apps)} />);
    expect(card("已结束记录 Offer 占比").textContent).toContain("—");
    expect(card("全部记录 Offer 占比").textContent).toContain("0%");
    expect(card("全部记录 Offer 占比").textContent).toContain("0 / 1");
  });
  it("同企业多记录分别计数，批次切换时同步显示两个 Offer 分母", () => {
    const records = [
      { ...apps[0]!, id: 1, company: "同一公司", stage: "interested" as const },
      { ...apps[0]!, id: 2, company: "同一公司", stage: "offer" as const },
      { ...apps[0]!, id: 3, company: "同一公司", stage: "rejected" as const, batch_name: "秋招" },
    ];
    render(<ApplicationFunnelView metrics={calculateFunnelMetrics(records)} batches={calculateBatchFunnelMetrics(records)} />);
    const summary = screen.getByRole("region", { name: "投递统计概览" });
    const card = (label: string) => within(summary).getByText(label, { exact: true }).parentElement!;
    expect(card("总跟进意向/投递").textContent).toContain("3条记录");
    expect(card("已结束记录 Offer 占比").textContent).toContain("50%1 / 2");
    expect(card("全部记录 Offer 占比").textContent).toContain("33%1 / 3");
    expect(summary.textContent).toContain("含意向");
    fireEvent.change(screen.getByLabelText("投递批次"), { target: { value: JSON.stringify("春招") } });
    expect(card("总跟进意向/投递").textContent).toContain("2条记录");
    expect(card("已结束记录 Offer 占比").textContent).toContain("100%1 / 1");
    expect(card("全部记录 Offer 占比").textContent).toContain("50%1 / 2");
    fireEvent.change(screen.getByLabelText("投递批次"), { target: { value: JSON.stringify("秋招") } });
    expect(card("总跟进意向/投递").textContent).toContain("1条记录");
    expect(card("已结束记录 Offer 占比").textContent).toContain("0%0 / 1");
    expect(card("全部记录 Offer 占比").textContent).toContain("0%0 / 1");
    fireEvent.change(screen.getByLabelText("投递批次"), { target: { value: "all" } });
    expect(card("全部记录 Offer 占比").textContent).toContain("33%1 / 3");
    expect(document.body.textContent).not.toMatch(/家企业|胜率|投录产出比/);
    expect(screen.getAllByTitle(/: 1 条记录 \(33.3%\)$/)).toHaveLength(3);
  });
  it("看板概览也按进行中记录显示单位", () => {
    const funnel = calculateFunnelMetrics(apps);
    render(<FunnelStrip stats={{ counts: funnel.counts, totalActive: 1, funnel, rates: { appliedRate: 0, interviewRate: 0, offerRate: 0 } }} />);
    expect(screen.getByText(/进行中投递/).textContent).toContain("1 条记录");
  });
  it("直接新建终止记录时要求阶段和原因，并提供手动批次字段", () => {
    const html = renderToStaticMarkup(<ApplicationDialog defaultStage="rejected" onClose={() => {}} onSuccess={() => {}} />);
    for (const text of ["投递批次", "终止阶段", "终止原因", "required"]) expect(html).toContain(text);
  });
});
