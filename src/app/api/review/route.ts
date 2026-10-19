import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { DIMENSIONS, overallOf, safeScores, type ScoreMap } from "@/lib/scores";

const BATCH_SIZE = 1000;
const MAX_REVIEW_ANSWERS_PER_KIND = 10_000;

type ScoreAccumulator = { count: number; sums: ScoreMap };

function newAccumulator(): ScoreAccumulator {
  return { count: 0, sums: { depth: 0, structure: 0, authenticity: 0, completeness: 0 } };
}

function addScore(acc: ScoreAccumulator, scores: ScoreMap): void {
  acc.count += 1;
  for (const { key } of DIMENSIONS) acc.sums[key] += scores[key];
}

function average(acc: ScoreAccumulator): ScoreMap | null {
  if (!acc.count) return null;
  const result = {} as ScoreMap;
  for (const { key } of DIMENSIONS) result[key] = Math.round((acc.sums[key] / acc.count) * 10) / 10;
  return result;
}

type Session = ScoreAccumulator & {
  id: string;
  kind: "drill" | "interview";
  label: string;
  date: string;
};

/** 复盘仪表盘聚合：跨题目练习与模拟面试的已评分作答（详见 /review 页） */
async function handleGet() {
  const db = getDb();
  const sessionsMap = new Map<string, Session>();
  const projectMap = new Map<number, ScoreAccumulator & { id: number; name: string }>();
  const overallScores = newAccumulator();
  const drillScores = newAccumulator();
  const interviewScores = newAccumulator();
  let drillTruncated = false;
  let interviewTruncated = false;

  function addAnswer(kind: Session["kind"], id: number, label: string, date: string, scores: ScoreMap) {
    const key = `${kind}-${id}`;
    let session = sessionsMap.get(key);
    if (!session) {
      session = { ...newAccumulator(), id: key, kind, label, date };
      sessionsMap.set(key, session);
    }
    addScore(session, scores);
    if (date > session.date) session.date = date;
    addScore(overallScores, scores);
    addScore(kind === "drill" ? drillScores : interviewScores, scores);
  }

  const drillSelect = `SELECT dq.id AS answer_id, d.id, p.id AS project_id,
            COALESCE(p.name, NULLIF(d.direction, ''), substr(d.jd, 1, 20), '') AS label,
            dq.scores, dq.answered_at
     FROM drill_questions dq
     JOIN drills d ON d.id = dq.drill_id
     LEFT JOIN projects p ON p.id = d.project_id`;
  const drillWhere = "dq.answered_at != '' AND dq.scores != ''";
  const firstDrillQuery = db.prepare(
    `${drillSelect} WHERE ${drillWhere} ORDER BY dq.id DESC LIMIT ${BATCH_SIZE}`,
  );
  const drillQuery = db.prepare(
    `${drillSelect} WHERE dq.id < ? AND ${drillWhere} ORDER BY dq.id DESC LIMIT ${BATCH_SIZE}`,
  );
  let lastDrillAnswerId: number | null = null;
  let drillAnswerCount = 0;
  for (;;) {
    const rows = (lastDrillAnswerId === null
      ? firstDrillQuery.all()
      : drillQuery.all(lastDrillAnswerId)) as {
      answer_id: number; id: number; project_id: number | null; label: string | null;
      scores: string; answered_at: string;
    }[];
    if (!rows.length) break;
    for (const row of rows) {
      lastDrillAnswerId = row.answer_id;
      const scores = safeScores(row.scores);
      if (!scores) continue;
      if (drillAnswerCount >= MAX_REVIEW_ANSWERS_PER_KIND) {
        drillTruncated = true;
        break;
      }
      addAnswer("drill", row.id, row.label ?? "未命名练习", row.answered_at, scores);
      drillAnswerCount += 1;
      if (row.project_id === null) continue;
      let project = projectMap.get(row.project_id);
      if (!project) {
        project = { ...newAccumulator(), id: row.project_id, name: row.label ?? "未命名项目" };
        projectMap.set(row.project_id, project);
      }
      addScore(project, scores);
    }
    if (drillTruncated) break;
  }
  if (!drillTruncated && drillAnswerCount >= MAX_REVIEW_ANSWERS_PER_KIND && lastDrillAnswerId !== null) {
    drillTruncated = (drillQuery.all(lastDrillAnswerId) as unknown[]).length > 0;
  }

  const interviewSelect = `SELECT t.id AS answer_id, i.id, r.title AS label, t.scores, t.answered_at
     FROM interview_turns t
     JOIN interviews i ON i.id = t.interview_id
     JOIN resumes r ON r.id = i.resume_id`;
  const interviewWhere = "t.answered_at != '' AND t.scores != ''";
  const firstInterviewQuery = db.prepare(
    `${interviewSelect} WHERE ${interviewWhere} ORDER BY t.id DESC LIMIT ${BATCH_SIZE}`,
  );
  const interviewQuery = db.prepare(
    `${interviewSelect} WHERE t.id < ? AND ${interviewWhere} ORDER BY t.id DESC LIMIT ${BATCH_SIZE}`,
  );
  let lastInterviewAnswerId: number | null = null;
  let interviewAnswerCount = 0;
  for (;;) {
    const rows = (lastInterviewAnswerId === null
      ? firstInterviewQuery.all()
      : interviewQuery.all(lastInterviewAnswerId)) as {
      answer_id: number; id: number; label: string; scores: string; answered_at: string;
    }[];
    if (!rows.length) break;
    for (const row of rows) {
      lastInterviewAnswerId = row.answer_id;
      const scores = safeScores(row.scores);
      if (!scores) continue;
      if (interviewAnswerCount >= MAX_REVIEW_ANSWERS_PER_KIND) {
        interviewTruncated = true;
        break;
      }
      addAnswer("interview", row.id, row.label, row.answered_at, scores);
      interviewAnswerCount += 1;
    }
    if (interviewTruncated) break;
  }
  if (!interviewTruncated && interviewAnswerCount >= MAX_REVIEW_ANSWERS_PER_KIND && lastInterviewAnswerId !== null) {
    interviewTruncated = (interviewQuery.all(lastInterviewAnswerId) as unknown[]).length > 0;
  }

  // 场次聚合：每场练习/每次面试为一个趋势点，场均分取该场已评分作答的均值
  const sessions = [...sessionsMap.values()]
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1))
    .map((session) => {
      const avg = average(session)!;
      return {
        id: session.id, kind: session.kind, label: session.label, date: session.date,
        count: session.count, avg, overall: overallOf(avg),
      };
    });

  // 按项目分布：只有绑定项目的练习作答参与；题库出题的练习与面试作答不落项目
  const projects = [...projectMap.values()]
    .map((project) => ({
      id: project.id, name: project.name, answers: project.count,
      overall: overallOf(average(project)!),
    }))
    .sort((a, b) => b.answers - a.answers || a.name.localeCompare(b.name));

  const overall = average(overallScores);
  return NextResponse.json({
    totals: {
      drills: sessions.filter((session) => session.kind === "drill").length,
      interviews: sessions.filter((session) => session.kind === "interview").length,
      scoredAnswers: overallScores.count,
    },
    overall,
    overallScore: overall ? overallOf(overall) : null,
    drillAvg: average(drillScores),
    interviewAvg: average(interviewScores),
    truncated: drillTruncated || interviewTruncated,
    sessions,
    projects,
  });
}

export const GET = withRouteErrorHandling("GET /api/review", handleGet);
