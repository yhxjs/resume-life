import { stripRichText } from "./rich-text";

export type ProofingCategory = "日期" | "联系方式" | "学校" | "公司" | "量化指标";
export type ProofingField = { id: string; category: ProofingCategory; label: string; value: string };
export type SourceMatch = { start: number; end: number };

// 同一词法用于草稿提取与原文定位，不能把符号、分组数字或区间端点截成另一项指标。
const METRIC_NUMBER = String.raw`[+\-−]?(?:\d+(?:[.,]\d+)*|[.,]\d+)(?:e[+\-−]?\d+)?`;
const METRIC_UNIT = String.raw`(?:(?:万亿|千亿|百亿|十亿|亿|千万|百万|十万|万|千|百)(?:元|人|次|个|台)?|%|倍|人|次|个|台|元|小时|天|ms(?![a-z])|s(?![a-z]))`;
const METRIC = new RegExp(String.raw`(?<![a-z\d_.,+\-−])(?:(?:[<>]=?|[≤≥≈])\s*)?${METRIC_NUMBER}(?:\s*(?:[-~～–—]|至|到)\s*${METRIC_NUMBER})?\s*${METRIC_UNIT}`, "giu");

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

  for (const [moduleKey, itemLabel] of [["work", "工作"], ["projects", "项目"], ["custom", "自定义"]] as const) {
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
      // 正文是富文本；副项是纯文本，不能解码实体或删除其中的标签字面量。
      const contents = [
        ...descriptions.filter((value): value is string => typeof value === "string").map(stripRichText),
        ...subValues.filter((value): value is string => typeof value === "string"),
      ];
      for (const content of contents) {
        for (const match of metricTokens(content)) {
          add(`${prefix}.metric[${metricIndex++}]`, "量化指标", `${itemLabel} ${index + 1} · 指标`, match.value);
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

function metricKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s/gu, "").replace(/−/gu, "-");
}

function metricTokens(value: string): (SourceMatch & { value: string; key: string })[] {
  const normalized = comparable(value, "plain");
  return [...normalized.text.matchAll(METRIC)].map((match) => {
    const start = normalized.starts[match.index]!;
    const end = normalized.ends[match.index + match[0].length - 1]!;
    return { start, end, value: value.slice(start, end), key: metricKey(match[0]) };
  });
}

export function findSourceMatches(source: string, field: ProofingField): SourceMatch[] {
  if (field.category === "量化指标") {
    const needle = metricKey(field.value);
    return metricTokens(source).filter((match) => match.key === needle).map(({ start, end }) => ({ start, end }));
  }
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
