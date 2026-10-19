import type { ProjectItem, WorkItem } from "@/lib/modules";
import { isHeaderLine, stripDraftHeaders, type PolishContext } from "@/lib/polish";
import { splitRichTextToLines } from "@/lib/rich-text";


export type DescribableItem = {
  id: string;
  
  title: string;
  
  text: string;
  
  context: PolishContext;
};

function asRecords(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function joinParts(parts: (string | undefined)[]): string {
  return parts.filter((p) => p && p.trim()).join(" · ");
}


export function readDescribableItems(
  type: "work" | "projects",
  content: unknown
): DescribableItem[] {
  const items: DescribableItem[] = [];
  for (const raw of asRecords(content)) {
    const id = str(raw.id);
    if (!id) continue;

    if (type === "work") {
      const w = raw as WorkItem;
      const lines = Array.isArray(w.descriptionItems)
        ? w.descriptionItems.filter((x): x is string => typeof x === "string")
        : [];
      const rawText = lines.length > 0 ? lines.join("\n") : str(w.description);
      const ctx = { company: str(w.company), title: str(w.title) };
      items.push({
        id,
        title: joinParts([w.company, w.title]),
        text: stripDraftHeaders(rawText, ctx),
        context: ctx,
      });
      continue;
    }

    const p = raw as ProjectItem;
    const lines = Array.isArray(p.descriptionItems)
      ? p.descriptionItems.filter((x): x is string => typeof x === "string")
      : [];
    const rawText = lines.length > 0 ? lines.join("\n") : str(p.description);
    const ctx = { name: str(p.name), role: str(p.role) };
    items.push({
      id,
      title: joinParts([p.name, p.role]),
      text: stripDraftHeaders(rawText, ctx),
      context: ctx,
    });
  }
  return items;
}


export function writeDescribableItem(
  type: "work" | "projects",
  content: unknown,
  id: string,
  text: string
): unknown {
  if (!Array.isArray(content)) return content;
  return asRecords(content).map((raw) => {
    if (str(raw.id) !== id) return raw;

    const polishCtx =
      type === "work"
        ? { company: str(raw.company), title: str(raw.title) }
        : { name: str(raw.name), role: str(raw.role) };
    const cleanText = stripDraftHeaders(text, polishCtx);
    const lines = splitRichTextToLines(cleanText);
    const filteredLines = lines.filter((l) => !isHeaderLine(l, polishCtx));
    return {
      ...raw,
      descriptionItems: filteredLines,
      description: filteredLines.join("\n"),
    };
  });
}


export function writeDiagnosisValue(
  type: "work" | "projects" | "education" | "summary",
  content: unknown,
  id: string,
  text: string
): unknown | null {
  if (type === "summary") {
    if (!content || typeof content !== "object" || Array.isArray(content)) return null;
    const descriptionItems = splitRichTextToLines(text);
    return { ...content, text: descriptionItems.join("\n"), descriptionItems };
  }
  if (!Array.isArray(content)) return null;
  if (!asRecords(content).some((raw) => str(raw.id) === id)) return null;
  // education 的 normalizeContent 分支不产出 descriptionItems，
  // 只写 description 就落得住；work/projects 走共用规则。
  if (type === "education") {
    return asRecords(content).map((raw) =>
      str(raw.id) === id ? { ...raw, description: text } : raw
    );
  }
  return writeDescribableItem(type, content, id, text);
}
