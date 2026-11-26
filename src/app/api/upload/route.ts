import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { normalizeAvatar, AvatarInputError, MAX_AVATAR_BYTES } from "@/lib/avatar-upload";
import { withRouteErrorHandling } from "@/lib/api-route";
import { MultipartFormatError, parseMultipartUpload } from "@/lib/streaming-multipart";
import { RequestFormatError, RequestTooLargeError } from "@/lib/request-limits";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { getDb, inTransaction } from "@/lib/db";
import { saveUploadFile, sweepOrphanUploads } from "@/lib/upload-storage";

async function handlePost(request: Request) {
  // 经 parseMultipartUpload 而非 request.formData()：后者没有体积上限，
  // 超限时由 Next 的请求体缓冲静默截断，截断后的 multipart 解析失败，
  // 最终被错误包装兜成 500「服务器内部错误」——把用户可自行解决的「图片过大」
  // 伪装成需要排障的服务故障。
  let upload: Awaited<ReturnType<typeof parseMultipartUpload>> | undefined;
  try {
    upload = await parseMultipartUpload(request);
  } catch (err) {
    if (err instanceof RequestTooLargeError) {
      return NextResponse.json({ error: "请求体过大" }, { status: 413 });
    }
    if (err instanceof RequestFormatError || err instanceof MultipartFormatError) {
      return NextResponse.json({ error: "请求格式无效" }, { status: 400 });
    }
    const requestId = logServerError("POST /api/upload", err, {
      requestId: requestIdFrom(request),
      status: 500,
    });
    return NextResponse.json({ error: "服务器内部错误，请稍后重试", requestId }, { status: 500 });
  }

  try {
    const file = upload.file;
    if (!file) {
      return NextResponse.json({ error: "请选择需要上传的头像图片" }, { status: 400 });
    }
    if (file.bytes > MAX_AVATAR_BYTES) {
      return NextResponse.json({ error: "图片过大，头像大小不能超过 5MB" }, { status: 413 });
    }

    const bytes = await fs.readFile(file.path);
    let avatar: Awaited<ReturnType<typeof normalizeAvatar>>;
    try { avatar = await normalizeAvatar(bytes); }
    catch (error) {
      if (error instanceof AvatarInputError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
    const { url } = await saveUploadFile(avatar.bytes, avatar.extension);
    inTransaction(() => sweepOrphanUploads(getDb()));
    return NextResponse.json({ url });
  } finally {
    upload.dispose();
  }
}

export const POST = withRouteErrorHandling("POST /api/upload", handlePost);
