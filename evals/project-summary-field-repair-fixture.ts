import {
  buildProjectSummaryFieldBoundariesSystems,
  projectSummaryFieldBoundariesCases,
} from "./project-summary-field-boundaries-fixture";

export const PROJECT_SUMMARY_FIELD_REPAIR_ANCHOR = "多条成果的状态限定不是第一条的公共前缀。";
export const PROJECT_SUMMARY_FIELD_REPAIR_ADDITION = "brief写入问题复现或处理时，本项保留对应的本地样本/环境、实际现象和修复/验证状态；字数不足先删项目背景。brief或achievement写既有实现时，当前职责不证明实现者；作者未知则保持项目主语。";
const insertedRule = PROJECT_SUMMARY_FIELD_REPAIR_ANCHOR + PROJECT_SUMMARY_FIELD_REPAIR_ADDITION;

/** One full-summary candidate: the joint field definitions plus one brief/author boundary. */
export function buildProjectSummaryFieldRepairSystems(production: string): { baseline: string; candidate: string } {
  const anchorCount = production.split(PROJECT_SUMMARY_FIELD_REPAIR_ANCHOR).length - 1;
  const additionCount = production.split(PROJECT_SUMMARY_FIELD_REPAIR_ADDITION).length - 1;
  const insertedCount = production.split(insertedRule).length - 1;
  if (anchorCount !== 1 || additionCount > 1 || additionCount !== insertedCount) {
    throw new Error("project-summary-field-repair requires one known full-summary rule anchor");
  }
  const seed = production.replace(insertedRule, PROJECT_SUMMARY_FIELD_REPAIR_ANCHOR);
  const boundarySystems = buildProjectSummaryFieldBoundariesSystems(seed);
  if (additionCount === 1 && seed !== boundarySystems.candidate) {
    throw new Error("project-summary-field-repair requires both field definitions with the brief rule");
  }
  return {
    baseline: boundarySystems.baseline,
    candidate: boundarySystems.candidate.replace(PROJECT_SUMMARY_FIELD_REPAIR_ANCHOR, insertedRule),
  };
}

export const projectSummaryFieldRepairCases = projectSummaryFieldBoundariesCases;
