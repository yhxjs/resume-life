import { getDb, inTransaction, now } from "./db";
import { ApplicationInputError } from "./applications";
import { customRef, normalizeStyle, type CustomTemplate } from "./templates";
import { readCustomTemplate, type StoredCustomTemplate } from "./custom-templates";
import { clearEntityLlmLabels } from "./llm-label-cleanup";

export function listCustomTemplates(): CustomTemplate[] {
  return (getDb().prepare("SELECT id,name,style,created_at,updated_at FROM resume_templates ORDER BY id").all() as StoredCustomTemplate[]).map(readCustomTemplate);
}
function bodyOf(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApplicationInputError("请求体无效");
  return input as Record<string, unknown>;
}
function nameOf(raw: unknown) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new ApplicationInputError("模板名称不能为空");
  if (name.length > 30) throw new ApplicationInputError("模板名称不能超过 30 字");
  return name;
}
export function createCustomTemplate(input: unknown): CustomTemplate {
  const body = bodyOf(input), name = nameOf(body.name), style = normalizeStyle(body.style);
  if (!style) throw new ApplicationInputError("样式参数无效");
  return inTransaction(() => {
    const timestamp = now();
    const id = Number(getDb().prepare("INSERT INTO resume_templates(name,style,created_at,updated_at) VALUES(?,?,?,?)").run(name, JSON.stringify(style), timestamp, timestamp).lastInsertRowid);
    return { id, name, style, created_at: timestamp, updated_at: timestamp };
  });
}
export function normalizeTemplateUpdate(input: unknown) {
  const body = bodyOf(input);
  const name = body.name === undefined ? undefined : nameOf(body.name);
  const style = body.style === undefined ? undefined : normalizeStyle(body.style);
  if (style === null) throw new ApplicationInputError("样式参数无效");
  if (name === undefined && style === undefined) throw new ApplicationInputError("没有需要保存的修改");
  return { name, style };
}
export function updateCustomTemplate(id: number, input: unknown): CustomTemplate | null {
  const patch = normalizeTemplateUpdate(input);
  return inTransaction(() => {
    const db = getDb(), row = db.prepare("SELECT id,name,style,created_at,updated_at FROM resume_templates WHERE id=?").get(id) as StoredCustomTemplate | undefined;
    if (!row) return null;
    const after = { ...row, name: patch.name ?? row.name, style: patch.style ? JSON.stringify(patch.style) : row.style, updated_at: now() };
    db.prepare("UPDATE resume_templates SET name=?,style=?,updated_at=? WHERE id=?").run(after.name, after.style, after.updated_at, id);
    return readCustomTemplate(after);
  });
}
export function deleteCustomTemplate(id: number): boolean {
  return inTransaction(() => {
    const db = getDb(); clearEntityLlmLabels(db, "template", id);
    if (!db.prepare("DELETE FROM resume_templates WHERE id=?").run(id).changes) return false;
    db.prepare("UPDATE resumes SET template='classic',updated_at=? WHERE template=?").run(now(), customRef(id));
    return true;
  });
}
