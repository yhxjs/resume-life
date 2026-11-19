import { EVALUATOR_EVIDENCE_RULES } from "@/lib/prompt-guidelines";
import {
  EVALUATOR_REPORT_OUTPUT_LIMITS as LIMITS,
  INTERVIEW_REPORT_OUTPUT_LIMITS as SUMMARY_LIMITS,
  type EvaluatorReport,
} from "@/lib/scores";

/** 首次总评（含经历挖掘）与单独重试共用；这里只包含固定指令。 */
export const EVALUATOR_REPORT_PROMPT = `${EVALUATOR_EVIDENCE_RULES}

模拟录用评估的输出字段（全部返回）：
以下字段定义模拟录用评估对象；嵌入面试复盘时只填入 evaluator_report，不将外层复盘评分或总结字段复制进该对象。
- recommendation：按上述证据标准选择 Strong Hire / Hire / Lean No / No Hire；枚举没有默认选项，不为配合示例选择结论。
- level：仅在证据足够且该岗位适合此参照时给出大致 P 级并注明非官方定级；否则写“暂无法判断”。不预设 P6、P7 或其他具体级别。
- level_justification：解释已展示的能力、适用范围及判断局限；无法定级时说明尚缺哪些与目标岗位相关的证据，不虚构更高一级的差距。
- summary_for_hr：通常用 2-4 句概括本场证据、主要结论与局限；句数是篇幅目标，结论简单且已充分表达时可以更短，不重复内容凑句。
- hire_reasons：有原答依据的亮点清单，每项 1-2 句；没有可支持的亮点时用 []。
- concerns_and_risks：原答中有具体依据的错误、矛盾或影响岗位判断的待核实事项，每项说明依据与影响；没有可报告的顾虑时用 []。不为平衡亮点而制造风险，不把表达简短、没有指标或未考察领域写成经历造假。
- placement_suggestion：依据已展示能力提出适合的任务方向与后续核实/培养建议；证据不足时说明暂无法定岗及应补充的考察，不保证入职或试用期结果。
- evidence_quotes：遵循上述题号与证据规则；topic 与 observation 是回答依据摘要，不是逐字引文；没有可引用证据时用 []。
篇幅上限（超过即重组，不截断句尾）：level ${LIMITS.level} 字；level_justification ${LIMITS.levelJustification} 字、summary_for_hr ${LIMITS.summaryForHr} 字、placement_suggestion ${LIMITS.placementSuggestion} 字；hire_reasons 和 concerns_and_risks 各最多 ${LIMITS.listItems} 项，单项分别不超过 ${LIMITS.hireReason} / ${LIMITS.concern} 字；evidence_quotes 最多 ${LIMITS.evidenceItems} 项，每项 topic 不超过 ${LIMITS.topic} 字、observation 不超过 ${LIMITS.observation} 字。
文本字段使用包含可见内容的非空字符串，不得以纯标点、零宽或控制字符占位；清单为字符串数组，有依据的条目须含可见内容，没有可报告项时返回 []。evidence_quotes 必须返回对象数组，没有可引用证据时返回 []。recommendation、level、清单条数与分数均须依据本场材料独立确定。
严格按定义字段输出，不得增加字段；evidence_quotes 每项只含 turn_idx、topic、observation。
下方 JSON 仅示意字段结构与类型，不是本场的示范结论；不得照抄其录用建议、职级、分数、清单或说明文字。`;

/** 保持示例为可解析 JSON；不植入虚构题号、岗位、亮点或风险。 */
export const EVALUATOR_REPORT_EXAMPLE = JSON.stringify({
  recommendation: "Lean No",
  level: "暂无法判断",
  level_justification: "依据本场已展示能力与证据范围说明判断",
  summary_for_hr: "依据本场原答形成的结论与局限",
  hire_reasons: [],
  concerns_and_risks: [],
  placement_suggestion: "有依据的任务方向，或仍需补充的考察",
  evidence_quotes: [],
} satisfies EvaluatorReport, null, 2);

export const INTERVIEW_REPORT_SUMMARY_OUTPUT_RULES = `strengths、weaknesses、suggestions 均须为含可见内容的非空字符串，不得用纯标点、零宽或控制字符占位；各不超过 ${SUMMARY_LIMITS.summaryText} 字。非空是结构要求，不要求凑出强项或短板。无足够依据时明确写本场未观察到或信息不足，区分未考察与已发现问题；建议仅给有依据的补充考察、练习或核实方向，材料有限时简短作答，不按示例句数扩写。超限时压缩表达但保留事实限定，不截断句尾。结束报告中仍应尽力返回 evaluator_report；若该字段缺失或无法通过评估校验，候选人复盘仍可保存，评估可通过独立入口重试。`;

export const INTERVIEW_MINING_OUTPUT_RULES = `经历挖掘的六个事实文本字段可用空字符串表示未知；非空时须含可见内容，不得以纯标点、零宽或控制字符占位；各字段不超过 ${SUMMARY_LIMITS.miningText} 字。resume_bullets 最多 ${SUMMARY_LIMITS.resumeBullets} 条，若有条目须含可见内容且每条不超过 ${SUMMARY_LIMITS.resumeBullet} 字；pending_confirmations 最多 ${SUMMARY_LIMITS.pendingConfirmations} 项，若有条目则 category、item、source_hint 均须含可见内容，分别不超过 ${SUMMARY_LIMITS.pendingCategory}、${SUMMARY_LIMITS.pendingItem}、${SUMMARY_LIMITS.pendingSourceHint} 字。超限时压缩表达但保留事实限定，不截断句尾。`;
