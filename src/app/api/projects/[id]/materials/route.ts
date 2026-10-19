import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now } from "@/lib/db";
import { extractContentFromPath, ParseBusyError } from "@/lib/parse-file";
import { FileFormatError } from "@/lib/parse-sandbox";
import {
  RequestFormatError,
  RequestTooLargeError,
  assertProjectMaterial,
  assertProjectMaterialTitle,
  readJsonBody,
} from "@/lib/request-limits";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import {
  isMultipartFormDataRequest,
  MultipartFormatError,
  parseMultipartUpload,
} from "@/lib/streaming-multipart";

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: "无效的项目 ID" }, { status: 400 });
  }
  const db = getDb();
  if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const isMultipart = isMultipartFormDataRequest(req);
  let title = "";
  let content = "";
  let source = "paste";
  let filename = "";
  let fileOcr: { engine: "vision" | "local"; pageCount: number } | undefined;
  let upload: Awaited<ReturnType<typeof parseMultipartUpload>> | undefined;

  try {
    if (isMultipart) {
      upload = await parseMultipartUpload(req);
      const file = upload.file;
      if (!file) {
        return NextResponse.json({ error: "未收到文件" }, { status: 400 });
      }
      filename = file.filename;
      source = "file";
      const extracted = await extractContentFromPath(file.filename, file.path, { signal: req.signal });
      content = extracted.text;
      fileOcr = extracted.ocr;
      title = upload.fields.title?.trim() ?? "";
      if (!title) title = filename;
    } else {
      const body = await readJsonBody<{
        title?: unknown;
        content?: unknown;
      } | null>(req);
      content = typeof body?.content === "string" ? body.content : "";
      title = typeof body?.title === "string" ? body.title.trim() : "";
    }
    assertProjectMaterial(content);
    assertProjectMaterialTitle(title);
    req.signal.throwIfAborted();
  } catch (err) {
    if (err instanceof ParseBusyError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    if (err instanceof RequestTooLargeError) {
      return NextResponse.json({ error: "请求体、文件或材料内容过大，材料标题不得超过 200 字" }, { status: 413 });
    }
    if (err instanceof RequestFormatError || err instanceof MultipartFormatError) {
      return NextResponse.json({ error: "请求格式无效" }, { status: 400 });
    }
    if (err instanceof FileFormatError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const requestId = logServerError("project-materials.create.request", err, {
      requestId: requestIdFrom(req),
      status: 500,
    });
    return NextResponse.json(
      { error: "保存项目材料失败，请稍后重试", requestId },
      { status: 500 }
    );
  } finally {
    upload?.dispose();
  }

  if (!content.trim()) {
    return NextResponse.json({ error: "材料内容为空（未提取到文本）" }, { status: 400 });
  }
  if (!title) title = content.trim().slice(0, 20);

  const result = inTransaction(() => {
    const inserted = db
      .prepare(
        "INSERT INTO project_materials (project_id, title, source, filename, content, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(projectId, title, source, filename, content, now());
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), projectId);
    return inserted;
  });
  return NextResponse.json(
    { id: Number(result.lastInsertRowid), title, source, filename, ocr: fileOcr },
    { status: 201 }
  );
}

export const POST = withRouteErrorHandling("POST /api/projects/[id]/materials", handlePost);
