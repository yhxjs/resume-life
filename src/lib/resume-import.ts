import { normalizeContent, type ModuleContentMap, type ModuleKey } from "@/lib/modules";
import { escapePlainTextToRichHtml } from "@/lib/rich-text";

/** 模型只提供内容，经历及副项的稳定标识由系统生成；调用前须通过模块形状校验。 */
function resetGeneratedIds(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((value: Record<string, unknown>) => ({
    ...value,
    id: "",
    ...(Array.isArray(value.subItems) ? {
      subItems: value.subItems.map((subItem: Record<string, unknown>) => ({ ...subItem, id: "" })),
    } : {}),
  }));
}

function encodeDescription<T extends { description: string; descriptionItems?: string[] }>(entry: T): T {
  const descriptionItems = entry.descriptionItems?.map(escapePlainTextToRichHtml);
  return {
    ...entry,
    description: descriptionItems?.length ? descriptionItems.join("\n") : escapePlainTextToRichHtml(entry.description),
    ...(descriptionItems ? { descriptionItems } : {}),
  };
}

/** 仅供新生成导入草稿使用：正文从纯文本转为编辑器富文本一次，抬头、副项与技能仍为纯文本。 */
export function normalizeImportedModule(key: ModuleKey, raw: unknown): ModuleContentMap[ModuleKey] {
  switch (key) {
    case "education": return normalizeContent(key, resetGeneratedIds(raw)).map(encodeDescription);
    case "work": return normalizeContent(key, resetGeneratedIds(raw)).map(encodeDescription);
    case "projects": return normalizeContent(key, resetGeneratedIds(raw)).map(encodeDescription);
    case "custom": return normalizeContent(key, resetGeneratedIds(raw)).map(encodeDescription);
    case "summary": {
      const content = normalizeContent(key, raw);
      const descriptionItems = (content.descriptionItems ?? []).map(escapePlainTextToRichHtml);
      return { ...content, text: descriptionItems.join("\n"), descriptionItems };
    }
    default: return normalizeContent(key, raw);
  }
}
