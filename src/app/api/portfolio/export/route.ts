import { NextResponse } from "next/server";
import { assemblePortfolioData, PortfolioError } from "@/lib/portfolio";
import { processPortfolioAnonymization } from "@/lib/portfolio-anonymize";
import { createPortfolioZip } from "@/lib/portfolio-generator";
import { parseApiJson } from "@/lib/api-request";
import { withRouteErrorHandling } from "@/lib/api-route";

const MAX_CONCURRENT_EXPORTS = 2;
let activeExports = 0;

async function handlePost(req: Request) {
  if (req.signal.aborted) return NextResponse.json({ error: "导出已取消" }, { status: 499 });
  if (activeExports >= MAX_CONCURRENT_EXPORTS) {
    return NextResponse.json({ error: "作品集正在打包，请稍后重试" }, { status: 429, headers: { "Retry-After": "1" } });
  }
  activeExports += 1;
  try {
    const parsedBody = await parseApiJson<unknown>(req);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.data;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "请求体格式无效" }, { status: 400 });
    }

    req.signal.throwIfAborted();
    const assembled = assemblePortfolioData(body);
    const safeData = processPortfolioAnonymization(assembled);
    req.signal.throwIfAborted();
    const zipBuffer = await createPortfolioZip(safeData, req.signal);
    req.signal.throwIfAborted();

    const filename = `portfolio-${encodeURIComponent(safeData.candidateName)}-${Date.now()}.zip`;

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(zipBuffer.byteLength),
      },
    });
  } catch (error) {
    if (req.signal.aborted) return NextResponse.json({ error: "导出已取消" }, { status: 499 });
    if (error instanceof PortfolioError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  } finally {
    // 压缩实际结束才归还名额，取消请求不能绕开并发上限。
    activeExports -= 1;
  }
}

export const POST = withRouteErrorHandling("POST /api/portfolio/export", handlePost);
