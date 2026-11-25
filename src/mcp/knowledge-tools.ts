import * as z from "zod/v4";
import { previewBankImport, saveBankImport, getBankImportResult, getNotebookOrganizationContext, createMcpNotebookCategory, renameMcpNotebookCategory, moveMcpNotebookEntry } from "@/lib/mcp-knowledge";
import { contextPageInput } from "./content-tools";
import { edit, id, json, key, read, revision, write } from "./records";
import { requireReads } from "./source-access";
import type { McpTools } from "./tools";

export function registerKnowledgeTools(tools: McpTools) {
  const bank = { direction: z.string().trim().max(200).default(""), kind: z.enum(["tech", "behavior"]), text: z.string().min(1).max(100_000) };
  tools.register("preview_bank_import", { title: "预览题库批量导入", description: "逐行题目，最多 500 行；按方向、题型、完整原文去重，显示批内及已入库重复项。", inputSchema: z.strictObject({ ...bank, page: z.strictObject(contextPageInput).optional() }), annotations: read }, async ({ page = {}, ...input }) => {
    requireReads(tools, "list_bank_entries"); return json(previewBankImport(input, page));
  });
  tools.register("save_bank_import", { title: "保存已预览题库导入", description: "提交同一提案及 previewToken，一次事务保存新增题目与逐项回执；重试不重复插入。完整结果通过 get_bank_import_result 读取。", inputSchema: z.strictObject({ ...bank, previewToken: revision, idempotencyKey: key }), annotations: write }, async input => {
    requireReads(tools, "list_bank_entries", "preview_bank_import"); return json(saveBankImport(input));
  });
  tools.register("get_bank_import_result", { title: "读取题库导入逐项结果", description: "用保存时的幂等键找回各行的题目 ID、插入/已有/批内重复状态；结果在重连后保持一致。", inputSchema: z.strictObject({ idempotencyKey: key, ...contextPageInput }), annotations: read }, async ({ idempotencyKey, ...page }) => {
    requireReads(tools, "list_bank_entries"); return json(getBankImportResult(idempotencyKey, page));
  });
  tools.register("get_notebook_organization_context", { title: "读取错题分类操作上下文", description: "返回分类列表和来源 revision。改名传 categoryId；移动错题传 notebookId；创建时两者省略。", inputSchema: z.strictObject({ categoryId: id.optional(), notebookId: id.optional(), ...contextPageInput }), annotations: read }, async ({ categoryId, notebookId, ...page }) => {
    requireReads(tools, "list_notebook_categories"); if (notebookId !== undefined) requireReads(tools, "get_notebook_entry");
    return json(getNotebookOrganizationContext({ categoryId, notebookId }, page));
  });
  const category = { name: z.string().trim().min(1).max(30), expectedRevision: revision, idempotencyKey: key };
  tools.register("create_notebook_category", { title: "创建错题分类", description: "使用未指定 categoryId/notebookId 的分类上下文 revision；重试使用同一幂等键。", inputSchema: z.strictObject(category), annotations: write }, async input => {
    requireReads(tools, "list_notebook_categories", "get_notebook_organization_context"); return json(createMcpNotebookCategory(input));
  });
  tools.register("rename_notebook_category", { title: "重命名错题分类", description: "使用指定 categoryId 的分类上下文 revision，保留分类内错题。", inputSchema: z.strictObject({ categoryId: id, ...category }), annotations: edit }, async input => {
    requireReads(tools, "list_notebook_categories", "get_notebook_organization_context"); return json(renameMcpNotebookCategory(input));
  });
  tools.register("move_notebook_entry", { title: "调整错题所属分类", description: "使用指定 notebookId 的上下文 revision；categoryId=null 移到未分类。保留原答、笔记和复习状态。", inputSchema: z.strictObject({ notebookId: id, categoryId: id.nullable(), expectedRevision: revision, idempotencyKey: key }), annotations: edit }, async input => {
    requireReads(tools, "list_notebook_categories", "get_notebook_entry", "get_notebook_organization_context"); return json(moveMcpNotebookEntry(input));
  });
}
