import { getDb, inTransaction } from "./db";
import { MAX_BANK_IMPORT, type BankKind } from "./bank";
import { insertBankQuestions } from "./bank-storage";
import { createNotebookCategory, renameNotebookCategory, moveNotebookEntry } from "./notebook-category-store";
import { assertMcpContext, mcpContextPage, mcpContextRevision, type ContextPageInput } from "./mcp-context";
import { mcpCreateOnce, mcpCreateWithResult, readMcpOperationResult } from "./mcp-state";
import { McpOperationError } from "./mcp-errors";

export type BankImport = { direction: string; kind: BankKind; text: string };
function prepareImport(input: BankImport) {
  const questions = input.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!questions.length || questions.length > MAX_BANK_IMPORT) throw new McpOperationError("INVALID_ARGUMENT", `每次提交 1–${MAX_BANK_IMPORT} 行非空题目`);
  const lookup = getDb().prepare("SELECT id FROM bank_entries WHERE direction=? AND kind=? AND question=? ORDER BY id LIMIT 1");
  const first = new Map<string, number>();
  const items = questions.map((question, index) => {
    const duplicateOf = first.get(question) ?? null;
    if (duplicateOf === null) first.set(question, index);
    const existing = lookup.get(input.direction, input.kind, question) as { id: number } | undefined;
    return { index, question, duplicateOf, existingId: existing?.id ?? null, action: duplicateOf !== null ? "duplicate" : existing ? "existing" : "insert" };
  });
  return { direction: input.direction, kind: input.kind, items,
    instructions: "按同方向、题型及清理首尾空白后的完整原文去重；批内重复保留逐项对应关系。保存后用幂等键读取完整结果。" };
}
export function previewBankImport(input: BankImport, page: ContextPageInput) {
  return inTransaction(() => { const result = prepareImport(input); return { ...mcpContextPage(result, page), previewToken: mcpContextRevision(result) }; });
}
export function saveBankImport(input: BankImport & { previewToken: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  const saved = mcpCreateWithResult("save_bank_import", idempotencyKey, payload, () => {
    const prepared = prepareImport(input); assertMcpContext(prepared, input.previewToken);
    const inserted = insertBankQuestions(input.direction, input.kind, prepared.items.filter(item => item.action === "insert").map(item => item.question));
    const ids = new Map<string, number>(); let position = 0;
    const items = prepared.items.map(item => {
      const id = item.action === "insert" ? inserted[position++]! : item.existingId ?? ids.get(item.question)!;
      ids.set(item.question, id);
      return { index: item.index, id, action: item.action, duplicateOf: item.duplicateOf };
    });
    return { id: items[0]!.id, createdCount: inserted.length, skippedCount: items.length - inserted.length, items };
  }, id => !!getDb().prepare("SELECT 1 FROM bank_entries WHERE id=?").get(id));
  return { id: saved.id, createdCount: saved.createdCount, skippedCount: saved.skippedCount, result: { tool: "get_bank_import_result" as const, idempotencyKey } };
}
export function getBankImportResult(key: string, page: ContextPageInput) {
  return inTransaction(() => mcpContextPage(readMcpOperationResult("save_bank_import", key), page));
}
function categoryContext(input: { categoryId?: number; notebookId?: number }) {
  const categories = getDb().prepare("SELECT id,name,created_at FROM notebook_categories ORDER BY id").all();
  const notebook = input.notebookId === undefined ? null : getDb().prepare("SELECT id,category_id,updated_at FROM notebook_entries WHERE id=?").get(input.notebookId);
  if (input.notebookId !== undefined && !notebook) throw new McpOperationError("NOT_FOUND", "错题不存在");
  if (input.categoryId !== undefined && !categories.some(row => row.id === input.categoryId)) throw new McpOperationError("NOT_FOUND", "分类不存在");
  return { workflow: "notebook-categories", ...input, categories, notebook,
    instructions: "创建或改名分类使用分类上下文；移动错题时指定 notebookId 读取后提交 categoryId，null 表示未分类。移动仅改变分类。" };
}
export function getNotebookOrganizationContext(input: { categoryId?: number; notebookId?: number }, page: ContextPageInput) {
  return inTransaction(() => mcpContextPage(categoryContext(input), page));
}
export function createMcpNotebookCategory(input: { name: string; expectedRevision: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("create_notebook_category", idempotencyKey, payload, () => {
    assertMcpContext(categoryContext({}), input.expectedRevision); return createNotebookCategory(input.name);
  }, id => !!getDb().prepare("SELECT 1 FROM notebook_categories WHERE id=?").get(id));
}
export function renameMcpNotebookCategory(input: { categoryId: number; name: string; expectedRevision: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("rename_notebook_category", idempotencyKey, payload, () => {
    assertMcpContext(categoryContext({ categoryId: input.categoryId }), input.expectedRevision); return renameNotebookCategory(input.categoryId, input.name);
  }, id => !!getDb().prepare("SELECT 1 FROM notebook_categories WHERE id=?").get(id));
}
export function moveMcpNotebookEntry(input: { notebookId: number; categoryId: number | null; expectedRevision: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("move_notebook_entry", idempotencyKey, payload, () => {
    assertMcpContext(categoryContext({ notebookId: input.notebookId }), input.expectedRevision); return moveNotebookEntry(input.notebookId, input.categoryId);
  }, id => !!getDb().prepare("SELECT 1 FROM notebook_entries WHERE id=?").get(id));
}
