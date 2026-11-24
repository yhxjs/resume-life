import * as z from "zod/v4";
import type { McpTools } from "./tools";
import { id, revision, read, edit, json } from "./records";
import { generateMcpPreparationPlan, rescheduleMcpInterview, updateMcpPreparationTask } from "@/lib/mcp-write";
import { getMcpInterviewQuestions, saveMcpInterviewQuestions } from "@/lib/mcp-interview-questions";

export function registerBusinessTools(tools: McpTools) {
  tools.register("generate_preparation_plan", { title: "生成或刷新岗位准备计划",
    description: "根据已保存的岗位资料建立准备步骤，不调用模型。使用刚读取计划的 revision 和 contextKey；相同岗位上下文保留手动完成项，资料变化后重新建立进度。",
    inputSchema: z.strictObject({ applicationId: id, expectedRevision: revision, contextKey: revision }), annotations: edit },
  async input => json(generateMcpPreparationPlan(input, tools.permits("get_preparation_plan"))));
  tools.register("update_preparation_task", { title: "完成、重开或修改准备待办",
    description: "修改自定义待办的完成状态、内容或截止时间。expectedRevision 取自最新 get_application；dueTime 为空串表示清除截止时间，非空时须带时区。只返回待办 ID。",
    inputSchema: z.strictObject({ applicationId: id, taskId: id, expectedRevision: revision, done: z.boolean().optional(), title: z.string().trim().min(1).max(200).optional(), dueTime: z.string().max(40).optional() })
      .refine(input => input.done !== undefined || input.title !== undefined || input.dueTime !== undefined, "至少提供一个待更新字段"), annotations: edit },
  async input => json(updateMcpPreparationTask(input)));
  tools.register("reschedule_application_interview", { title: "修改真实面试时间",
    description: "为投递的真实面试轮次改期，使用最新 get_application 的 revision 和带时区 ISO 时间；同步更新投递的下一场面试时间。只返回轮次 ID。",
    inputSchema: z.strictObject({ applicationId: id, interviewId: id, expectedRevision: revision, interview_time: z.string().min(1).max(40) }), annotations: edit },
  async input => json(rescheduleMcpInterview(input)));
  tools.register("get_application_interview_questions", { title: "读取真实面试逐题记录",
    description: "读取真实面试轮次已保存的提问、回答、卡点和反馈，返回提交所需 revision；长内容用 fullContent 分段读全。",
    inputSchema: z.strictObject({ applicationId: id, interviewId: id }), annotations: read },
  async ({ applicationId, interviewId }) => json(getMcpInterviewQuestions(applicationId, interviewId)));
  tools.register("save_application_interview_questions", { title: "保存真实面试逐题记录",
    description: "替换真实面试轮次的逐题记录，不调用模型。使用刚读取逐题记录的 revision，最多 20 题、总计 32000 字；questions=[] 清空记录。只返回轮次 ID。",
    inputSchema: z.strictObject({ applicationId: id, interviewId: id, expectedRevision: revision,
      questions: z.array(z.strictObject({ question: z.string().trim().min(1).max(2000), answer: z.string().trim().max(2000).default(""), stuck: z.string().trim().max(2000).default(""), feedback: z.string().trim().max(2000).default("") })).max(20) }), annotations: edit },
  async input => json(saveMcpInterviewQuestions(input)));
}
