/** 项目及副项共用递增序列，避免同一毫秒内生成重复条目 ID。 */
let entryIdSeq = 0;

export function genEntryId(prefix: "it" | "sub"): string {
  entryIdSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${entryIdSeq}`;
}
