import { getDb } from "@/lib/db";
import { assertBackupRecordBytes } from "@/lib/backup-limits";
import type { DiagnosisHistoryItem, DiagnosisHistoryResponse, DiagnosisRecord } from "@/lib/diagnosis";

type StoredDiagnosis = Omit<DiagnosisRecord, "report" | "resume_snapshot" | "adoptions"> & {
  report: string; resume_snapshot: string; adoptions: string;
};

/** 快照和采纳内容必须能完整进入备份容器，避免保存后无法导出。 */
export function assertDiagnosisBudget(row: Record<string, unknown>): void {
  assertBackupRecordBytes(Buffer.byteLength(JSON.stringify({ kind: "row", table: "resume_diagnoses", data: row }), "utf8"));
}

function decode(row: StoredDiagnosis): DiagnosisRecord {
  let report: DiagnosisRecord["report"] = null;
  try { report = JSON.parse(row.report); } catch { /* 损坏报告仍保留记录入口。 */ }
  return { ...row, report,
    resume_snapshot: JSON.parse(row.resume_snapshot),
    adoptions: JSON.parse(row.adoptions),
  };
}

export function loadDiagnosis(resumeId: number, diagnosisId: number): DiagnosisRecord | null {
  const row = getDb().prepare("SELECT * FROM resume_diagnoses WHERE resume_id = ? AND id = ?")
    .get(resumeId, diagnosisId) as StoredDiagnosis | undefined;
  return row ? decode(row) : null;
}

/** 列表仅取轻量元信息；完整快照只加载选中版本和同岗位上一次版本。 */
export function diagnosisHistory(resumeId: number, current: DiagnosisRecord | null): DiagnosisHistoryResponse {
  const db = getDb();
  const history = db.prepare(`SELECT id, job_id, job_title,
      created_at, CASE WHEN json_valid(report) THEN json_extract(report, '$.match') ELSE NULL END AS match
    FROM resume_diagnoses WHERE resume_id = ? ORDER BY created_at DESC, id DESC`).all(resumeId) as DiagnosisHistoryItem[];
  const previous = current ? db.prepare(`SELECT * FROM resume_diagnoses
    WHERE resume_id = ? AND job_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(resumeId, current.job_id, current.created_at, current.created_at, current.id) as StoredDiagnosis | undefined : undefined;
  return { current, previous: previous ? decode(previous) : null, history };
}
