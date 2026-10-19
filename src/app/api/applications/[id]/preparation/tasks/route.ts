import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { getDb, inTransaction } from "@/lib/db";
import { PreparationInputError, preparationApplication, createPreparationTask, normalizePreparationDueTime } from "@/lib/application-preparation";

async function handle(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const applicationId = Number((await params).id);
    preparationApplication(applicationId);
    const parsed = await parseApiJson<{ title?: unknown; due_time?: unknown; id?: unknown; done?: unknown } | null>(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    if (req.method === "POST") return NextResponse.json(createPreparationTask(applicationId, body?.title, body?.due_time), { status: 201 });
    if (typeof body?.id !== "number" || !Number.isSafeInteger(body.id) || body.id <= 0) throw new PreparationInputError("无效的待办 ID");
    const taskId = body.id;
    if (req.method === "PATCH") {
      const updates: string[] = [];
      const args: (number | string)[] = [];
      if (typeof body.done === "boolean") {
        updates.push("done = ?");
        args.push(body.done ? 1 : 0);
      }
      if (body.due_time !== undefined) {
        updates.push("due_time = ?");
        args.push(normalizePreparationDueTime(body.due_time));
      }
      if (typeof body.title === "string") {
        if (!body.title.trim() || body.title.trim().length > 200) throw new PreparationInputError("待办内容需为 1–200 字");
        updates.push("title = ?");
        args.push(body.title.trim());
      }
      if (updates.length === 0) throw new PreparationInputError("未提供要更新的字段");
      args.push(body.id, applicationId);
      const result = inTransaction(() => getDb().prepare(`UPDATE application_preparation_tasks SET ${updates.join(", ")} WHERE id = ? AND application_id = ?`).run(...args));
      if (!result.changes) throw new PreparationInputError("待办不存在或不属于此投递", 404);
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
