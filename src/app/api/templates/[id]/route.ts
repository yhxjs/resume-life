import { clearEntityLlmLabels } from "@/lib/llm-label-cleanup";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now } from "@/lib/db";
import { customRef, normalizeStyle } from "@/lib/templates";
import { readCustomTemplate } from "@/lib/custom-templates";

async function handlePatch(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "无效的模板 ID" }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "请求体无效" }, { status: 400 });

  const name =
    body.name !== undefined
      ? typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : null
      : undefined;
  if (name === null) return NextResponse.json({ error: "模板名称不能为空" }, { status: 400 });
  if (name !== undefined && name.length > 30) {
    return NextResponse.json({ error: "模板名称不能超过 30 字" }, { status: 400 });
  }
  const style = body.style !== undefined ? normalizeStyle(body.style) : undefined;
  if (style === null) return NextResponse.json({ error: "样式参数无效" }, { status: 400 });
  if (name === undefined && style === undefined) {
    return NextResponse.json({ error: "没有需要保存的修改" }, { status: 400 });
  }

  const db = getDb();
  const ts = now();
  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (name !== undefined) {
    sets.push("name = ?");
    args.push(name);
  }
  if (style !== undefined) {
    sets.push("style = ?");
    args.push(JSON.stringify(style));
  }
  sets.push("updated_at = ?");
  args.push(ts, numericId);
  const result = inTransaction(() => db
    .prepare(`UPDATE resume_templates SET ${sets.join(", ")} WHERE id = ?`)
    .run(...args));
  if (result.changes === 0) return NextResponse.json({ error: "模板不存在" }, { status: 404 });

  const row = db
    .prepare("SELECT id, name, style, created_at, updated_at FROM resume_templates WHERE id = ?")
    .get(numericId) as { id: number; name: string; style: string; created_at: string; updated_at: string };
  return NextResponse.json(readCustomTemplate(row));
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "无效的模板 ID" }, { status: 400 });
  }
  const db = getDb();
  const result = inTransaction(() => {
    clearEntityLlmLabels(db, "template", numericId);
    const deleted = db.prepare("DELETE FROM resume_templates WHERE id = ?").run(numericId);
    if (deleted.changes === 0) return deleted;
    // 引用了该模板的简历回退到经典单栏，避免留下无法解析的 custom:<id>
    db.prepare("UPDATE resumes SET template = 'classic', updated_at = ? WHERE template = ?").run(
      now(),
      customRef(numericId)
    );
    return deleted;
  });
  if (result.changes === 0) return NextResponse.json({ error: "模板不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const PATCH = withRouteErrorHandling("PATCH /api/templates/[id]", handlePatch);
export const DELETE = withRouteErrorHandling("DELETE /api/templates/[id]", handleDelete);
