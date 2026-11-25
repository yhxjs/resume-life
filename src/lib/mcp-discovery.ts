import { getDb } from "./db";
import { fitPage, pageParams, type PageInput } from "./mcp-read";

export type DiscoveryInput = PageInput & { q?: string; resumeId?: number };
const specs = {
  intro: { select: "SELECT i.id,i.resume_id,i.resume_version_id,i.jd,i.created_at,COALESCE(json_extract(v.snapshot,'$.title'),r.title) AS resume_title FROM intros i JOIN resumes r ON r.id=i.resume_id LEFT JOIN resume_versions v ON v.id=i.resume_version_id", alias: "i", text: "i.jd || ' ' || COALESCE(json_extract(v.snapshot,'$.title'),r.title)", resume: true },
  jd_portrait: { select: "SELECT i.id,i.jd,i.created_at FROM jd_portraits i", alias: "i", text: "i.jd", resume: false },
  interview_series: { select: "SELECT i.id,i.resume_id,i.resume_version_id,i.jd,i.rounds,i.status,i.created_at,i.finished_at FROM interview_series i", alias: "i", text: "i.jd", resume: true },
} as const;

export function listMcpDiscovered(kind: keyof typeof specs, input: DiscoveryInput) {
  const { idCursor, limit } = pageParams(input), spec = specs[kind], q = input.q?.trim() ?? "";
  const rows = getDb().prepare(`${spec.select} WHERE (? IS NULL OR i.id<?) AND instr(lower(${spec.text}),lower(?))>0
    ${spec.resume ? "AND (? IS NULL OR i.resume_id=?)" : ""} ORDER BY i.id DESC LIMIT ?`)
    .all(idCursor, idCursor, q, ...(spec.resume ? [input.resumeId ?? null, input.resumeId ?? null] : []), limit + 1) as { id: number; [key: string]: unknown }[];
  const items = rows.slice(0, limit).map(row => ({ ...row, fullContent: { tool: "read_record_section", kind, id: row.id } }));
  return fitPage(items, rows.length > limit ? String(items.at(-1)!.id) : null, row => String(row.id));
}

export function listMcpBankDirections(input: PageInput & { q?: string }) {
  const { idCursor, limit } = pageParams(input);
  const rows = getDb().prepare(`SELECT MIN(id) AS id,direction,COUNT(*) AS count FROM bank_entries
    WHERE direction!='' AND instr(lower(direction),lower(?))>0 GROUP BY direction HAVING (? IS NULL OR MIN(id)<?) ORDER BY MIN(id) DESC LIMIT ?`)
    .all(input.q?.trim() ?? "", idCursor, idCursor, limit + 1) as { id: number; direction: string; count: number }[];
  return fitPage(rows.slice(0, limit), rows.length > limit ? String(rows[limit - 1]!.id) : null, row => String(row.id));
}
