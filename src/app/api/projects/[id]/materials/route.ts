import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { loadProjectRow } from "@/lib/projects";
import { createProjectMaterial } from "@/lib/project-materials";
import type { DocumentTableProvenance } from "@/lib/document-table-provenance";
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
  const projectId = parseCanonicalPositiveId(id);
  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: "无效的项目 ID" }, { status: 400 });
  }
  if (!loadProjectRow(projectId)) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const isMultipart = isMultipartFormDataRequest(req);
  let title = "";
  let content = "";
  let source: "paste" | "file" = "paste";
  let filename = "";
  let tableProvenance: DocumentTableProvenance | undefined;
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
      tableProvenance = extracted.tableProvenance;
      fileOcr = extracted.ocr;
      title = upload.fields.title?.trim() ?? "";
      if (!title) title = filename;
    } else {
      const body = await readJsonBody<{
        title?: unknown;
        content?: unknown;
        tableProvenance?: unknown;
        provenance?: unknown;
      } | null>(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return NextResponse.json({ error: "项目材料请求必须是 JSON 对象" }, { status: 400 });
      }
      if (Object.hasOwn(body, "tableProvenance") || Object.hasOwn(body, "provenance")) {
        return NextResponse.json({ error: "材料结构来源只能由文件提取生成" }, { status: 400 });
      }
      if ((body.title !== undefined && typeof body.title !== "string") ||
        (body.content !== undefined && typeof body.content !== "string")) {
        return NextResponse.json({ error: "材料标题和正文必须是字符串" }, { status: 400 });
      }
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

  const materialId = createProjectMaterial(projectId, { title, source, filename, content, tableProvenance });
  if (materialId === null) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  return NextResponse.json(
    { id: materialId, title, source, filename, ocr: fileOcr },
    { status: 201 }
  );
}

export const POST = withRouteErrorHandling("POST /api/projects/[id]/materials", handlePost);
