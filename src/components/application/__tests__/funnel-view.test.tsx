import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplicationFunnelView } from "../funnel-view/application-funnel-view";
import { ApplicationDialog } from "../application-dialog";
import { calculateBatchFunnelMetrics, calculateFunnelMetrics } from "@/lib/application-funnel";
import type { FunnelApplication } from "@/lib/applications-types";

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
  it("直接新建终止记录时要求阶段和原因，并提供手动批次字段", () => {
    const html = renderToStaticMarkup(<ApplicationDialog defaultStage="rejected" onClose={() => {}} onSuccess={() => {}} />);
    for (const text of ["投递批次", "终止阶段", "终止原因", "required"]) expect(html).toContain(text);
  });
});
