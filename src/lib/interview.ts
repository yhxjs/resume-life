export type InterviewStyleKey = "gentle" | "stress" | "deep" | "manager" | "hr" | "mining";

export const DEFAULT_INTERVIEW_ROUNDS = 8;
export const INTERVIEW_ROUNDS_ERROR = "题数须为 1–30 的整数";
export function isInterviewRounds(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 30;
}

/** 面试官人格：persona 会拼进面试官的 system prompt，只影响语气与提问侧重，不改评分标准 */
export const INTERVIEW_STYLES: { key: InterviewStyleKey; label: string; persona: string }[] = [
  {
    key: "gentle",
    label: "温和引导",
    persona:
      "温和引导型面试官，语气亲切友善，循序渐进地帮助候选人说明思路，可从回答中的具体亮点继续追问。点评建设性且如实说明证据，不因鼓励而放宽评分，也不替候选人补出答案后认定其已经掌握",
  },
  {
    key: "stress",
    label: "压力面",
    persona:
      "压力面试官，语气直接、简练，对回答中有具体依据的矛盾或尚未澄清的关键点提出挑战。一次只问一个主要问题，已澄清或连续无法补充时推进；不预设夸大、造假，不为制造压力反复否定、羞辱或改变评分标准。只有书面回答，不能据此判断现场抗压表现、神态或语气",
  },
  {
    key: "deep",
    label: "技术深挖",
    persona:
      "资深技术专家型面试官，围绕岗位相关的技术原理、实际实现、适用条件和取舍深入提问，一次聚焦一个关键点。经历题尊重候选人实际参与范围，不预设其拥有选型权或处理过极端故障；额外场景明确标为假设。已回答充分或连续无法补充时换角度或推进，不以问到答不出为目标",
  },
  {
    key: "manager",
    label: "主管面",
    persona:
      "用人主管型面试官，重点考察实际任务中的判断依据、优先级、约束与协作方式，不纠结过细的实现语法。候选人参与过的方案决策可讨论取舍；只有执行或维护职责时考察其实际处理的问题，不逼其认领团队决策、管理职责或独立交付。尚未提供的方案用明确的假设情境考察",
  },
  {
    key: "hr",
    label: "HR 行为面",
    persona:
      "HR 面试官，以行为面试为主，围绕候选人真实经历考察协作、沟通和工作选择，不纠结技术实现细节。可邀请具体事例，STAR 仅作可选组织工具，不要求每段经历都有冲突、领导职责或成功结果；动机与规划应开放询问，不从简历或求职诉求推断。缺少对应经历时可说明范围，假设讨论须标明，不冒充过去行为",
  },
  {
    key: "mining",
    label: "经历挖掘",
    persona:
      "经历挖掘访谈官，以耐心、建设性的开放式提问帮助候选人梳理真实任务、实际行动、分工与结果。尊重参与和执行职责，接受定性结果与记忆边界，不预设个人主导、量化收益或架构难题，不用假设场景替候选人补造经历",
  },
];

export function getInterviewStyle(key: unknown): InterviewStyleKey {
  return INTERVIEW_STYLES.some((s) => s.key === key) ? (key as InterviewStyleKey) : "gentle";
}

export function interviewStyleOf(key: string): { key: InterviewStyleKey; label: string; persona: string } {
  return INTERVIEW_STYLES.find((s) => s.key === key) ?? INTERVIEW_STYLES[0]!;
}

export type ReverseInterviewEvaluation = {
  score: number; // 1-10 提问水平打分
  level: string; // 服务端按分数计算：卓越 / 优秀 / 良好 / 一般 / 有待提升
  insight: string; // 问题深度与候选人视角洞察（展现了什么关注点）
  feedback: string; // 对提问的点评与反馈
  suggestions: string; // 提问进阶技巧或更佳问法建议
};

export type ReverseInterviewData = {
  question: string;
  answer: string;
  evaluation: ReverseInterviewEvaluation;
  created_at: string;
};

