import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { getDb, inTransaction } from "@/lib/db";
import { PreparationInputError, preparationApplication, createPreparationTask, updatePreparationTask } from "@/lib/application-preparation";

async function handle(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const applicationId = parseCanonicalPositiveId((await params).id);
    preparationApplication(applicationId);
    const parsed = await parseApiJson<{ title?: unknown; due_time?: unknown; id?: unknown; done?: unknown } | null>(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    if (req.method === "POST") return NextResponse.json(createPreparationTask(applicationId, body?.title, body?.due_time), { status: 201 });
    if (typeof body?.id !== "number" || !Number.isSafeInteger(body.id) || body.id <= 0) throw new PreparationInputError("无效的待办 ID");
    const taskId = body.id;
    if (req.method === "PATCH") {
      updatePreparationTask(applicationId, taskId, body);
      return NextResponse.json({ ok: true });
    }
    const result = inTransaction(() => getDb().prepare("DELETE FROM application_preparation_tasks WHERE id = ? AND application_id = ?").run(taskId, applicationId));
    if (!result.changes) throw new PreparationInputError("待办不存在或不属于此投递", 404);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof PreparationInputError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
export const POST = withRouteErrorHandling("POST /api/applications/[id]/preparation/tasks", handle);
export const PATCH = withRouteErrorHandling("PATCH /api/applications/[id]/preparation/tasks", handle);
export const DELETE = withRouteErrorHandling("DELETE /api/applications/[id]/preparation/tasks", handle);
