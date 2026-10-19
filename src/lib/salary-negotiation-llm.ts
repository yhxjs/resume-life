/** Offer 谈判与薪酬博弈的 LLM 提示词与双重视角生成拼装 */

export const SALARY_NEGOTIATION_OPENING_PROMPT = `你是一名资深的招聘专家，同时精通薪酬博弈与行为心理学。现在请同时扮演两个截然相反的视角：
1. 【HR（对立方）】：根据目标公司级别与 HR 风格，向求职者发送初始 Offer 方案与说辞。
   - 规则：初始开盘价通常比求职者期望薪资低 15%~25%（进行试探性锚定）；严格契合所选的 HR 风格人设；言辞自然、具象、富有职场真实感。
2. 【求职者首席军师（己方参谋）】：站在候选人绝对利益立场，拆解 HR 开盘话术背后的真实企图，评估开盘博弈局势，并提供 2 条高情商反击开局示范。

必须只输出如下 JSON 格式：
{
  "initial_offer": "简明提炼的初始 Offer 方案（如：月薪 28k * 14薪 + 标准公积金，预估总包约 39W）",
  "hr_response": "HR 对求职者说的完整口语化话术（含祝贺通过面试、给出初始方案、附加压价说辞或公司带宽解释，100-250字）",
  "hr_tactics": "HR 首轮出招手法简评（如：以同级内部公平性试探底线）",
  "hr_mindset": {
    "looseness": 15,
    "current_attitude": "严守初次开价",
    "estimated_package": "预估可放行上限（如：32k*14 + 1.5w签约补贴）",
    "tactics_label": "初始心理锚定压制",
    "internal_pressure": "用人部门需要 2 周内定岗，但目前尚有 1 个在流程中的备选人"
  },
  "mentor_analysis": {
    "user_argument_score": 7,
    "strengths": ["初始期望定位清晰", "已有基本盘筹码"],
    "vulnerabilities": ["尚未正式开始博弈说服"],
    "tactical_tips": "HR 的首次开价通常是探底，切忌慌乱妥协或直接表现出失望，应先感谢并以价值重申锚定高点。",
    "suggested_replies": [
      {
        "title": "方案A：肯定意向 + 锚定增量价值",
        "content": "非常感谢团队对我的认可，我也十分期待能加入负责相关业务。不过基于我在该领域带给团队的即战力以及当前的薪资期望，这个 package 与我的预期仍有差距，想了解下在 base 或年终绩效激励上是否还有进一步沟通的弹性？",
        "rationale": "先礼后兵，表达加入诚意的同时，以价值作为杠杆明确推回低价，迫使 HR 亮出真实弹性区间。"
      },
      {
        "title": "方案B：借力竞品/当前底盘温和推拉",
        "content": "感谢您发来的 Offer！由于我目前手中还有其他流程正在推进（或：当前薪酬结构与此非常接近），若综合考虑跳槽的机会成本与预期，我更希望能达到 XX 的水平。希望能帮我向薪酬委员会或用人主管争取一下。",
        "rationale": "引入机会成本概念，不直接拒绝，而是引导 HR 成为你的内部争取盟友。"
      }
    ]
  }
}
只输出 JSON，不要任何多余标记。`;

export function buildOpeningUserPrompt(params: {
  targetCompanyTier: string;
  targetRole: string;
  expectedSalary: string;
  currentOrCompetingOffer: string;
  hrStyleDesc: string;
}): string {
  return checkNegotiationContext(`【目标公司类型】${params.targetCompanyTier}
【目标岗位及职级】${params.targetRole}
【求职者期望薪资】${params.expectedSalary}
【求职者现有/竞品 Offer 筹码】${params.currentOrCompetingOffer || "暂无特别说明"}
【HR 风格偏好及人设】${params.hrStyleDesc}

请根据以上背景，生成这场 Offer 薪酬博弈的开局（HR 初始出招 + 心理防线 + 军师解盘）。`, SALARY_NEGOTIATION_OPENING_PROMPT);
}

export const SALARY_NEGOTIATION_TURN_PROMPT = `你是一名资深的招聘专家，同时精通薪酬博弈。请严格根据历史对局上下文与求职者最新一轮的还价说辞，同时输出：
1. 【HR 的出招与回应】：HR 听完求职者本轮话术后的即时反应。
   - 保持你的人设风格。
   - 展现真实的 HR 博弈招式：如推拉、拆解 base 与期权/年终比例、强调横向公平、借用人部门主管审批难度施压、适度让步或在特定条件（如入职时间）下置换签字费。
   - 如果求职者说服逻辑极其有力、筹码扎实，HR 的心理防线应逐步被瓦解，并给出实质性加码；如果求职者退让过快或漏洞百出，HR 应当乘胜追击紧咬底线。
2. 【HR 隐藏心理防线指标】：
   - looseness (0-100)：根据求职者的表现动态浮动。如果求职者说服力强，松动度上升；若求职者盲目硬杠或缺乏理据，松动度可能停滞甚至收紧。
   - current_attitude、estimated_package、tactics_label、internal_pressure。
3. 【军师实时拆解与反击指南】：
   - 针对求职者【刚刚发送的这句发言】打分 (1-10)、提炼发挥出色的筹码与暴露的逻辑破绽。
   - 军师点拨与 1-2 条切实可用的高情商反击话术示范。

必须只输出如下 JSON 格式：
{
  "hr_response": "HR 的口语化回复（80-220字）",
  "hr_tactics": "本轮出招手法标签（如：职级天花板施压/期权福利置换/签字费松口）",
  "hr_mindset": {
    "looseness": 45,
    "current_attitude": "出现动摇，考虑在签字费上让步",
    "estimated_package": "33k*15 + 2w签字费",
    "tactics_label": "以职级带宽上限为由推拉",
    "internal_pressure": "业务线急需该角色推进季度项目"
  },
  "mentor_analysis": {
    "user_argument_score": 8,
    "strengths": ["有理有据拿出了竞品 Offer 施压", "态度克制未激化矛盾"],
    "vulnerabilities": ["过早承诺了可以尽早入职，损失了部分时间杠杆"],
    "tactical_tips": "HR 已经借职级带宽说明了 base 难提，但话语中留出了综合补贴口子，下一轮应将焦点转移到一次性签约奖金或绩效对赌上。",
    "suggested_replies": [
      {
        "title": "方案A：接受带宽约束，置换一次性签字费",
        "content": "我完全理解公司在职级 base 上的管理规范，也尊重团队的薪级制度。如果月度 base 确实存在硬性上限，我们是否可以考虑在 Sign-on Bonus（签字费）或第一年的绩效保障基数上做个弥补，以拉平整体 package 的预期？",
        "rationale": "体谅 HR 的内部制度痛点，把谈判主战场从死板的 base 迁移到 HR 具备审批特权的签字费上。"
      },
      {
        "title": "方案B：承诺关键产出与对赌调薪",
        "content": "如果当前职级薪酬池确实无法再做调整，我非常愿意用业绩证明自己的价值。我们能否在合同或 Offer 中约定：在通过试用期或半年后达成某项业务里程碑时，提前进入一次职级薪资 review？",
        "rationale": "用自信与确定性的业务产出做置换，给 HR 向上汇报的强有力抓手。"
      }
    ]
  }
}
只输出 JSON，不要 Markdown 标记。`;

export const MAX_NEGOTIATION_MESSAGE_CHARS = 4000;
export const MAX_NEGOTIATION_ROUNDS = 20;
export const MAX_NEGOTIATION_CONTEXT_CHARS = 32000;
const FINALIZE_SAFETY_OVERHEAD_CHARS = 2000;

export class NegotiationBudgetError extends Error {}

function checkNegotiationBudget(message: string, turns: { user_message: string }[], continuing: boolean) {
  if (message.length > MAX_NEGOTIATION_MESSAGE_CHARS) {
    throw new NegotiationBudgetError(`单条发言不得超过 ${MAX_NEGOTIATION_MESSAGE_CHARS} 字符`);
  }
  const rounds = turns.filter((turn) => turn.user_message).length;
  if (rounds > MAX_NEGOTIATION_ROUNDS || (continuing && rounds >= MAX_NEGOTIATION_ROUNDS)) {
    throw new NegotiationBudgetError(`谈判最多 ${MAX_NEGOTIATION_ROUNDS} 个发言回合，请结束当前谈判`);
  }
}

function checkNegotiationContext(prompt: string, systemPrompt: string): string {
  if (prompt.length + systemPrompt.length > MAX_NEGOTIATION_CONTEXT_CHARS) {
    throw new NegotiationBudgetError(`谈判上下文超过 ${MAX_NEGOTIATION_CONTEXT_CHARS} 字符，请缩短输入或新建谈判`);
  }
  return prompt;
}

export function buildTurnHistoryMessages(params: {
  targetCompanyTier: string;
  targetRole: string;
  expectedSalary: string;
  currentOrCompetingOffer: string;
  hrStyleDesc: string;
  turns: { turn_no: number; user_message: string; hr_response: string }[];
  newUserMessage: string;
}): string {
  checkNegotiationBudget(params.newUserMessage, params.turns, true);
  const historyText = params.turns
    .map(
      (t) =>
        `【第 ${t.turn_no} 轮】\n` +
        (t.user_message ? `求职者说：${t.user_message}\n` : "") +
        `HR回应：${t.hr_response}`
    )
    .join("\n\n");

  return checkNegotiationContext(`【谈判背景】
- 目标公司：${params.targetCompanyTier}
- 目标岗位：${params.targetRole}
- 期望薪资：${params.expectedSalary}
- 手头筹码/竞品：${params.currentOrCompetingOffer || "无特别说明"}
- HR 风格人设：${params.hrStyleDesc}

【历史交锋记录】
${historyText}

【求职者本轮最新说辞】
${params.newUserMessage}

请针对求职者本轮最新说辞，生成 HR 的即时回应、HR 心理防线变化与军师拆解。`, SALARY_NEGOTIATION_TURN_PROMPT);
}

export const SALARY_NEGOTIATION_FINALIZE_PROMPT = `你是薪酬博弈与职场谈判专家。一场 Offer 薪酬博弈刚刚结束。请全面复盘全部谈判回合中求职者的表现，生成一份深度的《薪酬谈判复盘报告》。

必须只输出如下 JSON 格式：
{
  "final_package_summary": "全面点评最终锁定薪资结构（base、年终、补贴）以及相比 HR 初始开价的增益空间...",
  "persuasion_grade": "A",
  "score": 88,
  "leverage_efficiency": "对竞品 Offer 与自身增量价值进行了精准打击，成功迫使 HR 动用了签字费审批权，转化效率极高...",
  "turn_critiques": [
    {
      "turn_no": 1,
      "gain_or_loss": "gain",
      "summary": "稳健抵挡首轮低开试探",
      "key_point": "没有直接泄露底牌，而是将话题引向业务价值。"
    },
    {
      "turn_no": 2,
      "gain_or_loss": "loss",
      "summary": "过早透露了急于入职的心态",
      "key_point": "让 HR 察觉到了求职者急于落定的心态，导致 base 让步受阻。"
    }
  ],
  "real_world_tips": [
    "现实谈薪法则一：永远不要只谈单一数字，把谈资拆分为 base、年终、签字费、调薪周期与期权多维谈判。",
    "现实谈薪法则二：HR 说'这是公司规定'时，通常意味着常规路径受阻，应主动递上'需要特殊审批'的合理借口和理由支持。"
  ],
  "mentor_summary": "整场博弈有张有弛，攻防得当。在真实职场中，带着这份心态与方法，你完全能够多争取 15%-25% 的溢价空间！"
}
只输出 JSON。`;

export function buildFinalizeUserPrompt(params: {
  targetCompanyTier: string;
  targetRole: string;
  expectedSalary: string;
  currentOrCompetingOffer: string;
  initialOffer: string;
  turns: {
    turn_no: number;
    user_message: string;
    hr_response: string;
    hr_mindset_str: string;
    mentor_analysis_str: string;
  }[];
  finalWords?: string;
}): string {
  checkNegotiationBudget(params.finalWords ?? "", params.turns, false);
  const clip = (value: string, limit: number) =>
    value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
  const background = `【谈判背景】
- 目标公司：${clip(params.targetCompanyTier, 1000)}
- 目标岗位：${clip(params.targetRole, 1000)}
- 期望薪资：${clip(params.expectedSalary, 1000)}
- 初始筹码：${clip(params.currentOrCompetingOffer || "无特别说明", 2000)}
- HR 初始开盘：${clip(params.initialOffer, 2000)}
${params.finalWords ? `- 求职者最终确认表态：${clip(params.finalWords, MAX_NEGOTIATION_MESSAGE_CHARS)}\n` : ""}

【全部博弈回合记录】`;
  const suffix = "\n\n请全面复盘整场博弈，输出深度的终局复盘报告。";
  const separators = Math.max(0, params.turns.length - 1) * 2;
  const markerLength = params.turns.reduce(
    (total, turn) => total + `【第 ${turn.turn_no} 回合】\n求职者：\nHR回应：`.length,
    0
  );
  const remaining = Math.max(
    0,
    MAX_NEGOTIATION_CONTEXT_CHARS - SALARY_NEGOTIATION_FINALIZE_PROMPT.length -
      FINALIZE_SAFETY_OVERHEAD_CHARS - background.length - suffix.length - markerLength - separators
  );
  const perTurn = params.turns.length > 0 ? Math.floor(remaining / params.turns.length) : 0;
  const turnsDetail = params.turns.map((turn) => {
    const userBudget = Math.floor(perTurn * 0.6);
    const hrBudget = perTurn - userBudget;
    return `【第 ${turn.turn_no} 回合】\n求职者：${clip(turn.user_message, userBudget)}\nHR回应：${clip(turn.hr_response, hrBudget)}`;
  }).join("\n\n");

  return checkNegotiationContext(`${background}\n${turnsDetail}${suffix}`, SALARY_NEGOTIATION_FINALIZE_PROMPT);
}
