import { PRESET_REMEDIES, parseRemedyResult, type PersonaStyle, type PresetRemedy, type ScenarioType } from "@/lib/career-gap-remedy";

export type RemedyRecord = {
  id: number;
  scenario_type: ScenarioType;
  raw_story: string;
  target_role: string;
  persona_style: PersonaStyle;
  result: string;
  created_at: string;
};

export type PresetTab = "all" | "resignation" | "gap";

export const SAMPLE_STORIES: Record<ScenarioType, { text: string }> = {
  resignation: {
    text: "上一家公司经常无序加班到半夜一两点，排期朝令夕改，周末还经常被艾特救火。领导微操严重并且出了技术故障喜欢甩锅给一线开发，身心非常疲惫，觉得学不到架构东西纯内耗，撑了快两年终于下决心离职了。",
  },
  gap: {
    text: "上一份工作强度太大了连续干了三年，裸辞后先花了一个月旅行调理身体，后面三个月在家系统复习了高并发系统设计和全栈开发技术栈，还自己动手做了一个 AI 工具站，到现在空窗快4个月了，担心 HR 觉得我待业太久或者能力不行。",
  },
  both: {
    text: "前司整个出海创新业务线因为公司战略亏损整体裁撤，拿了 N+1 赔偿。离职后因为大环境行情一般，看了几家都不太合适，陆陆续续空窗了5个月。希望在面试中既能体面解释被裁原因，又能把这5个月的空白期解释得积极有说服力。",
  },
};

export function filterPresets(tab: PresetTab): PresetRemedy[] {
  return tab === "all" ? PRESET_REMEDIES : PRESET_REMEDIES.filter((preset) => preset.category === tab);
}

export function scenarioLabel(scenario: ScenarioType): string {
  return scenario === "resignation" ? "离职" : scenario === "gap" ? "空窗" : "综合";
}

export function remedyTitle(record: RemedyRecord): string {
  return parseRemedyResult(record.result)?.title || record.raw_story.slice(0, 40) || "高情商重塑报告";
}
