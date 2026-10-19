import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { getDb } from "@/lib/db";
import { hasReferencedUploadFilename, readUploadFile } from "@/lib/upload-storage";

async function handleGet(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!hasReferencedUploadFilename(getDb(), name)) {
    return NextResponse.json({ error: "头像不存在" }, { status: 404 });
  }
  const file = readUploadFile(name);
  if (!file) return NextResponse.json({ error: "头像不存在" }, { status: 404 });
  const body = new ArrayBuffer(file.bytes.byteLength);
  new Uint8Array(body).set(file.bytes);
  return new Response(body, {
    headers: {
      "Content-Type": file.contentType,
      // 备份恢复可能覆盖同名头像，且删除引用后不应继续命中浏览器缓存。
      "Cache-Control": "private, no-store",
      "Content-Length": String(file.bytes.byteLength),
    },
  });
}

export const GET = withRouteErrorHandling("GET /api/uploads/[name]", handleGet);
