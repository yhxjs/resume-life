import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";
import {
  RequestFormatError,
  RequestTooLargeError,
  assertProjectMaterial,
  assertProjectMaterialTitle,
  readJsonBody,
} from "@/lib/request-limits";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { loadProjectMaterial, updateProjectMaterial } from "@/lib/project-materials";

async function handleGet(
  _req: Request,
  { params }: { params: Promise<{ id: string; mid: string }> }
) {
  const { id, mid } = await params;
  const projectId = Number(id);
  const materialId = Number(mid);
  if (!Number.isInteger(projectId) || !Number.isInteger(materialId)) return NextResponse.json({ error: "无效的 ID" }, { status: 400 });
  const row = loadProjectMaterial(projectId, materialId);
  if (!row) return NextResponse.json({ error: "材料不存在" }, { status: 404 });
  return NextResponse.json(row);
}

/** 编辑材料：修正标题与内容（导入提取的文本常有错漏） */
async function handlePatch(
  req: Request,
  { params }: { params: Promise<{ id: string; mid: string }> }
) {
  const { id, mid } = await params;
  const projectId = Number(id);
  const materialId = Number(mid);
  if (!Number.isInteger(projectId) || !Number.isInteger(materialId)) {
    return NextResponse.json({ error: "无效的 ID" }, { status: 400 });
  }
  let title = "";
  let content = "";
  let expectedRevision = "";
  try {
    const body = await readJsonBody<{
      title?: unknown;
      content?: unknown;
      expectedRevision?: unknown;
    } | null>(req);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "请求体无效" }, { status: 400 });
    }
      title = typeof body.title === "string" ? body.title.trim() : "";
      content = typeof body.content === "string" ? body.content : "";
      expectedRevision = typeof body.expectedRevision === "string" ? body.expectedRevision : "";
      if (!/^[a-f0-9]{64}$/.test(expectedRevision)) return NextResponse.json({ error: "材料版本参数无效" }, { status: 400 });
    assertProjectMaterial(content);
    assertProjectMaterialTitle(title);
    if (!title || !content.trim()) {
      return NextResponse.json({ error: "标题和内容不能为空" }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof RequestTooLargeError) {
      return NextResponse.json({ error: "请求体或材料内容过大，材料标题不得超过 200 字" }, { status: 413 });
    }
    if (err instanceof RequestFormatError) {
      return NextResponse.json({ error: "JSON 请求体格式无效" }, { status: 400 });
    }
    const requestId = logServerError("project-materials.update.request", err, {
      requestId: requestIdFrom(req),
      status: 500,
    });
    return NextResponse.json(
      { error: "更新项目材料失败，请稍后重试", requestId },
      { status: 500 }
    );
  }
  const result = updateProjectMaterial(projectId, materialId, { title, content, expectedRevision });
  if (result.status === "missing") return NextResponse.json({ error: "材料不存在" }, { status: 404 });
  if (result.status === "conflict") return NextResponse.json({ error: "材料已被其他页面更新，请刷新后重新编辑" }, { status: 409 });
  return NextResponse.json({ ok: true, revision: result.revision });
}

async function handleDelete(
  _req: Request,
  { params }: { params: Promise<{ id: string; mid: string }> }
) {
  const { id, mid } = await params;
  const projectId = Number(id);
  const materialId = Number(mid);
  if (!Number.isInteger(projectId) || !Number.isInteger(materialId)) {
    return NextResponse.json({ error: "无效的 ID" }, { status: 400 });
  }
  const db = getDb();
  const result = inTransaction(() => db
    .prepare("DELETE FROM project_materials WHERE id = ? AND project_id = ?")
    .run(materialId, projectId));
  if (result.changes === 0) return NextResponse.json({ error: "材料不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const DELETE = withRouteErrorHandling("DELETE /api/projects/[id]/materials/[mid]", handleDelete);
export const PATCH = withRouteErrorHandling("PATCH /api/projects/[id]/materials/[mid]", handlePatch);
export const GET = withRouteErrorHandling("GET /api/projects/[id]/materials/[mid]", handleGet);
