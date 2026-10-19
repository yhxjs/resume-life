/** 量化片段在源文本中的半开区间 [start, end) */
export type MetricSpan = { start: number; end: number; text: string };

/** 前导动词白名单：命中时把动词一并纳入片段，让强调读起来完整 */
const LEADING_VERBS = [
  "提升", "降低", "减少", "增加", "增长", "提高", "下降", "节省", "缩短",
  "优化", "支撑", "承载", "覆盖", "服务", "处理", "达到", "超过", "突破",
  "拓展", "沉淀",
];

/**
 * 单位白名单。刻意不含裸「年」——简历里的「2024 年」是时间而非量化成果，
 * 收入白名单会让每条经历都被误标。含「个月」但不含裸「月」也是同一理由。
 */
const UNITS = [
  "季度", "毫秒", "小时", "分钟", "万人", "亿", "万", "倍", "秒",
  "天", "周", "个月", "人", "个", "次", "条",
  "%", "％", "k", "K", "w", "W", "ms", "s", "min", "h",
  "QPS", "TPS", "PV", "UV", "DAU", "MAU", "P99", "P95", "P90", "TTFB", "LCP",
];

/** 数值形态：允许千分位与小数 */
const NUM = String.raw`\d+(?:[.,]\d+)*`;

/** 备选按长度降序，保证长单位（「分钟」）先于短单位（「分」）被匹配 */
function byLengthDesc(list: readonly string[]): string {
  return [...list].sort((a, b) => b.length - a.length).join("|");
}

const UNIT_ALT = byLengthDesc(UNITS);
const VERB_ALT = byLengthDesc(LEADING_VERBS);
/** 变化连接词，长的在前 */
const CONN = "降至|降到|提升至|涨至|升至|变为|→|->|至|到";

/**
 * 三种形态，按优先级排列：
 * 1) 变化区间：从 2.5s 降至 0.8s / 由 280ms 降至 65ms / 20% → 80%
 * 2) 前导动词 + 数值 + 数量级 + 单位（含 `+`）
 * 3) 前导动词 + 英文指标名 + 数值（QPS 5000 / DAU 达 100 万）
 *
 * 全部可选组都写成 `(?:(?:…)\s*)?` 而非 `(?:…)?\s*`，
 * 否则未命中时会把后面的空格一并吞进匹配，产出「 60%」这种带前导空格的片段。
 * 三段里的「单位/数量级」组同理收在组内：`(?:\s*(?:…))?`。
 * 若把它们写成 `\s*(?:…)?`，紧跟在数值后面的空格会被无条件吃掉，
 * 「峰值 QPS 5000 后回落」就会切出带尾随空格的 `QPS 5000 `。
 */
const METRIC_RE = new RegExp(
  [
    String.raw`(?:(?:从|由)\s*)?${NUM}(?:\s*(?:${UNIT_ALT}))?\s*(?:(?:${VERB_ALT})\s*)?(?:${CONN})\s*${NUM}(?:\s*(?:${UNIT_ALT}))?`,
    String.raw`(?:(?:${VERB_ALT})\s*)?${NUM}(?:\s*(?:万|亿))?\s*(?:${UNIT_ALT})\+?`,
    String.raw`(?:(?:${VERB_ALT})\s*)?[A-Za-z]{2,6}(?![0-9A-Za-z])\s*(?:达|达到|为|至)?\s*${NUM}(?:\s*(?:万|亿))?`,
  ].join("|"),
  "gu"
);

const BRACKET_RE = /\[[^\]]*\]/gu;

/** 识别文本中的量化成果片段，按 start 升序、互不重叠 */
export function findMetricSpans(text: string): MetricSpan[] {
  if (!text) return [];

  // 先标出方括号占位符区间：占位符里的数字是给用户看的示例，不是已成立的成果
  const skip: { start: number; end: number }[] = [];
  BRACKET_RE.lastIndex = 0;
  let bracket: RegExpExecArray | null;
  while ((bracket = BRACKET_RE.exec(text)) !== null) {
    skip.push({ start: bracket.index, end: bracket.index + bracket[0].length });
  }

  const spans: MetricSpan[] = [];
  METRIC_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = METRIC_RE.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (match[0].trim().length === 0) continue;
    if (skip.some((s) => start < s.end && end > s.start)) continue;
    spans.push({ start, end, text: match[0] });
  }
  return spans;
}

/** 匹配 prompt 约定的占位符形态：[……例如：30%]，捕获「例如：」之后的值 */
const SAMPLE_RE = /\[[^\]]*?例如\s*[：:]\s*([^\]]*?)\]/gu;

/** 一次示例值替换：值本身，以及它在返回文本中的半开区间 [start, end) */
export type SampleFill = { value: string; start: number; end: number };

/**
 * 把占位符 [请填入…例如：30%] 替换为示例值。
 * 不含「例如」的方括号保持原样——模型没守格式时宁可不猜值。
 */
export function fillSampleValues(text: string): { text: string; filled: SampleFill[] } {
  if (!text) return { text: "", filled: [] };
  const filled: SampleFill[] = [];
  let out = "";
  let cursor = 0;
  SAMPLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SAMPLE_RE.exec(text)) !== null) {
    const value = (m[1] ?? "").trim();
    out += text.slice(cursor, m.index);
    const start = out.length;
    out += value;
    filled.push({ value, start, end: out.length });
    cursor = m.index + m[0].length;
  }
  out += text.slice(cursor);
  return { text: out, filled };
}

/** 预览用的结构化片段：由弹窗渲染成 React 元素，不经 HTML 字符串 */
export type StyledSegment =
  | { kind: "text"; text: string }
  | { kind: "metric"; text: string; bold: boolean; color: string; isSample: boolean };

export type MetricStyleOptions = {
  /** 是否对量化片段加粗 */
  bold: boolean;
  /** PRESET_RICH_COLORS 的 color 字段；"inherit" 表示不改色 */
  color: string;
  /** 本次自动填入的示例值区间，与之相交的片段 isSample 为 true */
  samples?: SampleFill[];
};

/**
 * 把文本切成预览片段：非指标部分是 text，指标部分是带样式选项的 metric。
 * 走结构化片段而非 HTML，是因为预览需要显示 <u> 而下划线不在富文本白名单里。
 */
export function segmentForPreview(text: string, opts: MetricStyleOptions): StyledSegment[] {
  if (!text) return [];
  const samples = opts.samples ?? [];
  const segments: StyledSegment[] = [];
  let cursor = 0;
  const spans = findMetricSpans(text);
  for (const sample of samples) {
    if (sample.value && text.slice(sample.start, sample.end) === sample.value &&
        !spans.some((span) => overlaps(span.start, span.end, sample.start, sample.end))) {
      spans.push({ start: sample.start, end: sample.end, text: sample.value });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  for (const span of spans) {
    if (span.start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, span.start) });
    }
    segments.push({
      kind: "metric",
      text: span.text,
      bold: opts.bold,
      color: opts.color,
      isSample: samples.some(
        (s) => s.value.length > 0 && overlaps(span.start, span.end, s.start, s.end)
      ),
    });
    cursor = span.end;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}

/** 半开区间相交；仅端点相邻不算相交 */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 把预览片段转成写入简历的 HTML。
 * 只产出 <strong> 与 <span style="color: …">，结构上不可能产出 <u>——
 * 示例保留文本标记，经过保存和富文本清洗后仍能被导出检查识别。
 */
export function segmentsToHtml(segments: StyledSegment[]): string {
  let html = "";
  for (const seg of segments) {
    if (seg.kind === "text") {
      html += escapeHtml(seg.text);
      continue;
    }
    let inner = escapeHtml(seg.text);
    if (seg.color !== "inherit") inner = `<span style="color: ${seg.color}">${inner}</span>`;
    if (seg.bold) inner = `<strong>${inner}</strong>`;
    html += seg.isSample ? "[待确认示例：" + inner + "]" : inner;
  }
  return html;
}
