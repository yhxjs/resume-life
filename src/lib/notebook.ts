import type { DatabaseSync } from "node:sqlite";
import { now } from "@/lib/db";

export type NotebookSnapshotData = {
  answer?: string;
  comment?: string;
  reference?: string;
  scores?: string;
};

/**
 * 当练习题或模拟面试题目更新/生成了答案、点评、参考答案或分数时，
 * 只补齐已收藏快照中的空字段，已有内容不随源题更新（ADR-0003）。
 *
 * @returns 是否补齐了字段（未收藏或没有可补齐的字段则返回 false）
 */
export function syncNotebookSnapshot(
  db: DatabaseSync,
  source: "drill" | "interview",
  sourceId: number,
  snapshot: NotebookSnapshotData
): boolean {
  const sets: string[] = [];
  const missing: string[] = [];
  const params: (string | number)[] = [];

  for (const field of ["answer", "comment", "reference", "scores"] as const) {
    const value = snapshot[field];
    if (value === undefined || value.trim() === "") continue;
    const isMissing = `(${field} IS NULL OR ${field} = '')`;
    sets.push(`${field} = CASE WHEN ${isMissing} THEN ? ELSE ${field} END`);
    missing.push(isMissing);
    params.push(value);
  }

  if (sets.length === 0) return false;

  const timestamp = now();
  sets.push("updated_at = ?");
  params.push(timestamp);

  params.push(source, sourceId);

  const res = db.prepare(
    `UPDATE notebook_entries
     SET ${sets.join(", ")}
     WHERE source = ? AND source_id = ? AND (${missing.join(" OR ")})`
  ).run(...params);

  return res.changes > 0;
}
