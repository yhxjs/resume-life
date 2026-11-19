/**
 * Parse a canonical positive decimal ID from a path or query parameter.
 * Invalid values return NaN so route guards can keep their existing response.
 */
export function parseCanonicalPositiveId(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return Number.NaN;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : Number.NaN;
}

/** 备份和旧数据库保留显式写入 SQLite 的零或负主键。 */
export function isStoredId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function parseCanonicalStoredId(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const id = Number(value);
  return isStoredId(id) && String(id) === value ? id : Number.NaN;
}
