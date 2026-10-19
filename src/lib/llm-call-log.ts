import { getDb, inTransaction } from "./db";
import { resolveEntityLabel } from "./llm-entity-label";
import { logServerEvent } from "./server-errors";
import { LLM_FEATURES, type LlmFeature, type LlmSource, type LlmUsage } from "./llm-source";
import type { ApiFormat } from "./settings-constants";
import type { LlmTask } from "./llm";
import { createCursorPage, type CursorPage } from "./cursor-pagination";

export type LlmCallRecord = {
  source: LlmSource;
  task: LlmTask;
  model: string;
  apiFormat: ApiFormat;
  status: "ok" | "failed" | "cancelled";
  errorCode: string;
  attempts: number;
  durationMs: number;
  usage: LlmUsage;
};

/** 调用日志保留窗口：更早的记录会被清理，避免主库与备份体积随使用年限无限增长 */
export const LLM_CALL_LOG_RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
let lastPrunedDay = "";

/**
 * 每天首次写入前清理过期日志。刻意不放在启动钩子里：启动阶段不应无谓地打开数据库
 * （构建追踪要求启动时不碰数据目录），而计量路径上数据库本来就已打开。
 */
function pruneExpiredLlmCalls(now: Date): void {
  const day = now.toISOString().slice(0, 10);
  if (lastPrunedDay === day) return;
  const cutoff = new Date(now.getTime() - LLM_CALL_LOG_RETENTION_DAYS * DAY_MS).toISOString();
  const removed = inTransaction(() => getDb().prepare("DELETE FROM llm_call_logs WHERE created_at < ?").run(cutoff).changes);
  lastPrunedDay = day;
  if (removed > 0) {
    logServerEvent("info", "llm.metering.pruned", {
      context: { removed, retentionDays: LLM_CALL_LOG_RETENTION_DAYS },
    });
  }
}

/**
 * 同步写库：解析实体标题快照 → 插入一行。
 * 两步包在同一个 try/catch 内 —— 调用方在 LLM 调用路径上，计量失败绝不能影响业务。
 * 清理过期日志单独兜错：清理失败只记告警，不能反过来影响本次计量。
 */
export function recordLlmCall(record: LlmCallRecord): void {
  try {
    inTransaction(() => {
      const { source, usage } = record;
      const entity = source.entity;
      const entityLabel = entity ? resolveEntityLabel(entity.type, entity.id) : "";
      getDb()
        .prepare(
          `INSERT INTO llm_call_logs (
             created_at, feature, entity_type, entity_id, entity_label,
             task, model, api_format, status, error_code, attempts, duration_ms,
             input_tokens, output_tokens, cached_tokens
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          new Date().toISOString(),
          source.feature,
          entity?.type ?? "",
          entity?.id ?? null,
          entityLabel,
          record.task,
          record.model,
          record.apiFormat,
          record.status,
          record.errorCode,
          record.attempts,
          record.durationMs,
          usage.inputTokens,
          usage.outputTokens,
          usage.cachedTokens
        );
    });
  } catch {
    logServerEvent("warn", "llm.metering.failed", { context: { resource: "llm_call_logs" } });
    return;
  }
  try {
    pruneExpiredLlmCalls(new Date());
  } catch {
    logServerEvent("warn", "llm.metering.pruneFailed", { context: { resource: "llm_call_logs" } });
  }
}

export type LlmDailyUsage = {
  date: string;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
};

export type LlmFeatureUsage = {
  feature: string;
  calls: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
};

export type LlmModelUsage = {
  model: string;
  calls: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
};

export type LlmUsageSummary = {
  calls: number;
  failed: number;
  cancelled: number;
  /** 所有调用累计的重试次数（含网络重试与 JSON 校验重试），来自 attempts 列求和 */
  retries: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  usageReportedCalls: number;
  cacheReportedCalls: number;
  /** 每日调用趋势 */
  daily: LlmDailyUsage[];
  /** 功能来源分布 */
  byFeature: LlmFeatureUsage[];
  /** 模型调用分布 */
  byModel: LlmModelUsage[];
};

export type LlmCallRow = {
  id: number;
  createdAt: string;
  feature: string;
  entityType: string;
  entityId: number | null;
  entityLabel: string;
  task: string;
  model: string;
  status: "ok" | "failed" | "cancelled";
  errorCode: string;
  attempts: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
};

export type LlmUsageRange = { from: string | null; to: string | null };

export class InvalidUsageRangeError extends Error {}

/** 未指定时区的脚本客户端保持 UTC 语义；浏览器显式传入本地 IANA 时区。 */
export function parseUsageTimeZone(raw: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: raw || "UTC" }).resolvedOptions().timeZone;
  } catch {
    throw new InvalidUsageRangeError("timeZone 参数必须是有效时区");
  }
}

function usageDateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, calendar: "iso8601", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
}

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FEATURE_VALUES = new Set<string>(Object.values(LLM_FEATURES));

export function parseFeature(raw: string | null): LlmFeature | null {
  if (raw === null || raw === "") return null;
  if (!FEATURE_VALUES.has(raw)) throw new InvalidUsageRangeError("feature 参数无效");
  return raw as LlmFeature;
}

/** 严格校验 from / to。区间语义为左闭右开 [from, to)，字符串比较即可（格式定长）。 */
export function parseIsoRange(searchParams: URLSearchParams): LlmUsageRange {
  const read = (key: "from" | "to"): string | null => {
    const raw = searchParams.get(key);
    if (raw === null || raw === "") return null;
    if (!ISO_UTC_PATTERN.test(raw) || !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString() !== raw) {
      throw new InvalidUsageRangeError(`${key} 参数必须是 ISO 8601 UTC 时间`);
    }
    return raw;
  };
  const from = read("from");
  const to = read("to");
  if (from !== null && to !== null && from >= to) {
    throw new InvalidUsageRangeError("from 必须早于 to");
  }
  return { from, to };
}

function rangeClause(range: LlmUsageRange, binds: (string | number)[]): string[] {
  const where: string[] = [];
  if (range.from !== null) { where.push("created_at >= ?"); binds.push(range.from); }
  if (range.to !== null) { where.push("created_at < ?"); binds.push(range.to); }
  return where;
}

export function fillDailySequence(
  rows: LlmDailyUsage[],
  range: LlmUsageRange,
  timeZone = "UTC"
): LlmDailyUsage[] {
  const map = new Map<string, LlmDailyUsage>();
  for (const row of rows) {
    map.set(row.date, row);
  }

  const formatter = usageDateFormatter(timeZone);
  let startDateStr = range.from ? formatter.format(new Date(range.from)) : "";
  // [from, to) 的最后一毫秒决定末日，兼容非午夜端点和夏令时。
  let endDateStr = range.to ? formatter.format(new Date(Date.parse(range.to) - 1)) : "";

  if (!startDateStr || !endDateStr) {
    if (rows.length === 0) return [];
    if (!startDateStr) startDateStr = rows[0]?.date ?? "";
    if (!endDateStr) endDateStr = rows[rows.length - 1]?.date ?? "";
  }
  if (!startDateStr || !endDateStr) return [];

  // 这里只迭代日期标签，UTC 运算不会受到 DST 当日 23/25 小时的影响。
  const cur = new Date(`${startDateStr}T00:00:00.000Z`);
  const end = new Date(`${endDateStr}T00:00:00.000Z`);
  if ((end.getTime() - cur.getTime()) / DAY_MS + 1 > 3660) {
    throw new InvalidUsageRangeError("每日趋势最多查询 3660 天，请缩小日期范围");
  }

  const result: LlmDailyUsage[] = [];
  while (cur <= end) {
    const dateStr = cur.toISOString().slice(0, 10);

    const existing = map.get(dateStr);
    if (existing) {
      result.push(existing);
    } else {
      result.push({
        date: dateStr,
        calls: 0,
        failed: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
      });
    }

    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return result;
}

export function summarizeLlmUsage(params: LlmUsageRange & { feature?: LlmFeature | null; timeZone?: string }): LlmUsageSummary {
  const timeZone = parseUsageTimeZone(params.timeZone ?? null);
  const binds: (string | number)[] = [];
  const where = rangeClause(params, binds);
  if (params.feature) {
    where.push("feature = ?");
    binds.push(params.feature);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const db = getDb();
  const formatter = usageDateFormatter(timeZone);
  // SQLite 仅返回聚合行，不把全量日志读入 JS；查询同步执行，函数不会跨请求交错。
  db.function("llm_usage_date", { deterministic: true }, (createdAt) => {
    return formatter.format(new Date(String(createdAt)));
  });

  const total = db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'ok')        AS calls,
         COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
         COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
         COALESCE(SUM(attempts), 0)                   AS retries,
         COALESCE(SUM(input_tokens), 0)               AS inputTokens,
         COALESCE(SUM(output_tokens), 0)              AS outputTokens,
         COALESCE(SUM(cached_tokens), 0)              AS cachedTokens,
         COUNT(input_tokens)                          AS usageReportedCalls,
         COUNT(cached_tokens)                         AS cacheReportedCalls
       FROM llm_call_logs
       ${whereSql}`
    )
    .get(...binds) as Omit<LlmUsageSummary, "daily" | "byFeature" | "byModel">;

  const dailyRaw = db
    .prepare(
      `SELECT
         llm_usage_date(created_at)                  AS date,
         COUNT(*) FILTER (WHERE status = 'ok')        AS calls,
         COUNT(*) FILTER (WHERE status != 'ok')       AS failed,
         COALESCE(SUM(input_tokens), 0)               AS inputTokens,
         COALESCE(SUM(output_tokens), 0)              AS outputTokens,
         COALESCE(SUM(cached_tokens), 0)              AS cachedTokens
       FROM llm_call_logs
       ${whereSql}
       GROUP BY llm_usage_date(created_at)
       ORDER BY date ASC`
    )
    .all(...binds) as LlmDailyUsage[];

  const byFeature = db
    .prepare(
      `SELECT
         feature,
         COUNT(*) FILTER (WHERE status = 'ok')        AS calls,
         COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS tokens,
         COALESCE(SUM(input_tokens), 0)               AS inputTokens,
         COALESCE(SUM(output_tokens), 0)              AS outputTokens
       FROM llm_call_logs
       ${whereSql}
       GROUP BY feature
       ORDER BY tokens DESC, calls DESC`
    )
    .all(...binds) as LlmFeatureUsage[];

  const byModel = db
    .prepare(
      `SELECT
         model,
         COUNT(*) FILTER (WHERE status = 'ok')        AS calls,
         COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS tokens,
         COALESCE(SUM(input_tokens), 0)               AS inputTokens,
         COALESCE(SUM(output_tokens), 0)              AS outputTokens
       FROM llm_call_logs
       ${whereSql}
       GROUP BY model
       ORDER BY tokens DESC, calls DESC`
    )
    .all(...binds) as LlmModelUsage[];

  const daily = fillDailySequence(dailyRaw, params, timeZone);

  return {
    ...total,
    daily,
    byFeature,
    byModel,
  };
}

/** 按 id 倒序分页：自增主键与写入时刻同序，游标即 id，保证不漏不重。 */
export function listLlmCalls(params: {
  from: string | null;
  to: string | null;
  feature: LlmFeature | null;
  limit: number;
  cursor: number | null;
}): CursorPage<LlmCallRow> {
  const binds: (string | number)[] = [];
  const where = rangeClause(params, binds);
  if (params.feature !== null) { where.push("feature = ?"); binds.push(params.feature); }
  if (params.cursor !== null) { where.push("id < ?"); binds.push(params.cursor); }

  const rows = getDb()
    .prepare(
      `SELECT
         id, created_at AS createdAt, feature,
         entity_type AS entityType, entity_id AS entityId, entity_label AS entityLabel,
         task, model, status, error_code AS errorCode, attempts, duration_ms AS durationMs,
         input_tokens AS inputTokens, output_tokens AS outputTokens, cached_tokens AS cachedTokens
       FROM llm_call_logs
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(...binds, params.limit + 1) as LlmCallRow[];

  return createCursorPage(rows, params.limit, (row) => String(row.id));
}
