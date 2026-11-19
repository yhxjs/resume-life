import { emptySummary, type ProjectSummary } from "./summary";
import { ModelInputBudgetError } from "./llm-input-budget";
import { encodeProjectMaterialRecord, isProjectTableDocumentRecord, type ProjectMaterialRecordSource } from "./project-material-record";

export type ProjectInterviewContextSource = {
  projectName: string;
  archive: ProjectSummary;
  materials: Iterable<ProjectMaterialRecordSource>;
};

/** 出题、评分与合成评测共用完整记录编码；逐条计预算，超限即拒绝。 */
export function serializeProjectInterviewContext(source: ProjectInterviewContextSource, maxChars = 40_000): string {
  // 固定八字段顺序；存储 JSON 的键顺序不构成内容变更。
  const archive = { ...emptySummary(), ...source.archive };
  const prefix = `{"projectName":${JSON.stringify(source.projectName)},"archive":${JSON.stringify(archive)},"materials":[`;
  const suffix = "]}";
  const parts = [prefix];
  let usedChars = prefix.length + suffix.length;
  const overflow = () => new ModelInputBudgetError(`完整项目档案与材料超过 ${maxChars} 字符限制（含字段与材料结构），请精简后重试；本次未截断材料或调用模型`);
  if (usedChars > maxChars) throw overflow();

  let index = 0;
  for (const material of source.materials) {
    const text = `${index === 0 ? "" : ","}${JSON.stringify(encodeProjectMaterialRecord(material, index++))}`;
    if (usedChars + text.length > maxChars) throw overflow();
    usedChars += text.length;
    parts.push(text);
  }
  return parts.join("") + suffix;
}

/** Only actual top-level material records activate the fixed format guidance. */
export function projectInterviewContextHasTableDocument(context: string): boolean {
  try {
    const parsed: unknown = JSON.parse(context);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const materials = (parsed as Record<string, unknown>).materials;
    return Array.isArray(materials) && materials.some(isProjectTableDocumentRecord);
  } catch {
    return false;
  }
}
