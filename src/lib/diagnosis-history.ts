import { getDb, inTransaction } from "@/lib/db";
import { linkPreparationResource } from "@/lib/application-preparation";
import { assertBackupRecordBytes } from "@/lib/backup-limits";
import { isStoredDiagnosisReport, isStoredDiagnosisSnapshot, isStoredDiagnosisAdoptions } from "@/lib/backup-domain";
import type { DiagnosisHistoryItem, DiagnosisHistoryResponse, DiagnosisRecord } from "@/lib/diagnosis";

type StoredDiagnosis = Omit<DiagnosisRecord, "report" | "resume_snapshot" | "adoptions"> & {
  report: string; resume_snapshot: string; adoptions: string;
};

/** 只核对记录指向及值类型，不比较模型草稿与用户手动写入内容。 */
function adoptionsMatchReport(report: NonNullable<DiagnosisRecord["report"]>, adoptions: DiagnosisRecord["adoptions"]): boolean {
  const seen = new Set<string>();
  for (const adoption of adoptions) {
    const modules = report.modules.filter((module) => module.moduleKey === adoption.moduleKey);
    if (modules.length !== 1) return false;
    const suggestion = modules[0]!.suggestions[adoption.suggestionIndex];
    if (!suggestion) return false;
    // 历史技能记录允许换行字符串；正文采纳值始终为富文本字符串。
    if (suggestion.field !== "items" && typeof adoption.value !== "string") return false;
    const key = JSON.stringify([adoption.moduleKey, adoption.suggestionIndex]);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** 快照和采纳内容必须能完整进入备份容器，避免保存后无法导出。 */
export function assertDiagnosisBudget(row: Record<string, unknown>): void {
  assertBackupRecordBytes(Buffer.byteLength(JSON.stringify({ kind: "row", table: "resume_diagnoses", data: row }), "utf8"));
}

/** 诊断归档保留完整原文；可用于模型的职业材料不等于可回看、备份的完整快照。 */
export function canArchiveDiagnosisSnapshot(value: unknown): boolean {
  return isStoredDiagnosisSnapshot(value);
}

function decode(row: StoredDiagnosis): DiagnosisRecord {
  const corruptedFields: NonNullable<DiagnosisRecord["corruptedFields"]> = [];
  function read<T>(field: typeof corruptedFields[number], check: (value: unknown) => boolean, fallback: T): T {
    try {
      const parsed: unknown = JSON.parse(row[field]);
      if (check(parsed)) return parsed as T;
    } catch { /* 损坏记录仍保留入口，原数据不做修补或覆盖。 */ }
    corruptedFields.push(field);
    return fallback;
  }
  const report = read<DiagnosisRecord["report"]>("report", isStoredDiagnosisReport, null);
  const resume_snapshot = read<DiagnosisRecord["resume_snapshot"]>("resume_snapshot", isStoredDiagnosisSnapshot, { title: "", modules: [] });
  const adoptions = read<DiagnosisRecord["adoptions"]>("adoptions", isStoredDiagnosisAdoptions, []);
  if (report && !corruptedFields.includes("adoptions") && !adoptionsMatchReport(report, adoptions)) {
    corruptedFields.push("adoptions");
  }
  return { ...row, report: corruptedFields.length ? null : report, resume_snapshot, adoptions,
    ...(corruptedFields.length ? { corruptedFields } : {}),
  };
}

export function loadDiagnosis(resumeId: number, diagnosisId: number, preserveInvalid = false): DiagnosisRecord | null {
  const row = getDb().prepare("SELECT * FROM resume_diagnoses WHERE resume_id = ? AND id = ?")
    .get(resumeId, diagnosisId) as StoredDiagnosis | undefined;
  if (!row) return null;
  const value = decode(row);
  return { ...value, ...(preserveInvalid && value.corruptedFields?.length
    ? { raw_fields: { report: row.report, ...Object.fromEntries(value.corruptedFields.map(field => [field, row[field]])) } } : {}) };
}

/** 投递内沿用同一岗位的诊断历史；只在没有投递上下文时按 JD 匹配。 */
export function findMatchingDiagnosisJob(resumeId: number, jd: string, applicationId: number | null) {
  return getDb().prepare(`SELECT job_id, job_title FROM resume_diagnoses d WHERE resume_id = ? AND
    ${applicationId === null ? "jd = ?" : "EXISTS (SELECT 1 FROM application_preparation_resources p WHERE p.application_id = ? AND p.diagnosis_id = d.id)"}
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(resumeId, applicationId ?? jd) as Pick<DiagnosisRecord, "job_id" | "job_title"> | undefined;
}

type NewDiagnosis = Pick<StoredDiagnosis, "job_id" | "job_title" | "jd" | "report" | "resume_snapshot" | "created_at"> & {
  resume_id: number; resume_version_id: number;
};

export function saveDiagnosis(row: NewDiagnosis, applicationId: number | null): number {
  return inTransaction(() => {
    const saved = getDb().prepare(`INSERT INTO resume_diagnoses (resume_id, resume_version_id, job_id, job_title, jd, report, resume_snapshot, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.resume_id, row.resume_version_id, row.job_id, row.job_title, row.jd, row.report, row.resume_snapshot, row.created_at);
    const id = Number(saved.lastInsertRowid);
    if (applicationId !== null) linkPreparationResource(applicationId, "diagnosis", id);
    return id;
  });
}

/** 列表仅取轻量元信息；完整快照只加载选中版本和同岗位上一次版本。 */
export function diagnosisHistory(resumeId: number, current: DiagnosisRecord | null): DiagnosisHistoryResponse {
  const db = getDb();
  const history = db.prepare(`SELECT id, job_id, job_title,
      created_at, CASE WHEN json_valid(report) THEN
        CASE WHEN json_type(report, '$.match') IN ('integer', 'real')
          AND json_extract(report, '$.match') BETWEEN 0 AND 10
          THEN json_extract(report, '$.match') END
        END AS match
    FROM resume_diagnoses WHERE resume_id = ? ORDER BY created_at DESC, id DESC`).all(resumeId) as DiagnosisHistoryItem[];
  const previous = current ? db.prepare(`SELECT * FROM resume_diagnoses
    WHERE resume_id = ? AND job_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(resumeId, current.job_id, current.created_at, current.created_at, current.id) as StoredDiagnosis | undefined : undefined;
  return { current, previous: previous ? decode(previous) : null, history };
}
