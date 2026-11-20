import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { ApplicationInputError } from "@/lib/applications";
import { createEvidenceDrill } from "@/lib/project-evidence-drill";
import { ProjectSummaryCorruptError } from "@/lib/summary";

export const POST = withRouteErrorHandling("POST /api/projects/[id]/evidence-drill", async (req, { params }) => {
  const id = parseCanonicalPositiveId((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "项目编号无效" }, { status: 400 });
  const body = await parseApiJson<unknown>(req);
  if (!body.ok) return body.response;
  try {
    req.signal.throwIfAborted();
    const result = createEvidenceDrill(id, body.data);
    return result ? NextResponse.json(result, { status: 201 }) : NextResponse.json({ error: "项目不存在" }, { status: 404 });
  } catch (error) {
    if (error instanceof ProjectSummaryCorruptError) return NextResponse.json({ error: error.message }, { status: 422 });
    if (error instanceof ApplicationInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
});
