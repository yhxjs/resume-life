import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { logServerError, requestIdFrom, type DiagnosticStage } from "@/lib/server-errors";
import { assertStorageWritable, getDb } from "@/lib/db";
import { inspectRestoreStaging } from "@/lib/backup-staging-cleanup";

async function handleGet(request?: Request) {
  const startedAt = Date.now();
  let stage: DiagnosticStage = "database-open";
  try {
    const db = getDb();
    stage = "database-query";
    const row = db.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
    if (row?.ok !== 1) {
      throw new Error("数据库响应异常");
    }
    stage = "database-version";
    const versionRow = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;

    // 只验证「能连上」会漏掉只读目录、磁盘写满、WAL 退化这三类真实故障
    stage = "database-wal";
    const modeRow = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
    const journalMode = (modeRow?.journal_mode ?? "").toLowerCase();
    if (journalMode !== "wal") {
      throw new Error("数据库未处于 WAL 模式");
    }
    stage = "storage-write";
    assertStorageWritable();
    stage = "restore-staging";
    const restoreStaging = inspectRestoreStaging();

    return NextResponse.json({
      status: "ok",
      uptimeSeconds: process.uptime(),
      db: {
        status: "connected",
        version: versionRow?.user_version ?? 0,
        journalMode,
        storageWritable: true,
      },
      restoreStaging,
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const requestId = logServerError("health.database", err, { requestId: requestIdFrom(request), status: 503, stage });
    return NextResponse.json(
      {
        status: "error",
        message: "数据库健康检查失败",
        timestamp: new Date().toISOString(),
        requestId,
      },
      { status: 503 }
    );
  }
}

// 健康检查供容器探活等无凭证调用方使用，显式豁免会话鉴权
export const GET = withRouteErrorHandling("GET /api/health", handleGet, { public: true, databaseProbe: true });
