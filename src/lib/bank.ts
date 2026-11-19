import { matchesSqliteLikeSubstring } from "./sqlite-like";

export type BankKind = "tech" | "behavior";

/** 单次导入按去重后的有效题目计数。 */
export const MAX_BANK_IMPORT = 500;

/** 与导入接口一致：只清理逐行首尾空白，同一批次内按完整原文去重。 */
export function bankImportQuestions(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
}

export type BankEntry = { id: number; direction: string; kind: string; question: string; created_at: string };
export type BankImportPage = { items: BankEntry[]; nextCursor: string | null };

function isBankEntry(value: unknown): value is BankEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id > 0 &&
    ["direction", "kind", "question", "created_at"].every(key => typeof row[key] === "string");
}

/** 历史题目逐字回读，未知题型及长文本不套用新导入限制。 */
export function readBankEntry(value: unknown, id: number): BankEntry {
  if (!isBankEntry(value) || value.id !== id) throw new Error("题目读取响应不完整或记录不符");
  return value;
}

type BankPageFilter = { direction?: string; kind?: string; keyword?: string; cursor?: string };

/** 目录及恢复快照整页校验，坏条目不能被丢弃后伪装成完整结果。 */
export function readBankListPage(value: unknown, { direction = "", kind = "", keyword = "", cursor }: BankPageFilter = {}): BankImportPage {
  const fail = () => { throw new Error("题库读取响应不完整或筛选不符，请重新读取"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const page = value as BankImportPage;
  if (!Array.isArray(page.items) || page.items.length > 50 ||
    (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor))) return fail();
  let previousId = cursor === undefined ? Infinity : Number(cursor);
  if (cursor !== undefined && (!Number.isSafeInteger(previousId) || previousId <= 0 || String(previousId) !== cursor)) return fail();
  const expectedDirection = direction.trim();
  const expectedKind = kind.trim();
  const expectedKeyword = keyword.trim();
  for (const item of page.items) {
    if (!isBankEntry(item) || item.id >= previousId ||
      (expectedKind && item.kind !== expectedKind) || (expectedDirection && item.direction !== expectedDirection) ||
      (expectedKeyword && !matchesSqliteLikeSubstring(item.question, expectedKeyword))) return fail();
    previousId = item.id;
  }
  if (page.nextCursor !== null && (page.items.length === 0 || page.nextCursor !== String(page.items.at(-1)!.id))) return fail();
  return page;
}

/** 只读快照用于人工核对，不能据同文题目推断本次写入归属。 */
export function readBankImportPage(value: unknown, direction: string, kind: BankKind): BankImportPage {
  return readBankListPage(value, { direction, kind });
}

export function readBankDirections(value: unknown): { direction: string; count: number }[] {
  if (!Array.isArray(value)) throw new Error("方向列表响应不完整，请重试加载");
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.direction !== "string" || !item.direction ||
      !Number.isSafeInteger(item.count) || item.count <= 0 || seen.has(item.direction)) throw new Error("方向列表响应不完整，请重试加载");
    seen.add(item.direction);
    return { direction: item.direction, count: item.count };
  });
}

/** 题库题型：八股=标准知识题，行为=行为面试题 */
export const BANK_KINDS: { key: BankKind; label: string }[] = [
  { key: "tech", label: "八股" },
  { key: "behavior", label: "行为" },
];

export function bankKindOf(key: unknown): BankKind {
  return BANK_KINDS.some((k) => k.key === key) ? (key as BankKind) : "tech";
}

export function bankKindLabel(kind: string): string {
  return BANK_KINDS.find((k) => k.key === kind)?.label ?? "";
}
