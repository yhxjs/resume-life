import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { loadResume } from "@/lib/resumes";
import {
  generateResumePdf,
  loadCustomTemplate,
  PdfExportBusyError,
  PdfExportCancelledError,
  PdfExportTimeoutError,
  renderResumeToHtml,
} from "@/lib/pdf-render";
import { anonymizeResumeData, type AnonymizeConfig } from "@/lib/resume-anonymize";
import { parseResumeExportRequest } from "@/lib/resume-export-request";
import { guardResumeExport } from "@/lib/resume-export-guard";

async function exportPdfCore(
  req: Request,
  idParam: string,
  anonymizeConfig?: AnonymizeConfig,
  confirmedIssueIds?: unknown,
  skipExportCheck?: unknown,
) {
  const numericId = Number(idParam);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  }

  let data = loadResume(numericId);
  if (!data) {
    return NextResponse.json({ error: "简历不存在" }, { status: 404 });
  }

  const blocked = guardResumeExport(data.resume.title, data.modules, confirmedIssueIds, skipExportCheck, data);
  if (blocked) return blocked;
  if (anonymizeConfig) {
    data = anonymizeResumeData(data, anonymizeConfig);
    const blockedOutput = guardResumeExport(data.resume.title, data.modules, confirmedIssueIds, skipExportCheck, data);
    if (blockedOutput) return blockedOutput;
  }

  const customs = data.resume.template.startsWith("custom:")
    ? [loadCustomTemplate(Number(data.resume.template.slice("custom:".length)))]
    : [];
  const html = renderResumeToHtml(data, customs);
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generateResumePdf(html, req.signal);
  } catch (error) {
    if (error instanceof PdfExportBusyError) {
      return NextResponse.json({ error: error.message }, { status: 429, headers: { "Retry-After": "5" } });
    }
    if (error instanceof PdfExportTimeoutError) {
      return NextResponse.json({ error: error.message }, { status: 504 });
    }
    if (error instanceof PdfExportCancelledError) {
      return NextResponse.json({ error: error.message }, { status: 499 });
    }
    throw error;
  }

  const rawFilename = (data.resume.title || "简历").trim();
  const safeFilename = encodeURIComponent(rawFilename.endsWith(".pdf") ? rawFilename : `${rawFilename}.pdf`);

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename*=UTF-8''${safeFilename}`,
      "Content-Length": String(pdfBuffer.length),
    },
  });
}

async function handleGet(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return exportPdfCore(req, id);
}

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = await parseResumeExportRequest(req);
  if (!parsed.ok) return parsed.response;
  const { anonymizeConfig, confirmedIssueIds, skipExportCheck } = parsed.data;
  const { id } = await params;
  return exportPdfCore(req, id, anonymizeConfig, confirmedIssueIds, skipExportCheck);
}

export const GET = withRouteErrorHandling("GET /api/resumes/[id]/export/pdf", handleGet);
export const POST = withRouteErrorHandling("POST /api/resumes/[id]/export/pdf", handlePost);
