import type { ModuleData } from "@/lib/modules";
import { findMetricSpans } from "@/lib/metric-highlight";
import { stripRichText } from "@/lib/rich-text";
import { A4_HEIGHT_PX, estimatePageFitStatus } from "@/lib/resume-compression";

export type ResumeExportIssueKind = "unconfirmed_metric" | "placeholder" | "contact" | "pagination";
export type ResumeExportIssue = {
  id: string;
  kind: ResumeExportIssueKind;
  severity: "blocking" | "warning";
  moduleKey: string;
  moduleLabel: string;
  entryIndex?: number;
  entryId?: string;
  entryLabel?: string;
  field?: string;
  excerpt: string;
  context?: string;
  contextMetricOffset?: number;
  inExportedContent?: boolean;
  message: string;
};
export type ResumeExportLayoutEntry = { moduleKey: string; entryIndex?: number; top: number; bottom: number };
export type ResumeExportCheckInput = {
  modules: ModuleData[];
  title?: string;
  paperHeight?: number;
  pageMargin?: number;
  layout?: ResumeExportLayoutEntry[];
  exportedContent?: { title: string; modules: ModuleData[] };
  /** 确认仅在当前导出会话有效，正文变化会产生新的问题 ID。 */
  confirmedIssueIds?: ReadonlySet<string>;
};
export type ResumeExportCheckResult = {
  issues: ResumeExportIssue[];
  blockingIssues: ResumeExportIssue[];
  warningIssues: ResumeExportIssue[];
  canExport: boolean;
};

const PLACEHOLDER_RE = /[\[【][^\]】]*(?:请填入|请填写|待填写|待补充|待确认|待核实|占位|TODO|TBD|例如\s*[：:]|姓名|学校名称|公司名称|项目名称|数量|百分比|X[%％]|X{2,})[^\]】]*[\]】]|\{\{[^{}]+\}\}|\b(?:TODO|TBD|X{2,})\b|(?:XX|xx)(?:%|％|人|万|个)|请(?:填入|填写|补充|替换)|待(?:填写|补充|确认|核实)/giu;
const DATE_RE = /\b(?:19|20)\d{2}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\b/g;

function addTextIssues(
  issues: ResumeExportIssue[], resumeModule: ModuleData, entryIndex: number | undefined,
  field: string, value: string, confirmed: ReadonlySet<string>, checkMetrics = true,
) {
  const text = stripRichText(value);
  if (!text.trim()) return;
  const entry = entryIndex !== undefined && Array.isArray(resumeModule.content)
    ? resumeModule.content[entryIndex] as Record<string, unknown> : undefined;
  const entryId = typeof entry?.id === "string" ? entry.id : undefined;
  const base = {
    moduleKey: resumeModule.key, moduleLabel: resumeModule.label, entryIndex, entryId, field,
    entryLabel: String(entry?.company || entry?.name || entry?.school || ""), context: text,
  };
  // 保留字符位置；不把日期区间或技术版本当成果数字。
  const metricText = text.replace(DATE_RE, (date) => " ".repeat(date.length));
  const metricSpans = checkMetrics ? findMetricSpans(metricText) : [];
  const clauseBounds = [0];
  if (metricSpans.length) {
    for (const match of text.matchAll(/[，,；;、。！？!?\n]|\.(?=\s|$)/gu)) {
      const end = match.index + match[0].length;
      if (metricSpans.some((span) => span.start < end && end < span.end)) continue;
      clauseBounds.push(end);
    }
    if (clauseBounds.at(-1) !== text.length) clauseBounds.push(text.length);
  }
  for (const span of metricSpans) {
    if (/^[A-Za-z]+\s*\d/.test(span.text) && !/^(?:QPS|TPS|PV|UV|DAU|MAU|P99|P95|P90|TTFB|LCP)\b/i.test(span.text)) continue;
    const id = JSON.stringify(["metric", resumeModule.key, entryId ?? entryIndex, field, text, span.start]);
    if (confirmed.has(id)) continue;
    const clauseIndex = clauseBounds.findIndex((end) => end > span.start) - 1;
    const from = Math.max(clauseBounds[Math.max(0, clauseIndex - 1)]!, span.start - 40);
    const to = Math.min(clauseBounds[Math.min(clauseBounds.length - 1, clauseIndex + 2)]!, span.end + 40);
    const before = text.slice(from, span.start).trimStart();
    const after = text.slice(span.end, to).trimEnd();
    const leading = from > 0 ? "…" : "";
    issues.push({ ...base, id, kind: "unconfirmed_metric", severity: "blocking", excerpt: span.text,
      context: leading + before + span.text + after + (to < text.length ? "…" : ""),
      contextMetricOffset: leading.length + before.length,
      message: "请逐条核实该数字的来源、统计口径与真实结果，再确认导出" });
  }
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    issues.push({ ...base,
      id: JSON.stringify(["placeholder", resumeModule.key, entryId ?? entryIndex, field, text, match.index]),
      kind: "placeholder", severity: "blocking", excerpt: match[0],
      message: "请回到条目，用真实内容替换占位符或待确认示例；不能直接跳过" });
  }
}

function inspectModuleText(issues: ResumeExportIssue[], resumeModule: ModuleData, confirmed: ReadonlySet<string>) {
  const scan = (index: number | undefined, field: string, value: unknown, metrics = true) => {
    if (typeof value === "string") addTextIssues(issues, resumeModule, index, field, value, confirmed, metrics);
  };
  scan(undefined, "label", resumeModule.label, false);
  if (resumeModule.type === "work" || resumeModule.type === "projects" || resumeModule.type === "education") {
    const items = Array.isArray(resumeModule.content) ? resumeModule.content : [];
    items.forEach((item: Record<string, unknown>, index) => {
      if (!item || typeof item !== "object") return;
      const fields = resumeModule.type === "education" ? ["school", "degree", "field", "start", "end"]
        : resumeModule.type === "work" ? ["company", "title", "start", "end"] : ["name", "role", "start", "end"];
      for (const field of fields) scan(index, field, item[field], false);
      if (resumeModule.type !== "education" && Array.isArray(item.subItems)) {
        item.subItems.forEach((sub, subIndex) => {
          if (!sub || typeof sub !== "object") return;
          scan(index, "subItems[" + subIndex + "].label", sub.label, false);
          scan(index, "subItems[" + subIndex + "].value", sub.value);
        });
      }
      // 与实际输出使用同一正文来源，避免漏检或重复。
      if (resumeModule.type !== "education" && Array.isArray(item.descriptionItems) && item.descriptionItems.some((value) => typeof value === "string" && value.trim())) {
        item.descriptionItems.forEach((value, line) => scan(index, "descriptionItems[" + line + "]", value));
      } else scan(index, "description", item.description);
    });
    return;
  }
  const content = (resumeModule.content ?? {}) as Record<string, unknown>;
  if (resumeModule.type === "basic") {
    for (const field of ["name", "gender", "age", "phone", "email", "location", "birthday", "links"]) scan(undefined, field, content[field], false);
  } else if (resumeModule.type === "skills" && Array.isArray(content.items)) {
    content.items.forEach((value, index) => scan(index, "items[" + index + "]", value));
  } else if (resumeModule.type === "summary") scan(0, "text", content.text);
}

function inspectContacts(issues: ResumeExportIssue[], modules: ModuleData[]) {
  const basics = modules.filter((item) => item.type === "basic");
  if (!basics.length) issues.push({ id: "contact:missing", kind: "contact", severity: "warning", moduleKey: "basic",
    moduleLabel: "基本信息", field: "contact", excerpt: "", message: "缺少基本信息模块，请补充联系方式" });
  for (const resumeModule of basics) {
    const content = (resumeModule.content ?? {}) as Record<string, unknown>;
    const phone = typeof content.phone === "string" ? content.phone.trim() : "";
    const email = typeof content.email === "string" ? content.email.trim() : "";
    for (const item of [
      { field: "phone", value: phone, label: "手机号", valid: /^\+?[\d\s().-]+$/.test(phone) && /^\d{7,15}$/.test(phone.replace(/\D/g, "")) },
      { field: "email", value: email, label: "邮箱", valid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) },
    ]) {
      if (item.valid) continue;
      issues.push({ id: JSON.stringify(["contact", resumeModule.key, item.field, item.value]), kind: "contact", severity: "warning",
        moduleKey: resumeModule.key, moduleLabel: resumeModule.label, field: item.field, excerpt: item.value,
        message: item.value ? item.label + "格式可能有误，请检查" : "请补充" + item.label });
    }
  }
}

function inspectPagination(issues: ResumeExportIssue[], { modules, paperHeight, layout = [], pageMargin = 0 }: ResumeExportCheckInput) {
  const margin = Math.max(0, pageMargin) * 96 / 25.4;
  const firstEnd = A4_HEIGHT_PX - margin;
  const pageHeight = Math.max(100, A4_HEIGHT_PX - margin * 2);
  const pageAt = (y: number) => y < firstEnd ? 1 : 2 + Math.floor((y - firstEnd) / pageHeight);
  const crossing = layout.filter((entry) => Number.isFinite(entry.top) && Number.isFinite(entry.bottom) &&
    (entry.bottom - entry.top > pageHeight || pageAt(entry.top) !== pageAt(entry.bottom - 1)));
  const targets = crossing.length ? crossing : layout.filter((entry) => entry.top >= firstEnd).slice(0, 1);
  for (const entry of targets) {
    const resumeModule = modules.find((mod) => mod.key === entry.moduleKey);
    issues.push({ id: JSON.stringify(["pagination", entry.moduleKey, entry.entryIndex, entry.top, entry.bottom]),
      kind: "pagination", severity: "warning", moduleKey: entry.moduleKey,
      moduleLabel: resumeModule?.label ?? "页面排版", entryIndex: entry.entryIndex,
      excerpt: "预计涉及第 " + pageAt(entry.top) + "–" + pageAt(entry.bottom - 1) + " 页",
      message: entry.bottom - entry.top > pageHeight ? "条目超过一页可用高度，可能被拆开，请缩短或调整排版"
        : "条目接近分页处，请检查整段换页、页尾留白和标题位置" });
  }
  if (targets.length || layout.length || paperHeight === undefined || !Number.isFinite(paperHeight)) return;
  const status = estimatePageFitStatus(paperHeight, A4_HEIGHT_PX);
  if (!status.isSinglePage) issues.push({ id: "pagination:" + Math.round(paperHeight), kind: "pagination", severity: "warning",
    moduleKey: "__layout__", moduleLabel: "页面排版", excerpt: status.heightPercent + "% A4 高度",
    message: "内容超出一页约 " + status.overflowLines + " 行，请检查分页" });
}

export function inspectResumeForExport(input: ResumeExportCheckInput): ResumeExportCheckResult {
  const { modules, title, confirmedIssueIds = new Set<string>() } = input;
  const issues: ResumeExportIssue[] = [];
  if (title) addTextIssues(issues, { key: "__title__", type: "summary", label: "简历标题", sort: -1, content: {} }, undefined, "title", title, confirmedIssueIds, false);
  for (const resumeModule of modules) inspectModuleText(issues, resumeModule, confirmedIssueIds);
  if (input.exportedContent) {
    const existing = new Set(issues.map((issue) => issue.id));
    const exported = inspectResumeForExport({ ...input.exportedContent, confirmedIssueIds });
    for (const issue of exported.blockingIssues) {
      if (!existing.has(issue.id)) issues.push({ ...issue, inExportedContent: true });
    }
  }
  inspectContacts(issues, modules);
  inspectPagination(issues, input);
  const blockingIssues = issues.filter((issue) => issue.severity === "blocking");
  const warningIssues = issues.filter((issue) => issue.severity === "warning");
  return { issues, blockingIssues, warningIssues, canExport: blockingIssues.length === 0 };
}


