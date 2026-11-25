import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { ApplicationInputError } from "@/lib/applications";
import { getNotebookNote, saveNotebookNote, NotebookMutationError } from "@/lib/notebook-storage";

type Context = { params: Promise<{ id: string }> };
function failure(error: unknown) {
  if (error instanceof ApplicationInputError) return NextResponse.json({ error: error.message }, { status: 400 });
  if (error instanceof NotebookMutationError) return NextResponse.json({ error: error.message }, { status: error.status });
  throw error;
}

export const GET = withRouteErrorHandling("GET /api/notebook/[id]/note", async (_req, { params }: Context) => {
  const id = parseCanonicalPositiveId((await params).id);
  if (!Number.isSafeInteger(id)) return NextResponse.json({ error: "无效的错题 ID" }, { status: 400 });
  try { return NextResponse.json(getNotebookNote(id), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return failure(error); }
});

export const PUT = withRouteErrorHandling("PUT /api/notebook/[id]/note", async (req, { params }: Context) => {
  const id = parseCanonicalPositiveId((await params).id);
  if (!Number.isSafeInteger(id)) return NextResponse.json({ error: "无效的错题 ID" }, { status: 400 });
  const parsed = await parseApiJson<unknown>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data as { content?: unknown; expectedRevision?: unknown } | null;
  if (typeof body?.content !== "string" || typeof body.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedRevision)) return NextResponse.json({ error: "请提供补充笔记及刚读取的 revision" }, { status: 400 });
  try { return NextResponse.json(saveNotebookNote(id, { content: body.content, expectedRevision: body.expectedRevision })); }
  catch (error) { return failure(error); }
});
