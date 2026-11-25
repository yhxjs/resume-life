import * as z from "zod/v4";
import type { McpTools } from "./tools";
import { id, revision, read, edit, page, json } from "./records";
import { PREPARATION_KINDS } from "@/lib/application-preparation-types";
import { getMcpPreparationMaterial, listMcpDiagnoses, listMcpPreparationResources, setMcpPreparationResource } from "@/lib/mcp-materials";

export function registerMaterialTools(tools: McpTools) {
  tools.register("list_application_preparation_resources", { title: "读取岗位关联或候选准备资料",
    description: "按资料类型分页读取 JD 画像、诊断、自我介绍、模拟／进阶面试和错题。candidates=true 查找尚未关联的资料；revision 用于 set_preparation_resource，长正文用 fullContent 读全。",
    inputSchema: z.strictObject({ applicationId: id, kind: z.enum(PREPARATION_KINDS), candidates: z.boolean().optional(), ...page }), annotations: read },
  async input => json(listMcpPreparationResources(input)));
  tools.register("set_preparation_resource", { title: "关联或取消关联准备资料",
    description: "使用刚读取准备资料列表的 revision，将指定资料关联到投递或取消关联；linked=false 只取消关联。只返回操作身份，不返回资料正文。",
    inputSchema: z.strictObject({ applicationId: id, kind: z.enum(PREPARATION_KINDS), resourceId: id, linked: z.boolean(), expectedRevision: revision }), annotations: edit },
  async input => json(setMcpPreparationResource(input)));
  tools.register("list_resume_diagnoses", { title: "分页读取简历诊断历史",
    description: "读取简历的诊断历史元数据，可按投递关联筛选；完整报告与原始简历快照用 get_resume_diagnosis 或 fullContent 读取。",
    inputSchema: z.strictObject({ resumeId: id, applicationId: id.optional(), ...page }), annotations: read },
  async input => json(listMcpDiagnoses(input)));
  for (const [name, kind, title] of [
    ["get_resume_diagnosis", "resume_diagnosis", "读取诊断报告与快照"], ["get_jd_portrait", "jd_portrait", "读取 JD 考点画像"],
    ["get_intro", "intro", "读取自我介绍及双版原稿"], ["get_interview_series", "interview_series", "读取进阶面试系列"],
  ] as const) {
    tools.register(name, { title, description: "读取准备资料摘要及完整正文入口；历史异常资料保持只读并显式标记。自我介绍保留各版本的 revision，系列保留各轮面试 ID。",
      inputSchema: z.strictObject({ id }), annotations: read }, async ({ id }) => json(getMcpPreparationMaterial(kind, id)));
  }
}
