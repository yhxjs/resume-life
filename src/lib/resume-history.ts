import { isStoredId } from "@/lib/id-parsing";
import { isModuleKey } from "@/lib/modules";

export type ResumeListItem = { id: number; title: string; created_at: string; updated_at: string; versions?: { id: number; version: number; name?: string }[] };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** 目录保留历史长标题与缺省版本数组，不按当前创建约束截断。 */
export function readResumeList(value: unknown): ResumeListItem[] {
  const invalid = () => new Error("简历列表响应不完整或存在重复记录，请重新加载");
  if (!Array.isArray(value)) throw invalid();
  const ids = new Set<number>(); const versions = new Set<number>();
  for (const row of value) {
    if (!record(row) || !isStoredId(row.id) || ids.has(row.id) || typeof row.title !== "string" || typeof row.created_at !== "string" || typeof row.updated_at !== "string") throw invalid();
    ids.add(row.id);
    if (row.versions === undefined) continue;
    if (!Array.isArray(row.versions)) throw invalid();
    const numbers = new Set<number>();
    for (const version of row.versions) {
      if (!record(version) || !isStoredId(version.id) || versions.has(version.id) || !positiveId(version.version) || numbers.has(version.version) || (version.name !== undefined && typeof version.name !== "string")) throw invalid();
      versions.add(version.id); numbers.add(version.version);
    }
  }
  return value as ResumeListItem[];
}

/** 只读删除核对接受服务端的损坏模块回退及修复标记，不修改正文或生成保存令牌。 */
export function validateExistingResume(value: unknown, id: number): void {
  const invalid = () => new Error("简历详情响应不完整或记录不符");
  if (!record(value) || !record(value.resume)) throw invalid();
  const resume = value.resume;
  if (resume.id !== id || !isStoredId(resume.id) || typeof resume.title !== "string" || typeof resume.template !== "string" || typeof resume.created_at !== "string" || typeof resume.updated_at !== "string" || !record(resume.style_overrides) || (resume.base_version_id != null && !isStoredId(resume.base_version_id)) || !Array.isArray(value.modules) || !Array.isArray(value.warnings) || !value.warnings.every(item => typeof item === "string") || !Array.isArray(value.corruptedKeys) || !value.corruptedKeys.every(item => typeof item === "string")) throw invalid();
  const keys = new Set<string>();
  for (const entry of value.modules) {
    if (!record(entry) || typeof entry.key !== "string" || !entry.key || keys.has(entry.key) || !isModuleKey(entry.type) || typeof entry.label !== "string" || typeof entry.sort !== "number" || !Number.isFinite(entry.sort) || (!record(entry.content) && !Array.isArray(entry.content))) throw invalid();
    keys.add(entry.key);
  }
}

export function resumeDeletionTitle(item: ResumeListItem): string {
  return `${item.title}\n创建时间：${item.created_at}；最后修改：${item.updated_at}；${item.versions?.length ?? 0} 个已发布版本`;
}
