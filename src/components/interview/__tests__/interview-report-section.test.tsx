// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterviewReportSection } from "../interview-report-section";
import type { InterviewData, InterviewTurn } from "@/hooks/interview-types";

afterEach(cleanup);

function turn(idx: number, answered: boolean): InterviewTurn {
  return { id: idx, idx, kind: "question", question: "实际分工？", answer: answered ? "只做校验" : "",
    answered_at: answered ? "2026-10-28" : "", scores: null, comment: "", reference: "", retries: [], notebook_id: null };
}

function interview(turns: InterviewTurn[]): InterviewData {
  return { id: 1, resume_title: "简历", jd: "岗位", rounds: 30, style: "gentle", series_id: null,
    round_no: 1, series_status: null, series_rounds: [], status: "finished", created_at: "", finished_at: "",
    evaluator_report: null, reverse_interview: null, turns,
    report: { depth: 7, structure: 8, authenticity: 8, completeness: 7, jd_match: 7, overall: 7.4,
      strengths: "职责明确", weaknesses: "尚未考察设计能力", suggestions: "补充设计练习" } };
}

describe("总评的实际作答范围", () => {
  it.each([
    ["提前结束", [turn(1, true), turn(2, false)], 1],
    ["题号有间隔", [turn(2, true), turn(7, false), turn(9, true)], 2],
    ["历史记录无已答题", [turn(1, false)], 0],
  ])("%s 时按已答记录计数，不使用配置题数或最大题号", (_name, turns, count) => {
    render(<InterviewReportSection data={interview(turns)} reportTab="candidate" setReportTab={vi.fn()}
      focusLabels={[]} remediating={false} remedialError="" onStartRemediation={vi.fn()} onEvaluatorReportGenerated={vi.fn()} />);
    expect(screen.getByText(`根据本场已作答的 ${count} 题与提供的材料整理，仅供模拟练习参考；未考察内容仍待核实。`)).toBeTruthy();
    expect(screen.getByText("尚未考察设计能力")).toBeTruthy();
    expect(screen.queryByText(/现场 4 轮|真实项目经验综合评定/)).toBeNull();
  });
});

describe("经历挖掘产物摘要", () => {
  it.each([
    { label: "仅有待确认项", hasFacts: false, pendingCount: 1, bulletCount: 0 },
    { label: "有已确认行动与草稿", hasFacts: true, pendingCount: 0, bulletCount: 1 },
  ])("$label 时显示实际数量并保留查看入口", ({ hasFacts, pendingCount, bulletCount }) => {
    const data = interview([turn(1, true)]);
    data.style = "mining";
    data.report!.mining_summary = {
      project_name: "", background: "", tradeoffs: "", results: "", contribution: "",
      actions: hasFacts ? "负责接口异常复现" : "",
      pending_confirmations: hasFacts ? [] : [{ category: "经历范围", item: "确认可讨论的真实任务", source_hint: "回查个人任务记录" }],
      resume_bullets: hasFacts ? ["负责接口异常复现"] : [],
    };
    const setReportTab = vi.fn();
    render(<InterviewReportSection data={data} reportTab="candidate" setReportTab={setReportTab}
      focusLabels={[]} remediating={false} remedialError="" onStartRemediation={vi.fn()} onEvaluatorReportGenerated={vi.fn()} />);
    expect(screen.getByText(`${pendingCount} 项待确认材料、${bulletCount} 条简历草稿`)).toBeTruthy();
    expect(screen.queryByText(/已提炼背景\/行动\/取舍\/结果全景/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看挖掘产物 →" }));
    expect(setReportTab).toHaveBeenCalledWith("mining");
  });
});
