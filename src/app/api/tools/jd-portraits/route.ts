import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { withRouteErrorHandling } from "@/lib/api-route";
import { PreparationInputError, resolvePreparationApplication, linkPreparationResource } from "@/lib/application-preparation";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now } from "@/lib/db";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { normalizeJdPortrait } from "@/lib/jd-portrait";
import { JD_PORTRAIT_SYSTEM_PROMPT } from "@/lib/jd-portrait-llm";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { createCursorPage, parsePaginationParams } from "@/lib/cursor-pagination";

async function handleGet(req: Request) {
  const searchParams = new URL(req.url).searchParams;
  const pagination = parsePaginationParams(searchParams);
  if (!pagination.ok) return pagination.response;
  const { limit, idCursor: cursor } = pagination;
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, jd, result, created_at FROM jd_portraits
              ${cursor === null ? "" : "WHERE id < ?"} ORDER BY id DESC LIMIT ?`)
    .all(...(cursor === null ? [limit + 1] : [cursor, limit + 1])) as { id: number; jd: string; result: string; created_at: string }[];
  const page = createCursorPage(rows, limit, (row) => String(row.id));
  page.total = (db.prepare("SELECT COUNT(*) AS total FROM jd_portraits").get() as { total: number }).total;
  return NextResponse.json(page);
}

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { jd?: unknown; application_id?: unknown } | null;
  const jd = typeof body?.jd === "string" ? body.jd.trim() : "";
  if (!jd) {
    return NextResponse.json({ error: "岗位要求（JD）不能为空" }, { status: 400 });
  }
  let applicationId: number | null;
  try { applicationId = resolvePreparationApplication(body, { jd }); }
  catch (error) {
    if (error instanceof PreparationInputError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  let raw: string;
  try {
    raw = await safeChat(
      "question",
      { feature: LLM_FEATURES.jdPortraitGenerate },
      JD_PORTRAIT_SYSTEM_PROMPT,
      [
        {
          role: "user",
          parts: [
            { trust: "trusted", text: "【岗位要求（JD）】\n" },
            { trust: "untrusted", tag: "job_description", text: jd },
            { trust: "trusted", text: "\n\n请解析这份 JD，生成考点雷达。" },
          ],
        },
      ],
      { signal: req.signal, requireJson: true }
    );
  } catch (err) {
    const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
    return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
  }

  let result: ReturnType<typeof normalizeJdPortrait> = null;
  try {
    result = normalizeJdPortrait(extractJson<unknown>(raw));
  } catch {
    // 无效 JSON 或结构不完整时由下方统一返回 502。
  }
  if (!result) {
    return NextResponse.json(
      { error: "AI 生成结果异常：必考技能/追问方向/公司风格不齐全，请重试" },
      { status: 502 }
    );
  }

  const db = getDb();
  try {
    return inTransaction(() => {
      if (applicationId !== null) resolvePreparationApplication(body, { jd });
      const saved = db.prepare("INSERT INTO jd_portraits (jd, result, created_at) VALUES (?, ?, ?)").run(jd, JSON.stringify(result), now());
      const id = Number(saved.lastInsertRowid);
      if (applicationId !== null) linkPreparationResource(applicationId, "portrait", id);
      return NextResponse.json({ id }, { status: 201 });
    });
  } catch (error) {
    if (error instanceof PreparationInputError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export const GET = withRouteErrorHandling("GET /api/tools/jd-portraits", handleGet);
export const POST = withRouteErrorHandling("POST /api/tools/jd-portraits", handlePost);
