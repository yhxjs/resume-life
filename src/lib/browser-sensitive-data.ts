import { clearResumeDrafts, hasPendingResumeDrafts } from "./resume-save-queue-registry";
import { clearStoredRepoPaths } from "./project-repo-paths-storage";

export const ANONYMIZE_STORAGE_KEY = "resume_life_anonymize_config";
const DRAFT_PREFIX = "resume-life:draft:";

function draftKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < sessionStorage.length; index++) {
    const key = sessionStorage.key(index);
    if (key?.startsWith(DRAFT_PREFIX)) keys.push(key);
  }
  return keys;
}

export function hasSensitiveBrowserDrafts(): boolean {
  return hasPendingResumeDrafts() || draftKeys().length > 0;
}

/** 只处理应用拥有的敏感键，存储失败必须让调用方显示错误。 */
export function clearSensitiveBrowserData(keepDrafts = false): void {
  if (!keepDrafts) {
    clearResumeDrafts();
    for (const key of draftKeys()) sessionStorage.removeItem(key);
  }
  localStorage.removeItem(ANONYMIZE_STORAGE_KEY);
  clearStoredRepoPaths();
}
