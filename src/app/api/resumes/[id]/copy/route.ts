import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { copyResume } from "@/lib/resume-creation";

/** 复制简历：标题加「（副本）」后缀，模板与全部模块（含自定义模块及顺序）原样复制 */
async function handlePost(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  }
  const copied = copyResume(numericId);
  if (!copied) return NextResponse.json({ error: "简历不存在" }, { status: 404 });
  return NextResponse.json(copied, { status: 201 });
}

export const POST = withRouteErrorHandling("POST /api/resumes/[id]/copy", handlePost);
