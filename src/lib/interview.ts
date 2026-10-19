export type InterviewStyleKey = "gentle" | "stress" | "deep" | "manager" | "hr" | "mining";

/** 面试官人格：persona 会拼进面试官的 system prompt，只影响语气与提问侧重，不改评分标准 */
export const INTERVIEW_STYLES: { key: InterviewStyleKey; label: string; persona: string }[] = [
  {
    key: "gentle",
    label: "温和引导",
    persona:
      "温和引导型面试官，语气亲切友善，善于循序渐进地引导候选人打开思路，从回答中的亮点顺势追问，点评以鼓励为主但如实指出不足",
  },
  {
    key: "stress",
    label: "压力面",
    persona:
      "压力面试官，语气犀利直接、带着质疑与压迫感，紧盯回答中的矛盾、含糊与夸大之处连环追问，考验候选人在压力下的真实水平与应变能力",
  },
  {
    key: "deep",
    label: "技术深挖",
    persona:
      "资深技术专家型面试官，围绕项目与工作经历中的技术方案层层深挖——追问设计动机、原理细节、备选方案与极端场景，直到探到候选人的能力边界",
  },
  {
    key: "manager",
    label: "主管面",
    persona:
      "用人主管型面试官，重点考察技术方案的权衡与取舍——为什么这么设计、放弃了什么、代价与边界在哪，同时关注决策依据、优先级判断与协作推动；不纠结过细的实现语法，点评从「能不能把事做成」的角度出发",
  },
  {
    key: "hr",
    label: "HR 行为面",
    persona:
      "HR 面试官，以行为面试为主：围绕简历中的经历考察团队协作、沟通与冲突处理、工作动机与职业规划，引导候选人用具体事例（STAR）说明，不纠结技术实现细节",
  },
  {
    key: "mining",
    label: "经历挖掘",
    persona:
      "经历挖掘访谈官，专注于通过启发式访谈帮候选人把'只记得做过但说不清难点与贡献'的项目深度梳理清楚。按【背景与业务痛点】→【核心行动与技术方案】→【关键取舍与架构决策】→【量化结果与个人贡献】四步链条层层深挖。遇到回答模糊或遗忘时，给出常见工程选型和场景启发思考；遇到亮点时追问其底层支撑与衡量依据；全程保持建设性与耐心引导",
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
  level: string; // 卓越 / 优秀 / 良好 / 一般 / 待改进
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

