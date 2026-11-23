import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import {
  validateGeneratedRemedyResult,
  type PersonaStyle,
  type ScenarioType,
} from "@/lib/career-gap-remedy";
import {
  buildCareerGapRemedyMessages,
  CAREER_GAP_REMEDY_SYSTEM_PROMPT,
} from "@/lib/career-gap-remedy-llm";
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
    .prepare(
      `SELECT id, scenario_type, raw_story, target_role, persona_style, result, created_at FROM resignation_gap_remedies
       ${cursor === null ? "" : "WHERE id < ?"} ORDER BY id DESC LIMIT ?`
    )
    .all(...(cursor === null ? [limit + 1] : [cursor, limit + 1])) as {
    id: number;
    scenario_type: ScenarioType;
    raw_story: string;
    target_role: string;
    persona_style: PersonaStyle;
    result: string;
    created_at: string;
  }[];
  const page = createCursorPage(rows, limit, (row) => String(row.id));
  page.total = (db.prepare("SELECT COUNT(*) AS total FROM resignation_gap_remedies").get() as { total: number }).total;
  return NextResponse.json(page);
}

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  if (!parsedBody.data || typeof parsedBody.data !== "object" || Array.isArray(parsedBody.data)) {
    return NextResponse.json({ error: "沟通方案请求必须是 JSON 对象" }, { status: 400 });
  }
  const body = parsedBody.data as {
    scenarioType?: unknown;
    rawStory?: unknown;
    targetRole?: unknown;
    personaStyle?: unknown;
  };
  for (const field of ["scenarioType", "rawStory", "targetRole", "personaStyle"] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      return NextResponse.json({ error: "沟通场景、原始经历、目标岗位和表达风格必须是字符串" }, { status: 400 });
    }
  }

  const rawStory = typeof body?.rawStory === "string" ? body.rawStory.trim() : "";
  if (!rawStory) {
    return NextResponse.json({ error: "请填写您的真实经历或敏感痛点" }, { status: 400 });
  }

  const rawScenario = typeof body?.scenarioType === "string" ? body.scenarioType : "both";
  const scenarioType: ScenarioType =
    rawScenario === "resignation" || rawScenario === "gap" || rawScenario === "both"
      ? rawScenario
      : "both";

  const targetRole = typeof body?.targetRole === "string" ? body.targetRole.trim() : "";

  const rawStyle = typeof body?.personaStyle === "string" ? body.personaStyle : "pragmatic";
  const personaStyle: PersonaStyle =
    rawStyle === "driven" || rawStyle === "composed" ? rawStyle : "pragmatic";
  let raw: string;
  try {
    raw = await safeChat(
      "parse",
      { feature: LLM_FEATURES.gapRemedyGenerate },
      CAREER_GAP_REMEDY_SYSTEM_PROMPT,
      buildCareerGapRemedyMessages({ scenarioType, targetRole, personaStyle, rawStory }),
      {
        signal: req.signal,
        requireJson: "strict"
      }
    );
  } catch (err) {
    const message =
      err instanceof LlmConfigError
        ? err.message
        : errorMessage(err);
    return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
  }

  let result: ReturnType<typeof validateGeneratedRemedyResult> = null;
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, { script?: unknown }> } | null;
    const scripts = parsed?.scripts;
    if ([scripts?.concise, scripts?.detailed].some((script) => typeof script?.script === "string" && script.script.trim())) {
      result = validateGeneratedRemedyResult(parsed);
    }
  } catch {
    // 无效 JSON 或结构不完整时由下方统一返回 502。
  }
  if (!result) {
    return NextResponse.json(
      { error: "沟通方案解析失败：返回数据格式不符合规范，请稍后重试" },
      { status: 502 }
    );
  }

  const db = getDb();
  const res = inTransaction(() => {
    req.signal.throwIfAborted();
    return db.prepare(
      "INSERT INTO resignation_gap_remedies (scenario_type, raw_story, target_role, persona_style, result, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(scenarioType, rawStory, targetRole, personaStyle, JSON.stringify(result), now());
  });

  return NextResponse.json({ id: Number(res.lastInsertRowid) }, { status: 201 });
}

export const GET = withRouteErrorHandling("GET /api/tools/career-gap-remedies", handleGet);
export const POST = withRouteErrorHandling("POST /api/tools/career-gap-remedies", handlePost);
