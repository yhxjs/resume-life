import { EVALUATOR_REPORT_EXAMPLE, EVALUATOR_REPORT_PROMPT } from "@/lib/interview-report-llm";
import type { PromptPart, SafeMessage } from "@/lib/safe-llm";

export function buildInterviewEvaluatorPrompt(styleLabel: string): string {
  return `你是本次面试的面试官（${styleLabel}风格）兼用人部门技术负责人。模拟面试已完成，请生成一份【面试官视角】模拟录用评估报表（Internal Interview Feedback Sheet）。
要求：
- 语言客观具体，只评价问答中的实际表现，不揣测未提供的心理活动。
${EVALUATOR_REPORT_PROMPT}

输出严格的 JSON 格式：
${EVALUATOR_REPORT_EXAMPLE}
只返回示例列出的字段，不得添加字段；只输出合法 JSON，不要包含任何额外 Markdown 或解释文字。`;
}

export function buildInterviewEvaluatorMessages(params: {
  jd: string;
  resumeContext: string;
  turnParts: readonly PromptPart[];
  reverseParts: readonly PromptPart[];
}): SafeMessage[] {
  return [{
    role: "user",
    parts: [
      { trust: "trusted", text: "【岗位要求】\n" },
      { trust: "untrusted", tag: "job_description", text: params.jd },
      { trust: "trusted", text: "\n\n【候选人简历】\n" },
      { trust: "untrusted", tag: "candidate_resume", text: params.resumeContext },
      { trust: "trusted", text: "\n\n【全部问答】\n" },
      ...params.turnParts,
      ...params.reverseParts,
    ],
  }];
}
