import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now } from "@/lib/db";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { normalizeJargonDecoderResult } from "@/lib/jargon-decoder";
import { JARGON_DECODER_SYSTEM_PROMPT } from "@/lib/jargon-decoder-llm";
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
    .prepare(`SELECT id, source_text, result, created_at FROM jargon_decodings
              ${cursor === null ? "" : "WHERE id < ?"} ORDER BY id DESC LIMIT ?`)
    .all(...(cursor === null ? [limit + 1] : [cursor, limit + 1])) as { id: number; source_text: string; result: string; created_at: string }[];
  const page = createCursorPage(rows, limit, (row) => String(row.id));
  page.total = (db.prepare("SELECT COUNT(*) AS total FROM jargon_decodings").get() as { total: number }).total;
  return NextResponse.json(page);
}

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "待解码的 JD 或面试暗号文本不能为空" }, { status: 400 });
  }

  let raw: string;
  try {
    raw = await safeChat(
      "parse",
      { feature: LLM_FEATURES.jargonDecode },
      JARGON_DECODER_SYSTEM_PROMPT,
      [
        {
          role: "user",
          parts: [
            { trust: "untrusted", tag: "source_text_to_decode", text },
            { trust: "trusted", text: "\n\n请启动暗号解码器，对上述文本进行深度穿透分析。" },
          ],
        },
      ],
      { signal: req.signal, requireJson: true }
    );
  } catch (err) {
    const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
    return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
  }

  let result: ReturnType<typeof normalizeJargonDecoderResult> = null;
  try {
    result = normalizeJargonDecoderResult(extractJson<unknown>(raw));
  } catch {
    // 无效 JSON 或结构不完整时由下方统一返回 502。
  }
  if (!result) {
    return NextResponse.json(
      { error: "AI 解码结果异常：未成功识别出暗号或结构不完整，请稍后重试" },
      { status: 502 }
    );
  }

  const db = getDb();
  const res = inTransaction(() => db
    .prepare("INSERT INTO jargon_decodings (source_text, result, created_at) VALUES (?, ?, ?)")
    .run(text, JSON.stringify(result), now()));
  return NextResponse.json({ id: Number(res.lastInsertRowid) }, { status: 201 });
}

export const GET = withRouteErrorHandling("GET /api/tools/jargon-decodings", handleGet);
export const POST = withRouteErrorHandling("POST /api/tools/jargon-decodings", handlePost);
