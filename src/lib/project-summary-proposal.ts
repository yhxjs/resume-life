import { isStoredProjectSummary, SUMMARY_SECTIONS, type ProjectSummary } from "./summary";
import type { SummaryChange } from "./project-summary-diff";
import type { MaterialChange } from "./project-summary-history";

export type ProjectSummaryProposal = {
  summary: ProjectSummary;
  comparison: SummaryChange[];
  materialChanges: MaterialChange[];
  materialFingerprint: string;
  revisionId: number;
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const textKeys = new Set<string>([...SUMMARY_SECTIONS.map(({ key }) => key), "techStack", "brief"]);

/** 校验待采纳的整份回包；简历提炼包含旧五维正文，不套用新生成文本的篇幅上限或清洗原文。 */
export function readProjectSummaryProposal(value: unknown): ProjectSummaryProposal {
  const fail = () => { throw new Error("项目总结草稿响应不完整或内容不符，请重新生成"); };
  if (!record(value) || !isStoredProjectSummary(value.summary) || !Object.hasOwn(value.summary, "overview") ||
      !Array.isArray(value.comparison) || !Array.isArray(value.materialChanges) ||
      typeof value.materialFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.materialFingerprint) ||
      typeof value.revisionId !== "number" || !Number.isSafeInteger(value.revisionId) || value.revisionId < 0) return fail();
  const summary = value.summary as ProjectSummary;
  const keys = new Set<string>();
  for (const change of value.comparison) {
    if (!record(change) || typeof change.key !== "string" || keys.has(change.key) ||
        typeof change.label !== "string" || !change.label.trim() ||
        (change.status !== "new" && change.status !== "changed" && change.status !== "conflict") ||
        typeof change.previous !== "string" || typeof change.next !== "string" || change.previous === change.next ||
        (change.status === "new") !== (change.previous === "" && change.next !== "")) return fail();
    keys.add(change.key);
    let next: string;
    if (textKeys.has(change.key)) next = summary[change.key as Exclude<keyof ProjectSummary, "achievements">];
    else {
      const match = /^achievement:(0|[1-9]\d*)$/.exec(change.key);
      if (!match || !Number.isSafeInteger(Number(match[1]))) return fail();
      next = summary.achievements[Number(match[1])] ?? "";
    }
    // 用户看到的替换预览须与勾选后实际采用的正文一致，不能只校验字段类型。
    if (change.next !== next) return fail();
  }
  const materialIds = new Set<number>();
  for (const material of value.materialChanges) {
    if (!record(material) || typeof material.id !== "number" || !Number.isSafeInteger(material.id) || material.id < 1 || materialIds.has(material.id) ||
        typeof material.title !== "string" || (material.status !== "new" && material.status !== "changed" && material.status !== "removed")) return fail();
    materialIds.add(material.id);
  }
  return { summary, comparison: value.comparison as SummaryChange[], materialChanges: value.materialChanges as MaterialChange[], materialFingerprint: value.materialFingerprint, revisionId: value.revisionId };
}
