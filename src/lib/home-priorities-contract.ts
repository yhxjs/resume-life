import { parseCanonicalStoredId } from "./id-parsing";

export type HomePriority = {
  id: string;
  kind: "interview" | "materials" | "review";
  title: string;
  reason: string;
  badge: string;
  urgent: boolean;
  href: string;
  action: string;
};

export type HomePriorities = {
  date: string;
  items: HomePriority[];
};

/** 历史非正主键仍保留提醒，通过看板查看，避免跳到只接受正 ID 的准备页。 */
export function getHomeApplicationHref(id: number): string {
  return id > 0 ? `/applications/${id}/prepare` : "/applications";
}

/** 推荐只能指向所属投递的准备页、历史记录看板或复习工作台。 */
export function readHomePriorities(value: unknown): HomePriorities {
  const invalid = (): never => { throw new Error("今日重点读取不完整，请重试"); };
  if (!value || typeof value !== "object") return invalid();
  const data = value as Record<string, unknown>;
  if (typeof data.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)
    || !Array.isArray(data.items) || data.items.length > 3) return invalid();
  const ids = new Set<string>();
  for (const value of data.items) {
    if (!value || typeof value !== "object") return invalid();
    const item = value as Record<string, unknown>;
    for (const key of ["id", "title", "reason", "badge", "href", "action"]) {
      if (typeof item[key] !== "string" || !item[key].trim()) return invalid();
    }
    if (!["interview", "materials", "review"].includes(item.kind as string)
      || typeof item.urgent !== "boolean" || ids.has(item.id as string)) return invalid();
    if (item.kind === "review") {
      if (item.id !== "reviews" || item.href !== "/reviews") return invalid();
    } else {
      if (!(item.id as string).startsWith("application-")) return invalid();
      const id = parseCanonicalStoredId((item.id as string).slice("application-".length));
      if (!Number.isSafeInteger(id) || item.href !== getHomeApplicationHref(id)) return invalid();
    }
    ids.add(item.id as string);
  }
  return value as HomePriorities;
}

