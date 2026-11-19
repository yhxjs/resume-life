import { DEFAULT_PAGE_LIMIT, parseIdCursor, type CursorPage } from "./cursor-pagination";
import { isIntroKind, readStoredIntroSentences } from "./intro";

export type IntroListItem = {
  id: number;
  jd: string;
  created_at: string;
  resume_title: string;
  resume_version_id: number | null;
  resume_version: number | null;
  resume_version_name: string | null;
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function validVersionBinding(value: Record<string, unknown>): boolean {
  return value.resume_version_id === null
    ? value.resume_version === null && value.resume_version_name === null
    : positiveId(value.resume_version_id) && positiveId(value.resume_version) && typeof value.resume_version_name === "string";
}

/** 危险操作展示完整存档依据，不复用卡片截断后的 JD。 */
export function introDeletionTitle(item: IntroListItem): string {
  const version = item.resume_version_id === null ? "旧记录未绑定发布版"
    : `v${item.resume_version} · ${item.resume_version_name}（发布版 #${item.resume_version_id}）`;
  return `JD：${item.jd || "未提供"}；参考简历：${item.resume_title || "未命名"}；${version}；创建时间：${item.created_at || "未记录时间"}`;
}

/** 详情与删除结果只读核对：支持缺版、长历史及明确标记的损坏原稿，不套新生成上限。 */
export function validateExistingIntro(value: unknown, id: number): void {
  const fail = () => { throw new Error("读取响应不完整或记录不符"); };
  if (!record(value) || !positiveId(value.id) || value.id !== id || !positiveId(value.resume_id) ||
    !["jd", "created_at", "resume_title"].every(key => typeof value[key] === "string") ||
    !validVersionBinding(value) || !Array.isArray(value.versions)) return fail();
  const kinds = new Set<string>();
  for (const version of value.versions) {
    if (!record(version) || !isIntroKind(version.kind) || kinds.has(version.kind) ||
      typeof version.revision !== "string" || !/^[a-f0-9]{64}$/.test(version.revision)) return fail();
    kinds.add(version.kind);
    if (version.read_error !== undefined) {
      if (typeof version.read_error !== "string" || !version.read_error || typeof version.raw_sentences !== "string" ||
        !Array.isArray(version.sentences) || version.sentences.length !== 0) return fail();
    } else if (readStoredIntroSentences(JSON.stringify(version.sentences)).error) return fail();
  }
}

/** 读取真实存档与版本绑定，不用生成篇幅限制裁剪历史 JD 或时间字面量。 */
export function readIntroListPage(value: unknown, { cursor, limit = DEFAULT_PAGE_LIMIT }: { cursor?: string; limit?: number } = {}): CursorPage<IntroListItem> {
  const fail = () => { throw new Error("自我介绍历史响应不完整或分页不符，请重新读取"); };
  if (!record(value) || !Array.isArray(value.items) || value.items.length > limit ||
    (value.nextCursor !== null && typeof value.nextCursor !== "string") ||
    (value.total !== undefined && (typeof value.total !== "number" || !Number.isSafeInteger(value.total) || value.total < 0))) return fail();
  let previousId = Infinity;
  if (cursor !== undefined) {
    try { previousId = parseIdCursor(new URLSearchParams({ cursor })) ?? Infinity; }
    catch { return fail(); }
  }
  for (const item of value.items) {
    if (!record(item) || !positiveId(item.id) || item.id >= previousId ||
      !["jd", "created_at", "resume_title"].every(key => typeof item[key] === "string")) return fail();
    if (!validVersionBinding(item)) return fail();
    previousId = item.id;
  }
  if (value.nextCursor !== null && (value.items.length !== limit || value.nextCursor !== String(previousId))) return fail();
  return value as CursorPage<IntroListItem>;
}

export function formatIntroHistoryDate(value: string): string {
  // 纯日期没有时区语义，亦不让 Date 自动校正旧日期字面量。
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value || "未记录时间" : date.toLocaleDateString();
}
