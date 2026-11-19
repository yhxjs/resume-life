import { describe, expect, it } from "vitest";
import { PROJECT_RESUME_SYSTEM_PROMPT, PROJECT_SUMMARY_OUTPUT_RULES, PROJECT_SUMMARY_SYSTEM_PROMPT } from "../project-summary-llm";
import { emptySummary } from "../summary";
import {
  buildProjectSummaryEvidenceLedgerSystems,
  isProjectSummaryEvidenceLedger,
  PROJECT_SUMMARY_EVIDENCE_LEDGER_OUTPUT_RULES,
  projectSummaryEvidenceLedgerCases,
} from "../../../evals/project-summary-evidence-ledger-fixture";

describe("两阶段事实账本总结候选契约", () => {
  it("只替换完整总结输出合同，候选可精确恢复production", () => {
    const systems = buildProjectSummaryEvidenceLedgerSystems();
    expect(systems.baseline).toBe(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(systems.candidate).toBe(PROJECT_SUMMARY_SYSTEM_PROMPT.replace(
      PROJECT_SUMMARY_OUTPUT_RULES,
      PROJECT_SUMMARY_EVIDENCE_LEDGER_OUTPUT_RULES,
    ));
    expect(systems.candidate).not.toContain("输出单个 JSON，保留全部八个字段");
    expect(PROJECT_SUMMARY_EVIDENCE_LEDGER_OUTPUT_RULES).toContain('只含evidence和summary两个键');
    expect(buildProjectSummaryEvidenceLedgerSystems(systems.candidate)).toEqual(systems);
    expect(() => buildProjectSummaryEvidenceLedgerSystems(PROJECT_RESUME_SYSTEM_PROMPT)).toThrow();
  });

  it.each([
    ["missing-contract", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(PROJECT_SUMMARY_OUTPUT_RULES, "")],
    ["duplicate-contract", PROJECT_SUMMARY_SYSTEM_PROMPT + PROJECT_SUMMARY_OUTPUT_RULES],
    ["unknown-contract", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(PROJECT_SUMMARY_OUTPUT_RULES, "输出别的结构。")],
  ] as const)("拒绝不能唯一恢复的输出合同：%s", (_name, prompt) => {
    expect(() => buildProjectSummaryEvidenceLedgerSystems(prompt)).toThrow();
  });

  it("只接受精确引用材料的完整账本和原八字段summary", () => {
    const source = projectSummaryEvidenceLedgerCases[0]!.source;
    const value = {
      evidence: [{
        materialNumber: 1,
        quote: source.slice(0, 12),
        subject: "本人",
        scope: "本项目",
        status: "已完成",
        type: "documentation",
      }],
      summary: { ...emptySummary(), brief: "本人补充了项目说明。", achievements: ["本人补充了项目说明。"] },
    };
    expect(isProjectSummaryEvidenceLedger(value, source)).toBe(true);
    expect(isProjectSummaryEvidenceLedger({ ...value, evidence: [{ ...value.evidence[0], quote: "材料未提到的内容" }] }, source)).toBe(false);
    expect(isProjectSummaryEvidenceLedger({ ...value, summary: { ...value.summary, unexpected: "额外字段" } }, source)).toBe(false);
    expect(isProjectSummaryEvidenceLedger({ ...value, evidence: [{ ...value.evidence[0], type: "inferred" }] }, source)).toBe(false);
  });

  it("固定六份材料、24项模型准则和6项流程要求", () => {
    expect(projectSummaryEvidenceLedgerCases.map(sample => sample.id)).toEqual([
      "log-progress", "csv-unverified", "implemented-flow-current-role-not-authorship",
      "implemented-change-known-author", "observed-issue-without-cause-or-solution", "started-work-distinct-from-complete",
    ]);
    expect(projectSummaryEvidenceLedgerCases).toHaveLength(6);
    expect(projectSummaryEvidenceLedgerCases.reduce((sum, sample) => sum + sample.rubric.slice(0, -1).length, 0)).toBe(24);
    expect(projectSummaryEvidenceLedgerCases.reduce((sum, sample) => sum + sample.rubric.slice(-1).length, 0)).toBe(6);
  });
});
