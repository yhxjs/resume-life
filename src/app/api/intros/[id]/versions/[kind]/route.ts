import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { isIntroKind, validateIntroSentences } from "@/lib/intro";
import { saveIntroVersion } from "@/lib/intro-versions";

/** 保存用户编辑后的整组句子（被编辑句的点评由前端置空，待重新点评） */
async function handlePatch(req: Request, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const { id, kind } = await params;
  const introId = parseCanonicalPositiveId(id);
  if (!Number.isSafeInteger(introId) || introId <= 0) {
    return NextResponse.json({ error: "无效的记录 ID" }, { status: 400 });
  }
  if (!isIntroKind(kind)) {
    return NextResponse.json({ error: "无效的版本" }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { sentences?: unknown; baseRevision?: unknown } | null;
  if (typeof body?.baseRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.baseRevision)) {
    return NextResponse.json({ error: "缺少有效版本修订，请刷新后重试" }, { status: 400 });
  }
  const validated = validateIntroSentences(body?.sentences);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const { sentences } = validated;

  const result = saveIntroVersion(introId, kind, body.baseRevision, sentences);
  if (result.status === 422) {
    return NextResponse.json({ error: "当前版本原稿数据异常，已保留全部原始数据；请检查原稿或确认重新构思本版后再编辑" }, { status: 422 });
  }
  if (result.status !== 200) {
    return NextResponse.json({ error: result.status === 409 ? "内容已更新或数据已恢复，请获取最新版本后重新保存；当前草稿已保留" : "版本不存在" }, { status: result.status });
  }
  return NextResponse.json({ kind, sentences, revision: result.revision });
}

export const PATCH = withRouteErrorHandling("PATCH /api/intros/[id]/versions/[kind]", handlePatch);
