import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { withRouteErrorHandling } from "@/lib/api-route";
import { MultipartFormatError, parseMultipartUpload } from "@/lib/streaming-multipart";
import { RequestFormatError, RequestTooLargeError } from "@/lib/request-limits";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { getDb, inTransaction } from "@/lib/db";
import { saveUploadFile, sweepOrphanUploads } from "@/lib/upload-storage";

/** 头像上限比通用上传更严：证件照经前端裁剪后约 450×600，5MB 足够且能拦住原图误传 */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** 服务端兜底降采样上限：略大于前端裁剪尺寸，足以覆盖正常证件照 */
const MAX_AVATAR_WIDTH = 600;
const MAX_AVATAR_HEIGHT = 800;

/**
 * 校验文件二进制魔数，支持 PNG / JPEG / WEBP，防止恶意重命名绕过扩展名检测
 */
function detectImageExtension(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return ".png";
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return ".jpg";
  }
  // WEBP: RIFF + WEBP
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return ".webp";
  }
  return null;
}

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
    const ext = detectImageExtension(bytes);
    if (!ext) {
      return NextResponse.json(
        { error: "不支持的图片格式，仅支持 PNG、JPG、JPEG、WEBP" },
        { status: 400 }
      );
    }

    // 服务端兜底降采样：绕过前端裁剪直接上传的大图（如 API 调试）此后会在每次
    // PDF 导出与备份中原样搬运。保持原格式只改尺寸，魔数检测结论不受影响。
    let normalized: Buffer;
    try {
      normalized = await sharp(bytes)
        .rotate()
        .resize(MAX_AVATAR_WIDTH, MAX_AVATAR_HEIGHT, { fit: "inside", withoutEnlargement: true })
        .toBuffer();
    } catch {
      return NextResponse.json({ error: "图片解析失败，请更换图片后重试" }, { status: 400 });
    }

    const { url } = await saveUploadFile(normalized, ext);
    inTransaction(() => sweepOrphanUploads(getDb()));
    return NextResponse.json({ url });
  } finally {
    upload.dispose();
  }
}

export const POST = withRouteErrorHandling("POST /api/upload", handlePost);
