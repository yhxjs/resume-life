import { overallOf, readStoredScores, type ScoreMap } from "./scores";

export const MAX_REVIEW_ANSWERS_PER_KIND = 10_000;
export type ReviewSessionPoint = {
  id: string; kind: "drill" | "interview"; label: string; date: string;
  count: number; avg: ScoreMap; overall: number;
};
export type ReviewProjectStat = { id: number; name: string; answers: number; overall: number };
export type ReviewDashboard = {
  totals: { drills: number; interviews: number; scoredAnswers: number };
  overall: ScoreMap | null; overallScore: number | null;
  drillAvg: ScoreMap | null; interviewAvg: ScoreMap | null;
  truncated: boolean; sessions: ReviewSessionPoint[]; projects: ReviewProjectStat[];
};

function invalid(): never { throw new Error("复盘数据不完整或不一致，请重新读取"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function count(value: unknown, max: number, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}
function score(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10) invalid();
  return value;
}
function average(value: unknown, hasAnswers: boolean): ScoreMap | null {
  if (!hasAnswers) { if (value !== null) invalid(); return null; }
  const scores = readStoredScores(value);
  if (!scores) invalid();
  return scores;
}

/**
 * 整份快照通过后才显示。只核对可由回包证明的关系，不从已舍入场均分
 * 反推来源／全局均分：二次加权舍入不一定等于后端按原始作答计算的结果。
 * 历史名称、日期字面量、零／负 ID 保留，不套用新建记录的输入限制。
 */
export function readReviewDashboard(value: unknown): ReviewDashboard {
  const data = record(value), rawTotals = record(data.totals);
  const limit = MAX_REVIEW_ANSWERS_PER_KIND;
  const totals = {
    drills: count(rawTotals.drills, limit), interviews: count(rawTotals.interviews, limit),
    scoredAnswers: count(rawTotals.scoredAnswers, limit * 2),
  };
  if (typeof data.truncated !== "boolean" || !Array.isArray(data.sessions) || data.sessions.length > limit * 2
    || !Array.isArray(data.projects) || data.projects.length > totals.drills) invalid();

  const seenSessions = new Set<string>();
  const sourceAnswers = { drill: 0, interview: 0 }, sourceSessions = { drill: 0, interview: 0 };
  let previousDate: string | undefined;
  const sessions = data.sessions.map((value): ReviewSessionPoint => {
    const item = record(value), kind = item.kind;
    if ((kind !== "drill" && kind !== "interview") || typeof item.id !== "string" || !item.id.startsWith(`${kind}-`)
      || typeof item.label !== "string" || typeof item.date !== "string") invalid();
    const idPart = item.id.slice(kind.length + 1), id = Number(idPart);
    if (!Number.isSafeInteger(id) || String(id) !== idPart || seenSessions.has(item.id)
      || (previousDate !== undefined && previousDate > item.date)) invalid();
    seenSessions.add(item.id);
    previousDate = item.date;
    const answers = count(item.count, limit, 1), avg = average(item.avg, true)!;
    const overall = score(item.overall);
    if (overall !== overallOf(avg)) invalid();
    sourceAnswers[kind] += answers;
    sourceSessions[kind]++;
    return { id: item.id, kind, label: item.label, date: item.date, count: answers, avg, overall };
  });
  if (sourceSessions.drill !== totals.drills || sourceSessions.interview !== totals.interviews
    || sourceAnswers.drill > limit || sourceAnswers.interview > limit
    || sourceAnswers.drill + sourceAnswers.interview !== totals.scoredAnswers
    || (data.truncated && sourceAnswers.drill < limit && sourceAnswers.interview < limit)) invalid();

  const overall = average(data.overall, totals.scoredAnswers > 0);
  const drillAvg = average(data.drillAvg, sourceAnswers.drill > 0);
  const interviewAvg = average(data.interviewAvg, sourceAnswers.interview > 0);
  const overallScore = overall ? score(data.overallScore) : null;
  if (overall ? overallScore !== overallOf(overall) : data.overallScore !== null) invalid();

  const seenProjects = new Set<number>();
  let projectAnswers = 0;
  const projects = data.projects.map((value): ReviewProjectStat => {
    const item = record(value);
    if (typeof item.id !== "number" || !Number.isSafeInteger(item.id) || seenProjects.has(item.id) || typeof item.name !== "string") invalid();
    seenProjects.add(item.id);
    const answers = count(item.answers, sourceAnswers.drill, 1);
    projectAnswers += answers;
    return { id: item.id, name: item.name, answers, overall: score(item.overall) };
  });
  if (projectAnswers > sourceAnswers.drill) invalid();
  return { totals, overall, overallScore, drillAvg, interviewAvg, truncated: data.truncated, sessions, projects };
}
