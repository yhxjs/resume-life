export type UsageRangePreset = "month" | "7d" | "30d" | "all" | "custom";

export type UsageRange = { from: string | null; to: string | null };

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseLocalDate(value: string): Date {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) throw new Error("日期格式必须是 YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  // 拒绝 2026-02-31 这类会被 Date 自动进位的日期
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error("日期不存在");
  }
  return date;
}

/**
 * 把前端档位换算成 ISO UTC 区间。区间为左闭右开 [from, to)，一律按本地时区的自然日边界计算。
 * 「全部」返回双 null（不限）。
 */
export function resolveUsageRange(
  preset: UsageRangePreset,
  now: Date,
  custom?: { from: string; to: string },
): UsageRange {
  if (preset === "all") return { from: null, to: null };

  if (preset === "custom") {
    if (!custom) throw new Error("请选择起止日期");
    const from = startOfLocalDay(parseLocalDate(custom.from));
    const to = startOfLocalDay(parseLocalDate(custom.to));
    to.setDate(to.getDate() + 1);
    if (from.getTime() >= to.getTime()) throw new Error("起始日期必须早于结束日期");
    return { from: from.toISOString(), to: to.toISOString() };
  }

  if (preset === "month") {
    return {
      from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      to: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
    };
  }

  const days = preset === "7d" ? 7 : 30;
  const today = startOfLocalDay(now);
  const from = new Date(today);
  from.setDate(from.getDate() - (days - 1));
  const to = new Date(today);
  to.setDate(to.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}
