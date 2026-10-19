import { isLocalAvatarUrl, getOrderedBasicKeys, type ModuleData } from "@/lib/modules";

export type PreparedSubItem = { label: string; value: string };

export type PreparedEntry = {
  title: string;
  sub: string;
  period: string;
  body: string;
  subItems?: PreparedSubItem[];
  descriptionItems?: string[];
  descriptionStyle?: "unordered" | "ordered";
};

export type PreparedSection =
  | { kind: "entries"; moduleKey: string; label: string; items: PreparedEntry[] }
  | { kind: "skills"; moduleKey: string; label: string; items: string[] }
  | {
      kind: "text";
      moduleKey: string;
      label: string;
      text: string;
      descriptionItems?: string[];
      descriptionStyle?: "unordered" | "ordered";
    }
  | { kind: "contact"; moduleKey: string; label: string; lines: string[] };

export type Prepared = {
  title: string;
  basicModuleKey?: string;
  name: string;
  contact: string;
  contactParts: string[];
  links: string[];
  sections: PreparedSection[];
  avatar?: string;
  avatarX?: number;
  avatarY?: number;
  avatarSize?: number;
  avatarShape?: "circle" | "rounded" | "square";
};

export function joinNonEmpty(parts: (string | undefined)[], sep = " · "): string {
  return parts.filter((p) => p && p.trim()).join(sep);
}

function period(start?: string, end?: string): string {
  if (!start?.trim() && !end?.trim()) return "";
  return `${start ?? ""} ~ ${end ?? ""}`;
}

/** 条目型内容的展示键：title 主标题、sub 副标题 */
const ENTRY_KEYS: Record<string, { title: string[]; sub: string[] }> = {
  education: { title: ["school"], sub: ["degree", "field"] },
  work: { title: ["company"], sub: ["title"] },
  projects: { title: ["name"], sub: ["role"] },
  custom: { title: ["title"], sub: ["subTitle"] },
};

function basicLines(c: Record<string, unknown>): string[] {
  const order = getOrderedBasicKeys(c.fieldOrder);
  const lines: string[] = [];
  for (const k of order) {
    if (k === "links") {
      for (const link of (typeof c.links === "string" ? c.links : "").split("\n")) {
        const t = link.trim();
        if (t) lines.push(t);
      }
    } else {
      const val = typeof c[k] === "string" ? (c[k] as string).trim() : "";
      if (val) lines.push(val);
    }
  }
  return lines;
}

/** 把简历数据（含未保存草稿）整理成文档渲染所需的结构：
 * 第一个 basic 模块作为页眉（姓名/联系方式），其余模块按顺序渲染为小节 */
export function prepare(
  title: string,
  modules: (Pick<ModuleData, "type" | "label" | "content"> & { key?: string })[]
): Prepared {
  let header: Record<string, string> | null = null;
  let basicModuleKey: string | undefined = undefined;
  const sections: PreparedSection[] = [];

  for (const m of modules) {
    const modKey = m.key || m.type;
    if (m.type === "basic") {
      const c = (m.content ?? {}) as Record<string, string>;
      if (!header) {
        header = c;
        basicModuleKey = modKey;
        continue;
      }
      const lines = basicLines(c);
      if (lines.length) sections.push({ kind: "contact", moduleKey: modKey, label: m.label, lines });
      continue;
    }
    const entryKeys = ENTRY_KEYS[m.type as string];
    if (entryKeys) {
      const items = (Array.isArray(m.content) ? m.content : []) as Record<string, unknown>[];
      const entries = items.map((it) => {
        const rawSub = it.subItems;
        const subItems: PreparedSubItem[] = Array.isArray(rawSub)
          ? rawSub
              .map((s) => {
                const itemObj = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
                return {
                  label: typeof itemObj.label === "string" ? itemObj.label.trim() : "",
                  value: typeof itemObj.value === "string" ? itemObj.value.trim() : "",
                };
              })
              .filter((s) => s.label || s.value)
          : [];

        const rawDescItems = it.descriptionItems;
        const descriptionItems: string[] = Array.isArray(rawDescItems)
          ? rawDescItems
              .filter((d): d is string => typeof d === "string")
              .map((d) => d.trim())
              .filter(Boolean)
          : [];

        const descriptionStyle: "ordered" | "unordered" =
          it.descriptionStyle === "ordered" ? "ordered" : "unordered";

        const body = typeof it.description === "string" ? it.description.trim() : "";

        return {
          title: joinNonEmpty(entryKeys.title.map((k) => it[k] as string | undefined)),
          sub: joinNonEmpty(entryKeys.sub.map((k) => it[k] as string | undefined)),
          period: period(it.start as string | undefined, it.end as string | undefined),
          body: body,
          subItems: subItems.length > 0 ? subItems : undefined,
          descriptionItems: descriptionItems.length > 0 ? descriptionItems : undefined,
          descriptionStyle,
        };
      });
      if (entries.length) sections.push({ kind: "entries", moduleKey: modKey, label: m.label, items: entries });
      continue;
    }
    if (m.type === "skills") {
      const items = ((m.content ?? {}) as { items?: string[] }).items ?? [];
      if (items.length) sections.push({ kind: "skills", moduleKey: modKey, label: m.label, items });
      continue;
    }
    if (m.type === "summary") {
      const c = (m.content ?? {}) as {
        text?: string;
        descriptionItems?: string[];
        descriptionStyle?: "unordered" | "ordered";
      };
      const rawDescItems = c.descriptionItems;
      const descriptionItems = Array.isArray(rawDescItems) && rawDescItems.length > 0
        ? rawDescItems
            .filter((d): d is string => typeof d === "string")
            .map((d) => d.trim())
            .filter(Boolean)
        : typeof c.text === "string" && c.text.trim()
          ? c.text
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
          : [];

      const descriptionStyle: "ordered" | "unordered" =
        c.descriptionStyle === "ordered" ? "ordered" : "unordered";
      const text = (typeof c.text === "string" ? c.text : "").trim();

      if (descriptionItems.length > 0 || text) {
        sections.push({
          kind: "text",
          moduleKey: modKey,
          label: m.label,
          text,
          descriptionItems: descriptionItems.length > 0 ? descriptionItems : undefined,
          descriptionStyle,
        });
      }
    }
  }

  const headerRecord = header as Record<string, unknown> | null;
  const avatar = typeof headerRecord?.avatar === "string" && isLocalAvatarUrl(headerRecord.avatar.trim())
    ? headerRecord.avatar.trim()
    : "";
  const avatarX = typeof headerRecord?.avatarX === "number" ? headerRecord.avatarX : 0;
  const avatarY = typeof headerRecord?.avatarY === "number" ? headerRecord.avatarY : 0;
  const avatarSize = typeof headerRecord?.avatarSize === "number" ? headerRecord.avatarSize : 80;
  const avatarShape =
    headerRecord?.avatarShape === "square" || headerRecord?.avatarShape === "rounded"
      ? headerRecord.avatarShape
      : "circle";

  const contactParts: string[] = [];
  if (header) {
    const order = getOrderedBasicKeys(header.fieldOrder);
    for (const k of order) {
      if (k === "links") continue;
      const val = typeof header[k] === "string" ? (header[k] as string).trim() : "";
      if (val) contactParts.push(val);
    }
  }

  return {
    title,
    basicModuleKey,
    name: (header?.name ?? "").trim() || title,
    contact: header ? joinNonEmpty(contactParts) : "",
    contactParts,
    links: header
      ? (header.links ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    sections,
    avatar: avatar || undefined,
    avatarX,
    avatarY,
    avatarSize,
    avatarShape,
  };
}

