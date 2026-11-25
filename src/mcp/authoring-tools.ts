import * as z from "zod/v4";
import { INTRO_KINDS, INTRO_MAX_SENTENCES, INTRO_MAX_TEXT_CHARS } from "@/lib/intro";
import { addMcpProjectMaterial, createMcpProject, previewIntroEdit, saveIntroEdit } from "@/lib/mcp-authoring";
import { requireReads } from "./source-access";
import { edit, id, json, key, page, read, revision, write } from "./records";
import type { McpTools } from "./tools";

export function registerAuthoringTools(tools: McpTools) {
  const intro = { introId: id, kind: z.enum(INTRO_KINDS), expectedRevision: revision, texts: z.array(z.string().min(1).max(INTRO_MAX_TEXT_CHARS)).min(1).max(INTRO_MAX_SENTENCES) };
  tools.register("preview_intro_edit", { title: "预览自我介绍修改", description: "输入所选版本的完整新句子列表；返回差异和绑定本次提案的 previewToken。不修改原稿。",
    inputSchema: z.strictObject({ ...intro, ...page }), annotations: read }, async input => { requireReads(tools, "get_intro"); return json(previewIntroEdit(input)); });
  tools.register("save_intro_edit", { title: "确认保存自我介绍", description: "确认差异后重发原提案、预览令牌和幂等键，仅修改该版本；改写句子清空旧点评，未改写原句保留点评。",
    inputSchema: z.strictObject({ ...intro, previewToken: revision, idempotencyKey: key }), annotations: edit }, async input => {
      requireReads(tools, "get_intro", "preview_intro_edit"); return json(saveIntroEdit(input));
    });
  tools.register("create_project", { title: "新建项目档案", description: "幂等创建空项目，返回项目 ID，不读取本机文件。",
    inputSchema: z.strictObject({ name: z.string().trim().min(1).max(200), idempotencyKey: key }), annotations: write }, async input => json(createMcpProject(input)));
  tools.register("add_project_material", { title: "追加项目纯文本材料", description: "使用 get_project 的 project.revision，原样保存给定正文，来源固定为粘贴；不接收文件路径或文件提取标记。",
    inputSchema: z.strictObject({ projectId: id, expectedRevision: revision, title: z.string().trim().min(1).max(200),
      content: z.string().min(1).max(100_000).refine(text => !!text.trim() && text.isWellFormed() && !text.includes("\u0000"), "正文必须是可完整存储的 Unicode 文本"), idempotencyKey: key }),
    annotations: write }, async input => { requireReads(tools, "get_project"); return json(addMcpProjectMaterial(input)); });
}
