import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { dataGeneration, withReadSnapshot } from "./db";
import { parsePaginationParams } from "./cursor-pagination";
import { McpOperationError } from "./mcp-errors";
import { APPLICATION_STAGES, type ApplicationStage } from "./applications-types";
import { extractSnippetsFromText } from "./search-snippet";
import { MCP_LIST_BUDGET } from "./mcp-output";
import { assertOperationActive } from "./operation-deadline";

export const MCP_SEARCH_DOMAINS = ["resume", "project", "project_material", "application", "interview", "practice_session", "practice_question",
  "intro", "jd_portrait", "interview_series", "bank_entry", "notebook", "resume_defense", "career_gap_remedy", "salary_negotiation", "jargon_decoding"] as const;
export type SearchDomain = typeof MCP_SEARCH_DOMAINS[number];
type Spec = { from: string; title: string; texts: string[]; permissions: string[]; created?: string; project?: string; stage?: string;
  tool: string; kind?: string };
const child = (table: string, parent: string, text: string) => "(SELECT " + text + " FROM " + table + " c WHERE " + parent +
  " AND instr(lower(" + text + "),lower(:query))>0 ORDER BY c.id LIMIT 1)";
const resumeTitle = "COALESCE(json_extract(v.snapshot,'$.title'),s.title,'')";
const specs: Record<SearchDomain, Spec> = {
  resume: { from: "resumes r", title: "r.title", texts: ["r.title", child("resume_modules", "c.resume_id=r.id", "c.content")],
    permissions: ["list_resumes", "get_resume"], tool: "get_resume" },
  project: { from: "projects r", title: "r.name", texts: ["r.name", "r.summary"], project: "r.id", permissions: ["list_projects", "get_project"], tool: "get_project" },
  project_material: { from: "project_materials r", title: "r.title", texts: ["r.title", "r.content", "r.filename"], project: "r.project_id",
    permissions: ["get_project", "list_project_materials", "read_record_section"], tool: "read_record_section", kind: "project_material" },
  application: { from: "applications r", title: "r.company||' · '||r.role", texts: ["r.company", "r.role", "r.jd", "r.notes"], stage: "r.stage",
    permissions: ["list_applications", "get_application"], tool: "get_application" },
  interview: { from: "interviews r JOIN resumes s ON s.id=r.resume_id LEFT JOIN resume_versions v ON v.id=r.resume_version_id",
    title: resumeTitle, texts: [resumeTitle, "r.jd", "r.report", child("interview_turns", "c.interview_id=r.id", "c.question||' '||c.answer||' '||c.comment||' '||c.reference")],
    permissions: ["list_interviews", "get_interview"], tool: "get_interview" },
  practice_session: { from: "drills r", title: "COALESCE(NULLIF(r.direction,''),(SELECT p.name FROM projects p WHERE p.id=r.project_id),r.focus)",
    texts: ["r.direction", "r.jd", "r.focus"], project: "r.project_id", permissions: ["list_practice_sessions", "read_record_section"], tool: "read_record_section", kind: "practice_session" },
  practice_question: { from: "drill_questions r JOIN drills d ON d.id=r.drill_id", title: "r.question", texts: ["r.question", "r.answer", "r.comment", "r.reference"],
    project: "d.project_id", created: "d.created_at", permissions: ["list_practice_questions", "get_practice_question"], tool: "get_practice_question" },
  intro: { from: "intros r JOIN resumes s ON s.id=r.resume_id LEFT JOIN resume_versions v ON v.id=r.resume_version_id", title: resumeTitle,
    texts: [resumeTitle, "r.jd", child("intro_versions", "c.intro_id=r.id", "c.sentences")], permissions: ["list_intros", "get_intro"], tool: "get_intro" },
  jd_portrait: { from: "jd_portraits r", title: "r.jd", texts: ["r.jd", "r.result"], permissions: ["list_jd_portraits", "get_jd_portrait"], tool: "get_jd_portrait" },
  interview_series: { from: "interview_series r", title: "r.jd", texts: ["r.jd", "r.final_report"], permissions: ["list_interview_series", "get_interview_series"], tool: "get_interview_series" },
  bank_entry: { from: "bank_entries r", title: "r.question", texts: ["r.question", "r.direction"], permissions: ["list_bank_entries", "read_record_section"], tool: "read_record_section", kind: "bank_entry" },
  notebook: { from: "notebook_entries r", title: "r.question", texts: ["r.question", "r.answer", "r.reference", "r.comment", "(SELECT content FROM notebook_notes n WHERE n.notebook_id=r.id)"], permissions: ["list_notebook", "get_notebook_entry"], tool: "get_notebook_entry" },
  resume_defense: { from: "resume_defenses r", title: "r.title", texts: ["r.title", "r.target_role", "r.source_content"], permissions: ["list_career_records", "get_career_record"], tool: "get_career_record", kind: "resume_defense" },
  career_gap_remedy: { from: "resignation_gap_remedies r", title: "r.target_role", texts: ["r.target_role", "r.raw_story", "r.result"], permissions: ["list_career_records", "get_career_record"], tool: "get_career_record", kind: "career_gap_remedy" },
  salary_negotiation: { from: "salary_negotiations r", title: "r.target_role", texts: ["r.target_role", "r.target_company_tier", "r.report",
    child("salary_negotiation_turns", "c.negotiation_id=r.id", "c.user_message||' '||c.hr_response")], permissions: ["list_career_records", "get_career_record"], tool: "get_career_record", kind: "salary_negotiation" },
  jargon_decoding: { from: "jargon_decodings r", title: "r.source_text", texts: ["r.source_text", "r.result"], permissions: ["list_career_records", "get_career_record"], tool: "get_career_record", kind: "jargon_decoding" },
};
export type SearchInput = { query: string; domains?: SearchDomain[]; projectId?: number; stages?: ApplicationStage[];
  createdFrom?: string; createdTo?: string; limit?: number; cursor?: string };
type Cursor = { r: string; d: number; i: number };
type Row = { id: number; title: string; created_at: string; project_id: number | null; stage: string | null; snippet: string };
function cursorOf(value: Cursor) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function readCursor(raw?: string): Cursor | null {
  if (raw === undefined) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) throw new Error();
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (cursorOf(parsed) !== raw || Object.keys(parsed).join(",") !== "r,d,i" || !/^[a-f0-9]{64}$/.test(parsed.r) ||
      !Number.isInteger(parsed.d) || parsed.d < 0 || parsed.d >= MCP_SEARCH_DOMAINS.length || !Number.isSafeInteger(parsed.i) || parsed.i < 1) throw new Error();
    return parsed;
  } catch { throw new McpOperationError("INVALID_ARGUMENT", "检索游标无效，请使用上一页返回的 nextCursor"); }
}
function dateBound(value?: string) {
  if (value === undefined) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new McpOperationError("INVALID_ARGUMENT", "时间筛选必须包含时区");
  return new Date(milliseconds).toISOString();
}
/** Fixed SQL fragments only. User terms are bound parameters, including SQL wildcard characters. */
function queryRows(db: DatabaseSync, domain: SearchDomain, input: SearchInput, from: string | null, to: string | null,
  options: { count: true } | { count?: false; after: number | null; take: number }) {
  const spec = specs[domain], params: Record<string, SQLInputValue> = { ":query": input.query };
  const text = "CASE " + spec.texts.map(expr => "WHEN instr(lower(" + expr + "),lower(:query))>0 THEN " + expr).join(" ") + " END";
  const where = ["matched_text IS NOT NULL"];
  if (input.projectId !== undefined) { where.push("project_id=:project"); params[":project"] = input.projectId; }
  if (input.stages !== undefined) {
    const placeholders = input.stages.map((value, index) => { params[":stage" + index] = value; return ":stage" + index; });
    where.push("stage IN (" + placeholders.join(",") + ")");
  }
  if (from) { where.push("julianday(created_at)>=julianday(:from)"); params[":from"] = from; }
  if (to) { where.push("julianday(created_at)<julianday(:to)"); params[":to"] = to; }
  if (!options.count && options.after !== null) { where.push("id<:after"); params[":after"] = options.after; }
  if (!options.count) params[":take"] = options.take;
  // Return a bounded match window per row; never materialize all matching bodies in JS.
  const sql = "WITH documents AS (SELECT r.id,substr(" + spec.title + ",1,160) AS title," + (spec.created ?? "r.created_at") +
    " AS created_at," + (spec.project ?? "NULL") + " AS project_id," + (spec.stage ?? "NULL") + " AS stage," + text +
    " AS matched_text FROM " + spec.from + ") SELECT " + (options.count ? "COUNT(*) AS count" : "id,title,created_at,project_id,stage," +
    "substr(matched_text,max(1,instr(lower(matched_text),lower(:query))-80),280) AS snippet") + " FROM documents WHERE " +
    where.join(" AND ") + (options.count ? "" : " ORDER BY id DESC LIMIT :take");
  return { statement: db.prepare(sql), params };
}
const countCache = new Map<string, { total: number; at: number }>();
export function searchRecordsPage(input: SearchInput, permits: (tool: string) => boolean) {
  return withReadSnapshot(db => {
    const query = input.query.trim();
    if (query.length < 2 || query.length > 100) throw new McpOperationError("INVALID_ARGUMENT", "搜索词须为 2–100 个字符");
    if (input.domains && (!input.domains.length || new Set(input.domains).size !== input.domains.length || input.domains.some(domain => !MCP_SEARCH_DOMAINS.includes(domain)))) throw new McpOperationError("INVALID_ARGUMENT", "检索领域无效或重复");
    if (input.stages && (!input.stages.length || new Set(input.stages).size !== input.stages.length || input.stages.some(stage => !APPLICATION_STAGES.includes(stage)))) throw new McpOperationError("INVALID_ARGUMENT", "投递阶段筛选无效或重复");
    if (input.projectId !== undefined && (!Number.isSafeInteger(input.projectId) || input.projectId < 1)) throw new McpOperationError("INVALID_ARGUMENT", "项目 ID 无效");
    const supported = (domain: SearchDomain) => (input.projectId === undefined || !!specs[domain].project) && (input.stages === undefined || !!specs[domain].stage);
    if (input.domains?.some(domain => !supported(domain)) || (input.projectId !== undefined && input.stages !== undefined)) throw new McpOperationError("INVALID_ARGUMENT", "所选领域不支持这些筛选条件的组合");
    if (input.domains?.some(domain => specs[domain].permissions.some(tool => !permits(tool)))) throw new McpOperationError("FORBIDDEN", "缺少所选领域的来源读取权限");
    const domains = MCP_SEARCH_DOMAINS.filter(domain => (!input.domains || input.domains.includes(domain)) && supported(domain) && specs[domain].permissions.every(permits));
    const from = dateBound(input.createdFrom), to = dateBound(input.createdTo);
    if (from && to && from >= to) throw new McpOperationError("INVALID_ARGUMENT", "开始时间必须早于结束时间");
    const pagination = parsePaginationParams(new URLSearchParams(input.limit === undefined ? {} : { limit: String(input.limit) }), "none");
    if (!pagination.ok || pagination.limit > 50) throw new McpOperationError("INVALID_ARGUMENT", "检索分页大小必须为 1–50");
    const cursor = readCursor(input.cursor);
    const identity = db.prepare("SELECT instance_id FROM mcp_runtime_identity WHERE id=1").get();
    const epochs = domains.map(domain => [domain, db.prepare("SELECT revision FROM mcp_search_epochs WHERE domain=?").get(domain)]);
    const revision = createHash("sha256").update(JSON.stringify([identity, dataGeneration(db), query, epochs, input.projectId ?? null, input.stages?.slice().sort() ?? null, from, to])).digest("hex");
    if (cursor && cursor.r !== revision) throw new McpOperationError("CONFLICT", "筛选、权限或查询领域已变化，请从第一页重新检索");
    let cached = countCache.get(revision);
    if (!cached || cached.at + 60_000 < Date.now()) {
      let total = 0;
      for (const domain of domains) {
        assertOperationActive();
        const { statement, params } = queryRows(db, domain, { ...input, query }, from, to, { count: true });
        total += (statement.get(params) as { count: number }).count;
      }
      cached = { total, at: Date.now() };
      countCache.delete(revision);
      while (countCache.size >= 128) countCache.delete(countCache.keys().next().value!);
      countCache.set(revision, cached);
    }
    const items: (Row & { domain: SearchDomain; fullContent: { tool: string; arguments: { id: number; kind?: string } } })[] = [];
    let more = false, size = 0;
    for (const domain of domains) {
      const position = MCP_SEARCH_DOMAINS.indexOf(domain);
      if (cursor && position < cursor.d) continue;
      assertOperationActive();
      const { statement, params } = queryRows(db, domain, { ...input, query }, from, to,
        { after: cursor && position === cursor.d ? cursor.i : null, take: pagination.limit - items.length + 1 });
      for (const row of statement.iterate(params) as IterableIterator<Row>) {
        const snippet = extractSnippetsFromText(row.snippet, query, { maxSnippets: 1, contextBefore: 60, contextAfter: 100 })[0]?.text ?? row.snippet;
        const spec = specs[domain], item = { ...row, snippet, domain, fullContent: { tool: spec.tool, arguments: { id: row.id, ...(spec.kind ? { kind: spec.kind } : {}) } } };
        const itemBytes = JSON.stringify(item).length;
        if (items.length >= pagination.limit || (items.length > 0 && size + itemBytes > MCP_LIST_BUDGET - 1000)) { more = true; break; }
        items.push(item); size += itemBytes;
      }
      if (more) break;
    }
    const last = items.at(-1);
    return { query, domains, revision, total: cached.total, items, nextCursor: more && last ? cursorOf({ r: revision, d: MCP_SEARCH_DOMAINS.indexOf(last.domain), i: last.id }) : null };
  });
}
