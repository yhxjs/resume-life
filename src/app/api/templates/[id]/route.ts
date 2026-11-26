import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { ApplicationInputError } from "@/lib/applications";
import { deleteCustomTemplate, updateCustomTemplate } from "@/lib/template-store";

async function handlePatch(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseCanonicalPositiveId((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "无效的模板 ID" }, { status: 400 });
  const parsed = await parseApiJson<unknown>(req);
  if (!parsed.ok) return parsed.response;
  try {
    const result = updateCustomTemplate(id, parsed.data);
    return result ? NextResponse.json(result) : NextResponse.json({ error: "模板不存在" }, { status: 404 });
  } catch (error) {
    if (error instanceof ApplicationInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseCanonicalPositiveId((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "无效的模板 ID" }, { status: 400 });
  return deleteCustomTemplate(id) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "模板不存在" }, { status: 404 });
}
export const PATCH = withRouteErrorHandling("PATCH /api/templates/[id]", handlePatch);
export const DELETE = withRouteErrorHandling("DELETE /api/templates/[id]", handleDelete);
