import { EVALUATOR_REPORT_EXAMPLE, EVALUATOR_REPORT_PROMPT, INTERVIEW_MINING_OUTPUT_RULES, INTERVIEW_REPORT_SUMMARY_OUTPUT_RULES } from "@/lib/interview-report-llm";
import { INTERVIEW_MATCH_SCORE_RULE } from "@/lib/prompt-guidelines";
import type { PromptPart, SafeMessage } from "@/lib/safe-llm";

export function buildInterviewFinishPrompt(params: { isMining: boolean; styleLabel: string }) {
  const summaryRules = params.isMining
    ? `${INTERVIEW_MATCH_SCORE_RULE}\n${INTERVIEW_REPORT_SUMMARY_OUTPUT_RULES}\n${INTERVIEW_MINING_OUTPUT_RULES}`
    : `${INTERVIEW_MATCH_SCORE_RULE}\n${INTERVIEW_REPORT_SUMMARY_OUTPUT_RULES}`;
  const sourceRule = "复盘、mining_summary 与 evaluator_report 中的每项‘本场确认/候选人自述’均须对应本场原答。简历只能帮助理解明确指代；候选人记不清项目或只说日常维护时，不能自动借用简历中的业务名、回归测试类型或团队修复补成这段已确认经历。仅简历提及且未在原答确认的细节可列为待核实背景，不能写入 actions、contribution、resume_bullets 或本场能力证据。评价澄清或更正行为前，先定位其对应的原话：更正旧答须有原答明确撤回的先前说法，纠正题目预设须有原题实际包含的预设。若只是说明本次谈哪段经历，就按经历范围整理；与简历背景不同本身不证明发生过更正，也不构成前后矛盾。";
  return params.isMining
    ? `你是经历挖掘访谈官（${params.styleLabel}风格）兼资深简历教练。本次经历挖掘访谈已结束。
你需要依据本次提供的材料与问答复盘，候选人可能仍记不清部分经历；只整理已确认的信息，产出两项核心成果与评估表：
${sourceRule}
1. 候选人复盘总结（岗位匹配分、强项亮点、短板与改进建议）。
2. 【经历全景与草稿清单（mining_summary）】：
   - project_name：候选人明确提供的项目或实践名称；未说明名称时用空字符串，不按工作内容命名一个新项目。
   - background：已确认的任务背景、目标与约束；日常维护或执行任务也可如实整理，不预设立项痛点、业务瓶颈或架构难题。
   - actions：候选人明确确认的实际行动及相关方法；协作、维护、测试、文档与执行工作均可记录，不升级为架构设计、攻关或独立交付。
   - tradeoffs：候选人实际参与且已说明依据的选择、约束或取舍，不限于架构决策；没有技术选型权时仍可记录已说明的任务优先级、验证方法等实际选择，但不补写架构选型。未提供实际取舍及其依据时留空，不从通用知识补写备选方案、踩坑或决策理由。
   - results：已确认的结果，包括定性观察、未达成目标和尚未验证的状态；计划、目标与预期收益不能写成已交付、已上线或实测成果，不能用行动本身推断产生了业务价值。
   - 环境、个人任务状态与整体项目阶段分别按原答保留。“在联调环境完成测试记录”只说明这项工作，不能推出整个项目“处于联调或回归验证阶段”；未提供整体阶段时不补写。
   - contribution：候选人已确认的实际角色、职责与个人产出，不预设主导或不可替代。
   - pending_confirmations：待确认材料与信息清单（将访谈中候选人说不清、遗忘、含糊、或建议回溯原工程代码/监控/找同事求证的指标与细节列出，数组包含 category、item、source_hint）。
   - resume_bullets：通常 3-5 条有事实依据的简历草稿，事实不足时少写；无可写入简历的确认事实时返回 []。只使用候选人明确确认的行动与结果，不为凑条数补造数字与个人贡献。
   - 每条 resume_bullet 可单独采纳，采用某项行动或结果时，在本条保留适用的分工、环境、未上线或未验证等限定；不能靠另一条专门说明状态。只有一项贡献时合为一条完整事实，不拆成“工作一句、限制一句”凑条数。
   - 上述六个文本字段必须完整返回，未知字段用空字符串 ""，不要用“待核实”冒充已知事实；缺失或矛盾信息放入 pending_confirmations。没有待确认项时该数组为 []；有条目时 category、item、source_hint 均为非空文本，source_hint 是建议核实渠道，不表示已经查证。
   - 访谈官的启发示例、参考答案、历史模型点评和源码实现不等于候选人的个人经历，不能直接归属为个人成果；仅有待确认项、没有简历草稿也可以完成报告，但不能返回六字段和两个数组全部为空的空壳。
   - 按同一经历归属整理背景、行动、分工与结果；谈及多段经历时明确对应名称或语境，不把另一项目的指标、技术决策或团队成果挪到本项目。无法确定归属的内容放入待确认清单，不拼成一个虚构项目。
   - 候选人明确更正或否认先前信息时，保留更正后的事实与限定，不将已否认的做法或指标写进草稿；冲突尚未澄清时记录待核实项，不自行选择更亮眼的版本。记不清不等于否认，也不等于证实；简历中的已有表述与本次新确认内容有区别，不能声称通过访谈核实了所有简历事实。
3. 【主考官视角】模拟录用与潜力评估报表（evaluator_report）。
${EVALUATOR_REPORT_PROMPT}
${summaryRules}

输出严格的 JSON 格式：
{
  "jd_match": 0,
  "strengths": "有依据的强项简述；无足够依据时注明本场未观察到",
  "weaknesses": "有依据的短板简述；区分未考察与信息不足",
  "suggestions": "有依据的练习、核实或补充考察建议，可简短作答",
  "mining_summary": {
    "project_name": "候选人提供的名称；未知时为空字符串",
    "background": "已确认的任务背景与约束；未知时为空字符串",
    "actions": "已确认的实际行动；未知时为空字符串",
    "tradeoffs": "已说明的实际选择及依据；未知时为空字符串",
    "results": "",
    "contribution": "已确认的个人分工；未知时为空字符串",
    "pending_confirmations": [],
    "resume_bullets": []
  },
  "evaluator_report": ${EVALUATOR_REPORT_EXAMPLE}
}
外层只返回示例列出的字段，不得添加字段；只输出合法 JSON，不要包含任何额外 Markdown 或解释文字。`
    : `你是本次面试的面试官（${params.styleLabel}风格）兼用人部门技术负责人。一场模拟面试已结束，你需要输出两部分内容：
${sourceRule}
1. 候选人复盘总结（包含岗位匹配分、强弱项与改进建议）。
2. 【面试官视角】模拟录用评估报表（Internal Interview Feedback Sheet），语言客观具体、专业务实。
${EVALUATOR_REPORT_PROMPT}
${summaryRules}

输出严格的 JSON 格式：
{
  "jd_match": 0,
  "strengths": "有依据的强项简述；无足够依据时注明本场未观察到",
  "weaknesses": "有依据的短板简述；区分未考察与信息不足",
  "suggestions": "有依据的练习、核实或补充考察建议，可简短作答",
  "evaluator_report": ${EVALUATOR_REPORT_EXAMPLE}
}
外层只返回示例列出的字段，不得添加字段；只输出合法 JSON，不要包含任何额外 Markdown 或解释文字。`;
}

export function buildInterviewFinishMessages(params: {
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

export type InterviewFinishPayload = {
  jd_match: unknown;
  strengths: string;
  weaknesses: string;
  suggestions: string;
  mining_summary: unknown;
  evaluator_report: unknown;
};

export function parseInterviewFinishPayload(raw: string, isMining: boolean): InterviewFinishPayload | null {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const requiredKeys = isMining
    ? ["jd_match", "strengths", "weaknesses", "suggestions", "mining_summary"]
    : ["jd_match", "strengths", "weaknesses", "suggestions"];
  const allowedKeys = [...requiredKeys, "evaluator_report"];
  if (requiredKeys.some(key => !Object.hasOwn(parsed, key)) || Object.keys(parsed).some(key => !allowedKeys.includes(key))) return null;
  return {
    jd_match: parsed.jd_match,
    strengths: typeof parsed.strengths === "string" ? parsed.strengths : "",
    weaknesses: typeof parsed.weaknesses === "string" ? parsed.weaknesses : "",
    suggestions: typeof parsed.suggestions === "string" ? parsed.suggestions : "",
    mining_summary: parsed.mining_summary,
    evaluator_report: parsed.evaluator_report,
  };
}
