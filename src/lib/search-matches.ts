import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

type SearchRows = {
  resume: { label: string; type: string; content: string };
  project: { title: string; content: string };
  interview: { question: string; answer: string };
};

const SOURCES = {
  resume: {
    table: "resume_modules",
    parent: "resume_id",
    columns: ["label", "type", "content"],
    where: "content LIKE ? ESCAPE '\\'",
    patterns: 1,
  },
  project: {
    table: "project_materials",
    parent: "project_id",
    columns: ["title", "content"],
    where: "(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')",
    patterns: 2,
  },
  interview: {
    table: "interview_turns",
    parent: "interview_id",
    columns: ["question", "answer"],
    where: "(question LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\')",
    patterns: 2,
  },
} as const;

/**
 * 每类主体只执行一次片段查询；相关子查询仍先用外键索引，再逐主体 LIMIT 4。
 * 不用窗口函数扫描全部子记录，也不把无界结果读入内存后再截断。
 * 表名/字段均来自固定 SOURCES，主体 ID 和 LIKE 模式只作为绑定参数传入。
 */
export function loadSearchMatches<Kind extends keyof SearchRows>(
  database: DatabaseSync,
  kind: Kind,
  parentIds: readonly number[],
  like: string,
): Map<number, SearchRows[Kind][]> {
  const grouped = new Map<number, SearchRows[Kind][]>();
  if (!parentIds.length) return grouped;

  const source = SOURCES[kind];
  const rows = database.prepare(`
    WITH requested(id) AS (VALUES ${parentIds.map(() => "(?)").join(",")})
    SELECT matched.${source.parent} AS parent_id,
           ${source.columns.map((column) => `matched.${column}`).join(", ")}
    FROM requested JOIN ${source.table} matched ON matched.id IN (
      SELECT id FROM ${source.table}
      WHERE ${source.parent} = requested.id AND ${source.where}
      ORDER BY id
      LIMIT 4
    )
    ORDER BY matched.${source.parent}, matched.id
  `).all(...parentIds, ...Array.from({ length: source.patterns }, () => like)) as
    (SearchRows[Kind] & { parent_id: number } & Record<string, SQLOutputValue>)[];

  for (const row of rows) {
    const group = grouped.get(row.parent_id);
    if (group) group.push(row);
    else grouped.set(row.parent_id, [row]);
  }
  return grouped;
}
