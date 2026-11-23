import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { parseApiJson } from "@/lib/api-request";
import { getDb, inTransaction, now } from "@/lib/db";
import { INTERVIEW_QUESTION_GRAPH_HISTORY_LIMIT, parseInterviewQuestionGraphDocument } from "@/lib/interview-question-graph";
import { parseCanonicalPositiveId } from "@/lib/id-parsing";

type RouteContext = { params: Promise<{ id: string }> };
type UndoRequest = { expected_revision?: unknown };

async function handlePost(req: Request, context: RouteContext) {
  const id = parseCanonicalPositiveId((await context.params).id);
  if (id === null) return NextResponse.json({ error: "题目图谱编号无效" }, { status: 400 });
  const parsed = await parseApiJson<UndoRequest>(req);
  if (!parsed.ok) return parsed.response;
  const expectedRevision = parsed.data?.expected_revision;
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) {
    return NextResponse.json({ error: "图谱版本号无效" }, { status: 400 });
  }

  const result = inTransaction(() => {
    const db = getDb();
    const row = db.prepare("SELECT graph_json, history_json, revision FROM interview_question_graphs WHERE id = ?").get(id) as {
      graph_json: string;
      history_json: string;
      revision: number;
    } | undefined;
    if (!row) return { status: 404 as const };
    if (row.revision !== expectedRevision) return { status: 409 as const, error: "图谱已在其他页面更新，请重新载入历史记录" };
    const historyValue: unknown = JSON.parse(row.history_json);
    if (!Array.isArray(historyValue) || historyValue.length > INTERVIEW_QUESTION_GRAPH_HISTORY_LIMIT) throw new Error("Saved interview question graph history is invalid");
    if (historyValue.length === 0) return { status: 409 as const, error: "没有可撤销的图谱扩展" };
    const history = historyValue.map(parseInterviewQuestionGraphDocument);
    const root = history[history.length - 1]!;
    const nextHistory = history.slice(0, -1);
    const revision = row.revision + 1;
    const update = db.prepare(
      "UPDATE interview_question_graphs SET graph_json = ?, history_json = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?",
    ).run(JSON.stringify(root), JSON.stringify(nextHistory), revision, now(), id, expectedRevision);
    if (update.changes !== 1) return { status: 409 as const, error: "图谱已在其他页面更新，请重新载入历史记录" };
    return { status: 200 as const, graph: root, history: nextHistory, revision };
  });
  if (result.status === 404) return NextResponse.json({ error: "题目图谱历史记录不存在" }, { status: 404 });
  if (result.status === 409) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ graph: result.graph, history: result.history, revision: result.revision });
}

export const POST = withRouteErrorHandling<RouteContext>("POST /api/interviews/question-graphs/[id]/undo", handlePost);
