import { getOrderedBasicKeys, type ModuleData, type SummaryContent } from "@/lib/modules";
import { escapeMarkdownText, richTextToMarkdown, richTextToReadableText } from "@/lib/rich-text";

type TextFormat = { text: (value: string) => string; rich: (value: string) => string };

function period(start: string | undefined, end: string | undefined, format: TextFormat): string {
  if (!start?.trim() && !end?.trim()) return "";
  return `${format.text(start ?? "")} ~ ${format.text(end ?? "")}  `;
}

function line(parts: (string | undefined)[], format: TextFormat): string {
  return parts.filter((p): p is string => Boolean(p?.trim())).map(format.text).join(" | ");
}

const ENTRY_TITLE_KEYS: Record<string, string[]> = {
  education: ["school", "degree", "field"],
  work: ["company", "title"],
  projects: ["name", "role"],
  custom: ["title", "subTitle"],
};

function basicContactParts(c: Record<string, unknown>): string[] {
  const order = getOrderedBasicKeys(c.fieldOrder);
  const parts: string[] = [];
  for (const k of order) {
    if (k === "links") continue;
    const val = typeof c[k] === "string" ? (c[k] as string).trim() : "";
    if (val) parts.push(val);
  }
  return parts;
}

function section(m: ModuleData, out: string[], format: TextFormat) {
  if (m.type === "basic") {
    const c = (m.content ?? {}) as Record<string, unknown>;
    const lines = basicContactParts(c);
    if (typeof c.links === "string" && c.links.trim()) lines.push(c.links.trim());
    if (lines.length) out.push(`## ${format.text(m.label)}`, "", lines.map(format.text).join(" · "), "");
    return;
  }
  const titleKeys = ENTRY_TITLE_KEYS[m.type];
  if (titleKeys) {
    const items = (Array.isArray(m.content) ? m.content : []) as Record<string, unknown>[];
    if (!items.length) return;
    out.push(`## ${format.text(m.label)}`, "");
    for (const it of items) {
      out.push(`### ${line(titleKeys.map((k) => it[k] as string | undefined), format)}`);
      const p = period(it.start as string | undefined, it.end as string | undefined, format);
      if (p.trim()) out.push(p.trim());

      const hasSubItems =
        (m.type === "projects" || m.type === "work" || m.type === "custom") &&
        Array.isArray(it.subItems) &&
        it.subItems.length > 0;
      if (hasSubItems) {
        for (const sub of it.subItems as { label?: string; value?: string }[]) {
          const l = (sub.label ?? "").trim();
          const v = (sub.value ?? "").trim();
          if (l || v) {
            out.push(l ? `**${format.text(l)}**：${format.text(v)}` : format.text(v));
          }
        }
      }

      const hasDescriptionItems =
        (m.type === "projects" || m.type === "work" || m.type === "custom") &&
        Array.isArray(it.descriptionItems) &&
        it.descriptionItems.length > 0;
      if (hasDescriptionItems) {
        out.push("");
        const isOrdered = it.descriptionStyle === "ordered";
        (it.descriptionItems as unknown[]).forEach((desc: unknown, idx: number) => {
          const raw = typeof desc === "string" ? desc.trim() : "";
          const trimmed = format.rich(raw).trim();
          if (trimmed) {
            out.push(isOrdered ? `${idx + 1}. ${trimmed}` : `- ${trimmed}`);
          }
        });
      } else if (typeof it.description === "string" && it.description.trim()) {
        const mdDesc = format.rich(it.description).trim();
        if (mdDesc) {
          out.push("", mdDesc);
        }
      }
      out.push("");
    }
    return;
  }
  if (m.type === "skills") {
    const items = ((m.content ?? {}) as { items?: string[] }).items ?? [];
    if (items.length) out.push(`## ${format.text(m.label)}`, "", items.map((s) => `- ${format.text(s)}`).join("\n"), "");
    return;
  }
  if (m.type === "summary") {
    const summary = (m.content ?? {}) as Partial<SummaryContent>;
    const items = (summary.descriptionItems ?? []).map((item) => format.rich(item).trim()).filter(Boolean);
    if (items.length) {
      out.push(`## ${format.text(m.label)}`, "", ...items.map((item, index) => {
        const prefix = summary.descriptionStyle === "ordered" ? `${index + 1}. ` : "- ";
        return prefix + item.replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
      }), "");
    } else if (summary.text?.trim()) {
      out.push(`## ${format.text(m.label)}`, "", format.rich(summary.text).trim(), "");
    }
  }
}

function serializeResume(title: string, modules: ModuleData[], format: TextFormat): string {
  const out: string[] = [`# ${format.text(title || "简历")}`, ""];
  const basicModule = modules.find((m) => m.type === "basic");
  if (basicModule) {
    const basic = (basicModule.content ?? {}) as Record<string, unknown>;
    const contactParts = basicContactParts(basic);
    const name = typeof basic.name === "string" ? basic.name.trim() : "";
    const basicLine = [name, ...contactParts].filter(Boolean).map(format.text).join(" · ");
    if (basicLine) out.push(basicLine);
    const links = typeof basic.links === "string" ? basic.links.trim() : "";
    if (links) out.push(format.text(links));
    if (basicLine || links) out.push("");
  }
  for (const m of modules) {
    if (m === basicModule) continue;
    section(m, out, format);
  }
  return out.join("\n");
}

/** 下载文件使用 Markdown 转义，保留用户可见正文。 */
export function resumeToMarkdown(title: string, modules: ModuleData[]): string {
  return serializeResume(title, modules, { text: escapeMarkdownText, rich: richTextToMarkdown });
}

/** 页面 pre 与版本对比使用可读字符，保留原有标题、加粗和列表标记。 */
export function resumeToReadableText(title: string, modules: ModuleData[]): string {
  return serializeResume(title, modules, { text: value => value, rich: richTextToReadableText });
}
