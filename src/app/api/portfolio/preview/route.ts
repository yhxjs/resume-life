import { NextResponse } from "next/server";
import { assemblePortfolioData, PortfolioError } from "@/lib/portfolio";
import { processPortfolioAnonymization } from "@/lib/portfolio-anonymize";
import { generatePortfolioPreviewHtml, generateStandaloneResumeHtml } from "@/lib/portfolio-generator";
import { assertPortfolioExpandedBytes } from "@/lib/portfolio-export-budget";
import { parseApiJson } from "@/lib/api-request";
import { withRouteErrorHandling } from "@/lib/api-route";

async function handlePost(request: Request) {
  const parsed = await parseApiJson<unknown>(request);
  if (!parsed.ok) return parsed.response;
  try {
    const safeData = processPortfolioAnonymization(assemblePortfolioData(parsed.data));
    const html = generatePortfolioPreviewHtml(safeData);
    const resumeHtml = generateStandaloneResumeHtml(safeData);
    assertPortfolioExpandedBytes(Buffer.byteLength(html) + Buffer.byteLength(resumeHtml));
    return NextResponse.json({ html, resumeHtml });
  } catch (error) {
    if (error instanceof PortfolioError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export const POST = withRouteErrorHandling("POST /api/portfolio/preview", handlePost);
