import { stripRichText } from "./rich-text";

export type ProofingCategory = "日期" | "联系方式" | "学校" | "公司" | "量化指标";
export type ProofingField = { id: string; category: ProofingCategory; label: string; value: string };
export type SourceMatch = { start: number; end: number };

const METRIC = /\d+(?:[.,]\d+)?\s*(?:%|％|万元|万|亿|千|百|倍|人|次|个|台|元|小时|天|ms|s)/giu;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

export function collectProofingFields(modules: Record<string, unknown>): ProofingField[] {
  const fields: ProofingField[] = [];
  const add = (id: string, category: ProofingCategory, label: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) fields.push({ id, category, label, value: value.trim() });
  };
  const basic = record(modules.basic);
  add("basic.phone", "联系方式", "电话", basic.phone);
  add("basic.email", "联系方式", "邮箱", basic.email);
  add("basic.birthday", "日期", "出生年月", basic.birthday);

  entries(modules.education).forEach((entry, index) => {
    const prefix = `education[${index}]`;
    add(`${prefix}.school`, "学校", `教育 ${index + 1} · 学校`, entry.school);
    add(`${prefix}.start`, "日期", `教育 ${index + 1} · 开始`, entry.start);
    add(`${prefix}.end`, "日期", `教育 ${index + 1} · 结束`, entry.end);
  });

  for (const [moduleKey, itemLabel] of [["work", "工作"], ["projects", "项目"]] as const) {
    entries(modules[moduleKey]).forEach((entry, index) => {
      const prefix = `${moduleKey}[${index}]`;
      if (moduleKey === "work") add(`${prefix}.company`, "公司", `工作 ${index + 1} · 公司`, entry.company);
      add(`${prefix}.start`, "日期", `${itemLabel} ${index + 1} · 开始`, entry.start);
      add(`${prefix}.end`, "日期", `${itemLabel} ${index + 1} · 结束`, entry.end);

      const descriptionItems = Array.isArray(entry.descriptionItems)
        ? entry.descriptionItems.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        : [];
      const descriptions = descriptionItems.length ? descriptionItems : [entry.description];
      const subValues = entries(entry.subItems).map((subItem) => subItem.value);
      let metricIndex = 0;
      for (const content of [...descriptions, ...subValues]) {
        if (typeof content !== "string") continue;
        for (const match of stripRichText(content).matchAll(METRIC)) {
          add(`${prefix}.metric[${metricIndex++}]`, "量化指标", `${itemLabel} ${index + 1} · 指标`, match[0]);
        }
      }
    });
  }
  return fields;
}

type MatchMode = "plain" | "date" | "phone";

function comparable(value: string, mode: MatchMode): { text: string; starts: number[]; ends: number[] } {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let offset = 0; offset < value.length;) {
    const character = String.fromCodePoint(value.codePointAt(offset)!);
    const end = offset + character.length;
    for (const normalized of character.normalize("NFKC").toLowerCase()) {
      if (mode === "date" && /[\s./年月日\-—–]/u.test(normalized)) continue;
      if (mode === "phone" && /[\s()+\-]/u.test(normalized)) continue;
      text += normalized;
      starts.push(offset);
      ends.push(end);
    }
    offset = end;
  }
  return { text, starts, ends };
}

export function findSourceMatches(source: string, field: ProofingField): SourceMatch[] {
  const mode: MatchMode = field.id === "basic.phone" ? "phone" : field.category === "日期" ? "date" : "plain";
  const haystack = comparable(source, "plain");
  const needle = comparable(field.value, mode).text;
  if (!needle) return [];

  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const separator = mode === "date" ? "[\\s./年月日\\-—–]{0,3}" : "[\\s()+\\-]{0,3}";
  const pattern = mode === "plain" || !/\d/u.test(needle)
    ? escape(needle)
    : [...needle].map(escape).join(separator);
  const matcher = new RegExp(pattern, "gu");
  const matches: SourceMatch[] = [];
  for (const match of haystack.text.matchAll(matcher)) {
    const position = match.index;
    const endPosition = position + match[0].length;
    const start = haystack.starts[position]!;
    const end = haystack.ends[endPosition - 1]!;
    const numericBoundary = mode === "plain" || (
      !/\d/u.test(haystack.text[position - 1] ?? "") &&
      !/\d/u.test(haystack.text[endPosition] ?? "") &&
      end - start <= field.value.length + 8
    );
    if (numericBoundary) matches.push({ start, end });
  }
  return matches;
}
