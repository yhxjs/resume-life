import { getDb } from "./db";
import { normalizeStyle, type CustomTemplate } from "./templates";

export type StoredCustomTemplate = Omit<CustomTemplate, "style" | "corrupted"> & { style: string };

export class CorruptedTemplateError extends Error {
  constructor(public readonly templateId: number) {
    super(`自定义模板 ${templateId} 数据损坏，请到样式工厂修复后重新导出。`);
    this.name = "CorruptedTemplateError";
  }
}

/** 默认样式只供预览/修复；损坏标记必须保留，不能作为有效模板应用或导出。 */
export function readCustomTemplate(row: StoredCustomTemplate): CustomTemplate {
  let style = null;
  try { style = normalizeStyle(JSON.parse(row.style)); } catch { /* 保留原记录，显式标记损坏。 */ }
  return { ...row, style: style ?? normalizeStyle({})!, ...(style ? {} : { corrupted: true }) };
}

/** 只加载当前引用，避免无关坏记录阻断有效模板的导出。 */
export function loadCustomTemplate(id: number): CustomTemplate {
  const row = getDb().prepare("SELECT id, name, style, created_at, updated_at FROM resume_templates WHERE id = ?")
    .get(id) as StoredCustomTemplate | undefined;
  if (!row) throw new Error(`自定义模板 ${id} 不存在`);
  const template = readCustomTemplate(row);
  if (template.corrupted) throw new CorruptedTemplateError(id);
  return template;
}
