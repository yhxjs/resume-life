import { getDb, inTransaction, now } from "./db";
import { createHash } from "node:crypto";
import { ApplicationInputError } from "./applications";
import { isResumeCreationRequestId, type ResumeCreationReceipt } from "./resume-creation-contract";
import { DEFAULT_INITIAL_MODULE_KEYS, MODULE_LABELS, defaultContent, genModuleKey, isModuleKey, isValidModuleContentInput, normalizeContent } from "./modules";

type ModuleRow = { module_key: string; type: string; label: string; sort: number; content: string };

export class ResumeCreationConflictError extends Error {
  constructor(message: string, readonly status: 409 | 410) { super(message); }
}

/** 只排序对象字段，保留数组顺序、富文本、空白与正文字符。 */
function canonicalInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalInput);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonicalInput(entry)]));
  return value;
}

export function readResumeCreationRequest(requestId: string): ResumeCreationReceipt | null {
  const row = getDb().prepare("SELECT resume_id FROM resume_creation_requests WHERE request_id=?").get(requestId) as { resume_id: number | null } | undefined;
  return row ? row.resume_id === null ? { status: "deleted" } : { status: "succeeded", id: row.resume_id } : null;
}

/** BEGIN IMMEDIATE 覆盖查重、完整简历写入和回执；失败全部回滚，跨进程重放不新增。 */
export function createResumeRequest(input: unknown, requestId: string): { result: { id: number; title: string }; replayed: boolean } {
  if (!isResumeCreationRequestId(requestId)) throw new ApplicationInputError("创建请求编号无效");
  const { title, modules } = resumeInput(input);
  const hash = createHash("sha256").update(JSON.stringify(canonicalInput({ title, modules }))).digest("hex");
  return inTransaction(() => {
    const db = getDb();
    const previous = db.prepare("SELECT input_hash,resume_id FROM resume_creation_requests WHERE request_id=?").get(requestId) as { input_hash: string; resume_id: number | null } | undefined;
    if (previous) {
      if (previous.input_hash !== hash) throw new ResumeCreationConflictError("创建请求编号已用于另一份草稿，请核对原导入结果", 409);
      if (previous.resume_id === null) throw new ResumeCreationConflictError("该次创建的简历已删除，不会重复创建", 410);
      const resume = db.prepare("SELECT id,title FROM resumes WHERE id=?").get(previous.resume_id) as { id: number; title: string } | undefined;
      if (!resume) throw new Error("简历创建回执引用异常");
      return { result: resume, replayed: true };
    }
    const result = createResume(input);
    db.prepare("INSERT INTO resume_creation_requests (request_id,input_hash,resume_id,created_at) VALUES (?,?,?,?)").run(requestId, hash, result.id, now());
    return { result, replayed: false };
  });
}

function defaultModules(input: Record<string, unknown> | null = null): ModuleRow[] {
  const modules: ModuleRow[] = DEFAULT_INITIAL_MODULE_KEYS.map((key, sort) => ({
    module_key: key, type: key, label: MODULE_LABELS[key], sort,
    content: JSON.stringify(input ? normalizeContent(key, input[key]) : defaultContent(key)),
  }));
  const custom = normalizeContent("custom", input?.custom);
  if (custom.length) {
    modules.push({ module_key: genModuleKey(), type: "custom", label: MODULE_LABELS.custom,
      sort: modules.length, content: JSON.stringify(custom) });
  }
  return modules;
}

/** 创建/复制共用模块写入；调用方必须处于 inTransaction，任何模块失败整体回滚。 */
function insertModules(resumeId: number, modules: ModuleRow[], timestamp: string): void {
  const insert = getDb().prepare(
    "INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (const row of modules) insert.run(resumeId, row.module_key, row.type, row.label, row.sort, row.content, timestamp);
}

function resumeInput(input: unknown): { title: string; modules: Record<string, unknown> | null } {
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
  return { title, modules };
}

/** 创建写路径的 SQL 与输入规则归领域所有；输入错误→400，其余持久层错误→500。 */
export function createResume(input: unknown): { id: number; title: string } {
  const { title, modules } = resumeInput(input);
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
