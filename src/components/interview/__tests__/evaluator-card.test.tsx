// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InterviewEvaluatorCard } from "../evaluator-card";
import type { EvaluatorReport } from "@/lib/scores";

afterEach(cleanup);

describe("录用评估的回答依据标签", () => {
  it("将模型整理的摘要标为非逐字引文", () => {
    const report: EvaluatorReport = {
      recommendation: "Hire",
      level: "暂无法判断",
      level_justification: "本场证据不足以定级。",
      summary_for_hr: "回答展示了清晰的取舍。",
      hire_reasons: [],
      concerns_and_risks: [],
      placement_suggestion: "补充系统设计考察。",
      evidence_quotes: [{ turn_idx: 2, topic: "缓存策略", observation: "说明了读写一致性的取舍。" }],
    };

    render(<InterviewEvaluatorCard report={report} interviewId={1} />);

    expect(screen.getByText("🔍 回答依据摘要")).toBeTruthy();
    expect(screen.getByText("根据本次回答整理 · 非逐字引文")).toBeTruthy();
    expect(screen.getByText("说明了读写一致性的取舍。")).toBeTruthy();
    expect(screen.getByText("暂无法判断")).toBeTruthy();
    expect(screen.getByText("本报告未提供具体风险观察，仍需进一步考察")).toBeTruthy();
    expect(screen.getByText(/不代表真实公司的录用决定或官方职级认定/)).toBeTruthy();
    expect(screen.queryByText(/CONFIDENTIAL|呈报 HR|未发现明显硬伤/)).toBeNull();
    expect(screen.queryByText(/现场记录|问答实录/)).toBeNull();
  });
});
