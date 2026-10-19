export function toLocalDateTime(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalDateTime(value: string, original = ""): string {
  if (!value) return "";
  // 未改时间时保留秒、毫秒及夏令时回拨期间的原始时刻。
  if (original && value === toLocalDateTime(original)) return original;
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
    || !Number.isFinite(date.getTime()) || toLocalDateTime(date.toISOString()) !== value) {
    throw new Error("面试时间无效，请选择存在的本地日期和时间");
  }
  return date.toISOString();
}

/** 将 ISO/UTC 字符串或本地时间字符串格式化为用户本地友好展示格式，如 "09-24 14:30" */
export function formatFriendlyDateTime(value: string): string {
  if (!value) return "";
  const local = toLocalDateTime(value);
  if (!local) return "";
  const parts = local.split("T");
  const datePart = parts[0] ?? "";
  const timePart = parts[1] ?? "";
  return `${datePart.slice(5)} ${timePart}`;
}
