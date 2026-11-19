import { overallOf, type ScoreMap } from "../../src/lib/scores";

/** 与实际聚合关系一致的两种来源，保留历史文本与日期字面量。 */
export function reviewDashboardFixture() {
  const drill: ScoreMap = { depth: 7.4, structure: 8.2, authenticity: 0, completeness: 10 };
  const interview: ScoreMap = { depth: 8.2, structure: 7.4, authenticity: 10, completeness: 0 };
  const overall: ScoreMap = { depth: 7.8, structure: 7.8, authenticity: 5, completeness: 5 };
  return {
    totals: { drills: 1, interviews: 1, scoredAnswers: 2 },
    overall, overallScore: overallOf(overall), drillAvg: drill, interviewAvg: interview, truncated: false,
    sessions: [
      { id: "drill-0", kind: "drill" as const, label: "  <T> &amp;\n历史练习  ", date: "旧时间字面量", count: 1, avg: drill, overall: overallOf(drill) },
      { id: "interview--1", kind: "interview" as const, label: "历史面试", date: "旧时间字面量", count: 1, avg: interview, overall: overallOf(interview) },
    ],
    projects: [{ id: 0, name: "  项目 <T> &amp;  ", answers: 1, overall: overallOf(drill) }],
  };
}

export function emptyReviewDashboardFixture() {
  return { totals: { drills: 0, interviews: 0, scoredAnswers: 0 }, overall: null, overallScore: null,
    drillAvg: null, interviewAvg: null, truncated: false, sessions: [], projects: [] };
}
