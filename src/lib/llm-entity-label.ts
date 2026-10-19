import { getDb } from "./db";
import type { EntityType } from "./llm-source";

/** 标签上限长度，防止超长 JD 之类的内容把日志撑爆 */
const MAX_LABEL_LENGTH = 120;

/**
 * 实体类型 → 取标题的 SQL。每条 SQL 只返回一列，别名统一为 label。
 * 值为 null 表示该实体没有可读标题，日志里回退显示「类型 #id」。
 */
const LABEL_SQL: Record<EntityType, string | null> = {
  resume: "SELECT title AS label FROM resumes WHERE id = ?",
  project: "SELECT name AS label FROM projects WHERE id = ?",
  template: "SELECT name AS label FROM resume_templates WHERE id = ?",
  defense: "SELECT title AS label FROM resume_defenses WHERE id = ?",
  negotiation: "SELECT target_role AS label FROM salary_negotiations WHERE id = ?",
  bank_entry: "SELECT direction AS label FROM bank_entries WHERE id = ?",
  interview: `SELECT CASE WHEN i.round_no > 0
      THEN r.title || ' 第' || i.round_no || '轮'
      ELSE r.title END AS label
    FROM interviews i JOIN resumes r ON r.id = i.resume_id
    WHERE i.id = ?`,
  interview_series: `SELECT r.title AS label FROM interview_series s
    JOIN resumes r ON r.id = s.resume_id WHERE s.id = ?`,
  intro: `SELECT r.title AS label FROM intros t
    JOIN resumes r ON r.id = t.resume_id WHERE t.id = ?`,
  drill: `SELECT COALESCE(NULLIF(p.name, ''), d.direction) AS label
    FROM drills d LEFT JOIN projects p ON p.id = d.project_id
    WHERE d.id = ?`,
  jd_portrait: null,
  jargon_decoding: null,
  gap_remedy: null,
};

/**
 * 解析实体标题快照。解析失败、实体已删除、或该类型无标题时返回空串。
 * 绝不抛出：调用方在 LLM 调用路径上，计量问题不能影响业务。
 */
export function resolveEntityLabel(type: EntityType, id: number): string {
  const sql = LABEL_SQL[type];
  if (!sql || !Number.isSafeInteger(id) || id < 1) return "";
  try {
    const row = getDb().prepare(sql).get(id) as { label?: unknown } | undefined;
    const label = row?.label;
    return typeof label === "string" ? label.trim().slice(0, MAX_LABEL_LENGTH) : "";
  } catch {
    return "";
  }
}
