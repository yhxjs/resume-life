import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { INTERVIEW_QUESTION_GRAPH_HISTORY_LIMIT, parseInterviewQuestionGraphDocument } from "@/lib/interview-question-graph";
import { parseCanonicalPositiveId } from "@/lib/id-parsing";

type RouteContext = { params: Promise<{ id: string }> };

async function handleGet(_req: Request, context: RouteContext) {
  const id = parseCanonicalPositiveId((await context.params).id);
  if (id === null) return NextResponse.json({ error: "题目图谱编号无效" }, { status: 400 });
  const row = getDb().prepare(
    `SELECT g.id, g.resume_id, g.resume_version_id, g.jd, g.style, g.question, g.graph_json, g.history_json,
            g.revision, g.created_at, g.updated_at, COALESCE(json_extract(rv.snapshot, '$.title'), r.title) AS resume_title
     FROM interview_question_graphs g
     JOIN resumes r ON r.id = g.resume_id
     LEFT JOIN resume_versions rv ON rv.id = g.resume_version_id
     WHERE g.id = ?`,
  ).get(id) as {
    id: number;
    resume_id: number;
    resume_version_id: number | null;
    jd: string;
    style: string;
    question: string;
    graph_json: string;
    history_json: string;
    revision: number;
    created_at: string;
    updated_at: string;
    resume_title: string;
  } | undefined;
  if (!row) return NextResponse.json({ error: "题目图谱历史记录不存在" }, { status: 404 });
  const graph = parseInterviewQuestionGraphDocument(JSON.parse(row.graph_json) as unknown);
  const historyValue: unknown = JSON.parse(row.history_json);
  if (!Array.isArray(historyValue) || historyValue.length > INTERVIEW_QUESTION_GRAPH_HISTORY_LIMIT) throw new Error("Saved interview question graph history is invalid");
  const history = historyValue.map(parseInterviewQuestionGraphDocument);
  return NextResponse.json({
    id: row.id,
    resume_id: row.resume_id,
    resume_version_id: row.resume_version_id,
    resume_title: row.resume_title,
    jd: row.jd,
    style: row.style,
    question: row.question,
    graph,
    history,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

export const GET = withRouteErrorHandling<RouteContext>("GET /api/interviews/question-graphs/[id]", handleGet);
