import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { loadResume } from "@/lib/resumes";
import { resumeToMarkdown } from "@/lib/resume-markdown";
import { anonymizeResumeData } from "@/lib/resume-anonymize";
import { parseResumeExportRequest } from "@/lib/resume-export-request";
import { guardResumeExport } from "@/lib/resume-export-guard";

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  }
  const data = loadResume(numericId);
  if (!data) return NextResponse.json({ error: "简历不存在" }, { status: 404 });
  const blocked = guardResumeExport(data.resume.title, data.modules, undefined, undefined, data);
  if (blocked) return blocked;
  const markdown = resumeToMarkdown(data.resume.title, data.modules);
  const rawTitle = (data.resume.title || "简历").trim();
  const rawFilename = rawTitle.endsWith(".md") ? rawTitle : `${rawTitle}.md`;
  const safeFilename = encodeURIComponent(rawFilename);
  const fallbackFilename = `resume-${data.resume.id}.md`;
  return new NextResponse(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fallbackFilename}"; filename*=UTF-8''${safeFilename}`,
    },
  });
}

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = await parseResumeExportRequest(req);
  if (!parsed.ok) return parsed.response;
  const { anonymizeConfig, confirmedIssueIds, skipExportCheck } = parsed.data;
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  }
  let data = loadResume(numericId);
  if (!data) return NextResponse.json({ error: "简历不存在" }, { status: 404 });

  const blocked = guardResumeExport(data.resume.title, data.modules, confirmedIssueIds, skipExportCheck, data);
  if (blocked) return blocked;
  if (anonymizeConfig) {
    data = anonymizeResumeData(data, anonymizeConfig);
    const blockedOutput = guardResumeExport(data.resume.title, data.modules, confirmedIssueIds, skipExportCheck, data);
    if (blockedOutput) return blockedOutput;
  }

  const markdown = resumeToMarkdown(data.resume.title, data.modules);
  const rawTitle = (data.resume.title || "简历").trim();
  const rawFilename = rawTitle.endsWith(".md") ? rawTitle : `${rawTitle}.md`;
  const safeFilename = encodeURIComponent(rawFilename);
  const fallbackFilename = `resume-${data.resume.id}.md`;
  return new NextResponse(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fallbackFilename}"; filename*=UTF-8''${safeFilename}`,
    },
  });
}

export const GET = withRouteErrorHandling("GET /api/resumes/[id]/export", handleGet);
export const POST = withRouteErrorHandling("POST /api/resumes/[id]/export", handlePost);
