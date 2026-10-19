import { isStoredProjectSummary } from "./summary";
import type { DatabaseSync } from "node:sqlite";
import { BASIC_REORDERABLE_FIELD_KEYS } from "./modules";

type Check = (value: unknown) => boolean;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const string: Check = (value) => typeof value === "string";
const number: Check = (value) => typeof value === "number" && Number.isFinite(value);
const range = (min: number, max: number): Check => (value) => number(value) && (value as number) >= min && (value as number) <= max;
const oneOf = (...values: string[]): Check => (value) => typeof value === "string" && values.includes(value);
const oneOfNumber = (...values: number[]): Check => (value) => typeof value === "number" && values.includes(value as number);
const nullable = (check: Check): Check => (value) => value === null || check(value);
const list = (check: Check): Check => (value) => Array.isArray(value) && value.every(check);
const strings = list(string);
const emptyObject: Check = (value) => record(value) && Object.keys(value).length === 0;
const orEmptyObject = (check: Check): Check => (value) => emptyObject(value) || check(value);

/** 校验落库后的完整形状，不做默认补齐、字段丢弃或类型转换。 */
function object(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return (value) => record(value) &&
    Object.entries(required).every(([key, check]) => Object.hasOwn(value, key) && check(value[key])) &&
    Object.keys(value).every((key) => Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key]!(value[key])));
}

const scoreFields = { depth: range(0, 10), structure: range(0, 10), authenticity: range(0, 10), completeness: range(0, 10) };
const scores = object(scoreFields);
const summaryFields = { strengths: string, weaknesses: string, suggestions: string };
const miningSummary = object({
  project_name: string, background: string, actions: string, tradeoffs: string,
  results: string, contribution: string,
  pending_confirmations: list(object({ category: string, item: string, source_hint: string })),
  resume_bullets: strings,
});
const interviewReport = object(
  { ...scoreFields, ...summaryFields, jd_match: range(0, 10), overall: range(0, 10) },
  { mining_summary: miningSummary },
);
const reverseInterview = object({
  question: string, answer: string, created_at: string,
  evaluation: object({ score: range(1, 10), level: string, insight: string, feedback: string, suggestions: string }),
});
const evaluatorReport = object({
  recommendation: oneOf("Strong Hire", "Hire", "Lean No", "No Hire"),
  level: string, level_justification: string, summary_for_hr: string,
  hire_reasons: strings, concerns_and_risks: strings, placement_suggestion: string,
}, { evidence_quotes: list(object({ turn_idx: number, topic: string, observation: string })) });
const retries = list(object({ id: string, answer: string, scores: nullable(scores), comment: string, created_at: string }, { reference: string }));
const seriesReport = object({ overall: range(0, 10), verdict: string, ...summaryFields });
const diagnosisSuggestion: Check = (value) => object({
  itemId: string, field: oneOf("description", "text", "items"), reason: string,
  draft: record(value) && value.field === "items" ? strings : string,
})(value);
const diagnosis = object({
  match: range(0, 10), summary: string,
  modules: list(object({ moduleKey: string, label: string, scores, gaps: string, suggestions: list(diagnosisSuggestion) })),
});
const realInterviewQuestion = object({ question: string, answer: string, stuck: string, feedback: string });
const realInterviewResult = object({
  mistakes: list(object({ question_index: number, gap: string, improved_answer: string })),
  drills: list(object({ question_index: number, question: string })),
  resume_suggestions: list(object({ question_index: number, suggestion: string })),
});

const moduleContent: Record<string, Check> = {
  basic: object(
    { name: string, phone: string, email: string, location: string, links: string },
    {
      birthday: string,
      gender: string,
      age: string,
      fieldOrder: list(oneOf(...BASIC_REORDERABLE_FIELD_KEYS)),
      avatar: string,
      avatarX: number,
      avatarY: number,
      avatarSize: number,
      avatarShape: oneOf("circle", "rounded", "square"),
    },
  ),
  education: list(object({ id: string, school: string, degree: string, field: string, start: string, end: string, description: string })),
  work: list(object(
    { id: string, company: string, title: string, start: string, end: string, description: string,
      subItems: list(object({ id: string, label: string, value: string })),
      descriptionItems: strings,
      descriptionStyle: oneOf("unordered", "ordered"),
    },
  )),
  projects: list(object(
    { id: string, name: string, role: string, start: string, end: string, description: string,
      subItems: list(object({ id: string, label: string, value: string })),
      descriptionItems: strings,
      descriptionStyle: oneOf("unordered", "ordered"),
    },
  )),
  skills: object({ items: strings }),
  summary: object({ text: string, descriptionItems: strings, descriptionStyle: oneOf("unordered", "ordered") }),
  custom: list(object(
    { id: string, title: string, start: string, end: string, description: string,
      subTitle: string,
      subItems: list(object({ id: string, label: string, value: string })),
      descriptionItems: strings,
      descriptionStyle: oneOf("unordered", "ordered"),
    },
  )),
};

const color: Check = (value) => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
const style = object({
  layout: oneOf("single", "twocol"), asideWidth: range(30, 100), pageMargin: range(6, 25),
  font: oneOf("serif", "sans"), baseSize: range(9, 14), lineHeight: range(1.2, 2),
  accent: color, ink: color, text: color, muted: color,
  nameSize: range(16, 40), nameWeight: range(400, 900), titleAlign: oneOf("center", "left"),
  nameTracking: range(0, 8), titleRule: oneOf("none", "accent", "dark"), titleRuleThickness: range(1, 6),
  contactSize: range(9, 14), sectionSize: range(10, 18), sectionWeight: range(400, 900),
  sectionColor: color, sectionTracking: range(0, 8), sectionDeco: oneOf("none", "underline", "leftbar", "band"),
  sectionDecoColor: color, sectionGapBefore: range(4, 28), sectionGapAfter: range(2, 16),
  entryTitleSize: range(11, 16), entryTitleWeight: range(400, 900), entrySubAccent: (value) => typeof value === "boolean",
  entryGap: range(4, 20), skillStyle: oneOf("pill", "line", "list"),
}, {
  descItemGap: range(0, 16),
  contactSeparator: string,
  contactGap: range(0, 32),
  headerStyle: oneOf("default", "banner", "card"),
  headerBg: color,
  asidePosition: oneOf("left", "right"),
  asideModules: strings,
  asideBg: color,
  asideBorder: oneOf("auto", "none", "left", "right", "both"),
  asideBorderColor: color,
  asidePadding: range(0, 40),
  asideGap: range(0, 40),
  headerLayout: oneOf("right-avatar", "left-avatar", "center-avatar"),
  contactLayout: oneOf("inline", "grid2"),
  skillCols: oneOfNumber(1, 2, 3),
  entryCols: oneOfNumber(1, 2),
});

const jdPortrait = object({
  role: string,
  mustSkills: list(object({ name: string, weight: range(1, 10), why: string })),
  followups: list(object({ topic: string, questions: strings })),
  companyStyle: object({ style: string, signals: strings }),
});
const jargon = object({
  targetSummary: string, punchline: string, overallRiskScore: nullable(range(1, 100)),
  riskRatings: object({ overtime: nullable(range(1, 10)), stability: nullable(range(1, 10)), resources: nullable(range(1, 10)), management: nullable(range(1, 10)) }),
  items: list(object({
    keyword: string, surfaceMeaning: string, hiddenMeaning: string, riskLevel: nullable(oneOf("low", "medium", "high")),
    riskCategory: string, warning: string, interviewRule: string, counterQuestions: strings,
  })),
  companyProfile: object({ teamStyle: string, riskFlags: strings, cultureSummary: string }),
  goldenQuestions: strings,
});
const hrMindset = object({ looseness: range(0, 100), current_attitude: string, estimated_package: string, tactics_label: string, internal_pressure: string });
const mentorAnalysis = object({
  user_argument_score: range(1, 10), strengths: strings, vulnerabilities: strings, tactical_tips: string,
  suggested_replies: list(object({ title: string, content: string, rationale: string })),
});
const negotiationReport = object({
  final_package_summary: string, persuasion_grade: oneOf("A", "B", "C", "D"), score: range(0, 100), leverage_efficiency: string,
  turn_critiques: list(object({ turn_no: number, gain_or_loss: oneOf("gain", "loss", "neutral"), summary: string, key_point: string })),
  real_world_tips: strings, mentor_summary: string,
});
const scannedItems = list(object({
  id: string, originalText: string, sectionHint: string, riskLevel: oneOf("critical", "high", "medium"),
  riskType: oneOf("vague_phrase", "data_suspicion", "buzzword_stuffing", "scope_ambiguity", "logic_flaw"),
  interviewerRoast: string, deadlyQuestions: strings,
  defensePlan: object({ interviewerIntent: string, standardDefense: string, tabooMistakes: strings }),
}));
const script = object({ label: string, applicableScene: string, script: string, keyPoints: strings });
const remedy = object({
  title: string, punchline: string,
  hrMindsetAnalysis: object({ coreConcerns: strings, riskPoints: strings, whatHrWantsToHear: string }),
  reframeFormula: object({ factAcknowledgment: string, positiveAttribution: string, growthAndValue: string, motivationAlignment: string }),
  scripts: object({ concise: script, detailed: script, pivoting: script }),
  drills: list(object({ question: string, hrConcern: string, bestResponse: string })),
  forbiddenList: strings, closingTips: strings,
});

/** 只有对应数据库列定义的空字符串默认值可跳过 JSON 解析。{} / [] 由各领域显式允许。 */
const json = (check: Check, allowEmptyString = false): Check => (raw) => {
  if (typeof raw !== "string") return false;
  if (raw === "" && allowEmptyString) return true;
  try { return check(JSON.parse(raw)); } catch { return false; }
};
const fields: Record<string, Record<string, Check>> = {
  application_interview_recaps: { questions: json(list(realInterviewQuestion)), result: json(realInterviewResult) },
  resume_versions: {
    snapshot: json(object({
      title: string, template: string, style_overrides: record, resolved_style: style,
      modules: list((value) => object({
        key: string, type: oneOf(...Object.keys(moduleContent)), label: string, sort: number,
        content: (content) => record(value) && typeof value.type === "string" &&
          Object.hasOwn(moduleContent, value.type) && moduleContent[value.type]!(content),
      })(value)),
    })),
  },
  applications: {
    submitted_resume: nullable(json(object({
      id: (value) => Number.isSafeInteger(value) && (value as number) > 0,
      title: string, template: string, style_overrides: record,
      modules: list((value) => object({
        key: string, type: oneOf(...Object.keys(moduleContent)), label: string, sort: number,
        content: (content) => record(value) && typeof value.type === "string" &&
          Object.hasOwn(moduleContent, value.type) && moduleContent[value.type]!(content),
      })(value)),
    }))),
  },
  projects: { summary: json(isStoredProjectSummary) },
  project_summary_history: {
    summary: json(isStoredProjectSummary),
    ai_baseline: json((value) => record(value) && Object.entries(value).every(([key, text]) =>
      (key === "overview" || key === "architecture" || key === "highlights" || key === "responsibilities" ||
        key === "challenges" || key === "techStack" || key === "brief" || /^achievement:(0|[1-9]\d*)$/.test(key)) && string(text))),
    material_snapshot: nullable(json(list(object({
      id: (value) => Number.isSafeInteger(value) && (value as number) > 0,
      title: string,
      digest: (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    })))),
  },
  drill_questions: { scores: json(scores, true) },
  notebook_entries: { scores: json(scores, true) },
  interviews: { report: json(interviewReport, true), reverse_interview: json(reverseInterview, true), evaluator_report: json(evaluatorReport, true) },
  interview_turns: { scores: json(scores, true), retries: json(retries) },
  interview_series: { final_report: json(seriesReport, true) },
  resume_diagnoses: {
    report: json(diagnosis),
    resume_snapshot: json(object({ title: string, modules: list((value) => object({
      key: string, type: oneOf(...Object.keys(moduleContent)), label: string, sort: number,
      content: (content) => record(value) && typeof value.type === "string" &&
        Object.hasOwn(moduleContent, value.type) && moduleContent[value.type]!(content),
    })(value)) })),
    adoptions: json(list(object({
      moduleKey: string, suggestionIndex: (value) => Number.isSafeInteger(value) && (value as number) >= 0,
      value: (value) => string(value) || strings(value),
      applied_at: (value) => typeof value === "string" && Number.isFinite(Date.parse(value)),
    }))),
  },
  intro_versions: { sentences: json(list(object({ text: string, comment: string }))) },
  resume_templates: { style: json(style) },
  jd_portraits: { result: json(jdPortrait, true) },
  jargon_decodings: { result: json(jargon, true) },
  salary_negotiations: { report: json(negotiationReport, true) },
  salary_negotiation_turns: { hr_mindset: json(orEmptyObject(hrMindset)), mentor_analysis: json(orEmptyObject(mentorAnalysis)) },
  resume_defenses: { scanned_items: json(scannedItems) },
  resignation_gap_remedies: { result: json(remedy, true) },
};

/** 返回损坏的列名，供备份入口附上表名与行标识；成功时不改写输入。 */
export function invalidDomainColumn(table: string, row: Record<string, unknown>): string | undefined {
  if (table === "applications") {
    if (row.submitted_at === null) {
      if (row.submitted_resume !== null || row.submitted_jd !== null) return "submitted_at";
    } else {
      if (typeof row.submitted_at !== "string" || !Number.isFinite(Date.parse(row.submitted_at))) return "submitted_at";
      if (typeof row.submitted_jd !== "string") return "submitted_jd";
    }
  }
  if (table === "resume_modules") {
    const check = typeof row.type === "string" && Object.hasOwn(moduleContent, row.type) ? moduleContent[row.type] : undefined;
    return check && json(orEmptyObject(check))(row.content) ? undefined : "content";
  }
  return Object.entries(fields[table] ?? {}).find(([column, check]) => !check(row[column]))?.[0];
}

/** 外键只能保证节点存在；版本归属与树的方向还需验证。 */
export function validateResumeVersionRelations(database: DatabaseSync): void {
  const invalidParent = database.prepare(`SELECT 1 FROM resume_versions v JOIN resume_versions p ON p.id = v.parent_id
    WHERE v.resume_id != p.resume_id OR p.version >= v.version LIMIT 1`).get();
  const invalidBase = database.prepare(`SELECT 1 FROM resumes r JOIN resume_versions v ON v.id = r.base_version_id
    WHERE r.id != v.resume_id LIMIT 1`).get();
  if (invalidParent || invalidBase) throw new Error("简历版本树归属或父节点顺序无效");
  for (const table of ["applications", "interviews", "interview_series", "intros", "resume_diagnoses", "resume_defenses"]) {
    if (database.prepare(`SELECT 1 FROM ${table} c JOIN resume_versions v ON v.id = c.resume_version_id
      WHERE c.resume_id IS NULL OR c.resume_id != v.resume_id LIMIT 1`).get()) {
      throw new Error(`${table} 的简历版本归属无效`);
    }
  }
}
