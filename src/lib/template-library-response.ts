import { normalizeStyle, type CustomTemplate } from "@/lib/templates";

/** 客户端读取完整模板列表：残缺/重复行不能用来证明删除完成。 */
export function readTemplateList(value: unknown): CustomTemplate[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items)) throw new Error("模板列表响应不完整");
  const ids = new Set<number>();
  return (value as { items: unknown[] }).items.map(item => {
    const template = readTemplateResponse(item);
    if (ids.has(template.id)) throw new Error("模板列表包含重复记录");
    ids.add(template.id);
    return template;
  });
}

export function readTemplateResponse(value: unknown, expectedId?: number): CustomTemplate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模板响应不完整");
  const item = value as Partial<CustomTemplate>;
  if (!Number.isSafeInteger(item.id) || Number(item.id) <= 0 || (expectedId !== undefined && item.id !== expectedId)
    || typeof item.name !== "string" || typeof item.created_at !== "string" || typeof item.updated_at !== "string"
    || (item.corrupted !== undefined && typeof item.corrupted !== "boolean") || !normalizeStyle(item.style)) throw new Error("模板响应不完整或对象不符");
  return item as CustomTemplate;
}
