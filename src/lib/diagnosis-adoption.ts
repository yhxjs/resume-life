import { getDb, inTransaction, now } from "./db";
import { loadResume } from "./resumes";
import { diagnosisValue, diagnosisValuesEqual, type DiagnosisRecord } from "./diagnosis";
import { assertDiagnosisBudget, loadDiagnosis } from "./diagnosis-history";
import { writeDiagnosisValue } from "./module-descriptions";
import { stripRichText } from "./rich-text";
import { ResumeVersionError } from "./resume-versions";
import type { ModuleData } from "./modules";

export type DiagnosisAdoptionInput = { diagnosisId: number; moduleKey: string; suggestionIndex: number; value: unknown };

/** Both Web and MCP record the normalized value actually present in the draft. */
export function validateDiagnosisAdoption(current: DiagnosisRecord, modules: ModuleData[], input: DiagnosisAdoptionInput) {
  const suggestion = current.report?.modules.find(module => module.moduleKey === input.moduleKey)?.suggestions[input.suggestionIndex];
  const value = input.value;
  if (!suggestion || (suggestion.field === "items"
    ? !Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === "string" && item.trim())
    : typeof value !== "string" || !value.trim())) throw new ResumeVersionError("建议或采纳内容无效");
  const mod = modules.find(entry => entry.key === input.moduleKey);
  let savedValue: string | string[] | null = value as string | string[];
  if (typeof value === "string" && mod && ["work", "projects", "education", "summary"].includes(mod.type)) {
    const content = writeDiagnosisValue(mod.type as "work" | "projects" | "education" | "summary", mod.content, suggestion.itemId, value);
    savedValue = content === null ? null : diagnosisValue([{ ...mod, content }], input.moduleKey, suggestion);
  }
  if (typeof savedValue === "string" && !stripRichText(savedValue).trim()) throw new ResumeVersionError("采纳内容整理后为空，请补充正文后重新采纳");
  if (savedValue === null || JSON.stringify(diagnosisValue(modules, input.moduleKey, suggestion)) !== JSON.stringify(savedValue)) {
    throw new ResumeVersionError("采纳内容尚未保存或已被修改，请确认简历保存成功后重试", 409);
  }
  const existing = current.adoptions.find(entry => entry.moduleKey === input.moduleKey && entry.suggestionIndex === input.suggestionIndex);
  if (existing && !diagnosisValuesEqual(suggestion.field, existing.value, savedValue)) {
    throw new ResumeVersionError("该建议已记录其他采纳内容，请点击“继续编辑草稿”刷新采纳状态并核对历史记录", 409);
  }
  return { savedValue, existing };
}

export function recordDiagnosisAdoption(resumeId: number, input: DiagnosisAdoptionInput) {
  return inTransaction(() => {
    const current = loadDiagnosis(resumeId, input.diagnosisId);
    if (!current) throw new ResumeVersionError("诊断记录不存在", 404);
    const data = loadResume(resumeId);
    if (!data) throw new ResumeVersionError("简历不存在", 404);
    const { savedValue, existing } = validateDiagnosisAdoption(current, data.modules, input);
    if (!existing) {
      current.adoptions.push({ moduleKey: input.moduleKey, suggestionIndex: input.suggestionIndex, value: savedValue, applied_at: now() });
      const adoptions = JSON.stringify(current.adoptions);
      const stored = getDb().prepare("SELECT * FROM resume_diagnoses WHERE resume_id=? AND id=?").get(resumeId, current.id)!;
      assertDiagnosisBudget({ ...stored, adoptions });
      getDb().prepare("UPDATE resume_diagnoses SET adoptions=? WHERE resume_id=? AND id=?").run(adoptions, resumeId, current.id);
    }
    return current;
  });
}
