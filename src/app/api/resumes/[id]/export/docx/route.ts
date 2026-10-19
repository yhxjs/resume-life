import { NextResponse } from "next/server";
import path from "node:path";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseResumeExportRequest, type ResumeExportOptions } from "@/lib/resume-export-request";
import { loadResume } from "@/lib/resumes";
import { resumeToDocx } from "@/lib/resume-docx";
import { guardResumeExport } from "@/lib/resume-export-guard";
import { anonymizeResumeData } from "@/lib/resume-anonymize";
import { isLocalAvatarUrl, type BasicContent } from "@/lib/modules";
import { loadCustomTemplate } from "@/lib/pdf-render";
import { resolveStyle } from "@/lib/templates";
import { readUploadFile, uploadPathFromUrl } from "@/lib/upload-storage";

export const runtime = "nodejs";

async function exportDocx(id: string, options: ResumeExportOptions = {}) {
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  }
  let data = loadResume(numericId);
  if (!data) return NextResponse.json({ error: "简历不存在" }, { status: 404 });

  const blocked = guardResumeExport(data.resume.title, data.modules, options.confirmedIssueIds, options.skipExportCheck, data);
  if (blocked) return blocked;
  if (options.anonymizeConfig) {
    data = anonymizeResumeData(data, options.anonymizeConfig);
    const blockedOutput = guardResumeExport(data.resume.title, data.modules, options.confirmedIssueIds, options.skipExportCheck, data);
    if (blockedOutput) return blockedOutput;
  }

  const customs = data.resume.template.startsWith("custom:")
    ? [loadCustomTemplate(Number(data.resume.template.slice("custom:".length)))] : [];
  const style = resolveStyle(data.resume.template, customs, data.resume.style_overrides);
  const basic = data.modules.find((mod) => mod.type === "basic")?.content as Partial<BasicContent> | undefined;
  const avatarPath = basic?.avatar && isLocalAvatarUrl(basic.avatar) ? uploadPathFromUrl(basic.avatar) : null;
  const avatar = avatarPath ? readUploadFile(path.basename(avatarPath)) : null;
  const buffer = await resumeToDocx(data.resume.title, data.modules, {
    style,
    avatar: avatar?.contentType.startsWith("image/") ? avatar.bytes : undefined,
  });
  const title = data.resume.title.trim() || "简历";
  const filename = /\.docx$/i.test(title) ? title : `${title}.docx`;
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="resume-${numericId}.docx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "no-store",
    },
  });
}

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return exportDocx((await params).id);
}

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = await parseResumeExportRequest(req);
  if (!parsed.ok) return parsed.response;
  return exportDocx((await params).id, parsed.data);
}

export const GET = withRouteErrorHandling("GET /api/resumes/[id]/export/docx", handleGet);
export const POST = withRouteErrorHandling("POST /api/resumes/[id]/export/docx", handlePost);
