export type BankKind = "tech" | "behavior";

/** 单次导入按去重后的有效题目计数。 */
export const MAX_BANK_IMPORT = 500;

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
