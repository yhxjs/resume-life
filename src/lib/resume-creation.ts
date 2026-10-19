import { getDb, inTransaction, now } from "./db";
import { ApplicationInputError } from "./applications";
import { DEFAULT_INITIAL_MODULE_KEYS, MODULE_LABELS, defaultContent, isModuleKey, isValidModuleContentInput, normalizeContent } from "./modules";

type ModuleRow = { module_key: string; type: string; label: string; sort: number; content: string };

function defaultModules(input: Record<string, unknown> | null = null): ModuleRow[] {
  return DEFAULT_INITIAL_MODULE_KEYS.map((key, sort) => ({
    module_key: key, type: key, label: MODULE_LABELS[key], sort,
    content: JSON.stringify(input ? normalizeContent(key, input[key]) : defaultContent(key)),
  }));
}

/** 创建/复制共用模块写入；调用方必须处于 inTransaction，任何模块失败整体回滚。 */
function insertModules(resumeId: number, modules: ModuleRow[], timestamp: string): void {
  const insert = getDb().prepare(
    "INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (const row of modules) insert.run(resumeId, row.module_key, row.type, row.label, row.sort, row.content, timestamp);
}

/** 创建写路径的 SQL 与输入规则归领域所有；输入错误→400，其余持久层错误→500。 */
export function createResume(input: unknown): { id: number; title: string } {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) throw new ApplicationInputError("简历标题不能为空");
  if (body.modules !== undefined && (body.modules === null || typeof body.modules !== "object" || Array.isArray(body.modules))) {
    throw new ApplicationInputError("modules 参数无效");
  }
  const modules = body.modules ? body.modules as Record<string, unknown> : null;
  for (const [key, content] of Object.entries(modules ?? {})) {
    if (isModuleKey(key) && !isValidModuleContentInput(key, content)) {
      throw new ApplicationInputError(`模块「${key}」内容结构无效`);
    }
  }
  return inTransaction(() => {
    const timestamp = now();
    const id = Number(getDb().prepare("INSERT INTO resumes (title, created_at, updated_at) VALUES (?, ?, ?)")
      .run(title, timestamp, timestamp).lastInsertRowid);
    insertModules(id, defaultModules(modules), timestamp);
    return { id, title };
  });
}

/** 原样复制模板/样式/模块（含损坏原文）；无模块源使用与新建一致的默认六模块。 */
export function copyResume(sourceId: number): { id: number; title: string } | null {
  return inTransaction(() => {
    const db = getDb();
    const source = db.prepare("SELECT title, template, style_overrides FROM resumes WHERE id = ?").get(sourceId) as
      { title: string; template: string; style_overrides?: string } | undefined;
    if (!source) return null;
    const timestamp = now();
    const title = `${source.title}（副本）`;
    const id = Number(db.prepare("INSERT INTO resumes (title, template, style_overrides, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(title, source.template, source.style_overrides ?? "{}", timestamp, timestamp).lastInsertRowid);
    const modules = db.prepare("SELECT module_key, type, label, sort, content FROM resume_modules WHERE resume_id = ? ORDER BY sort, id")
      .all(sourceId) as ModuleRow[];
    insertModules(id, modules.length ? modules : defaultModules(), timestamp);
    return { id, title };
  });
}
