import { DatabaseSync } from "node:sqlite";
import { createSearchIndexes, SEARCH_INDEX_OBJECT_NAMES } from "./search-index";

export const CURRENT_DB_VERSION = 1;

/**
 * 登录凭证与会话表：属于机器本地的运行时状态（同 runtime_state），不参与用户备份，
 * 因此不出现在 backup.ts 的 TABLES_CLEAR_ORDER / AUTOINCREMENT_TABLES 清单里。
 */
export const AUTH_SCHEMA_SQL = `
-- 单用户登录凭证（scrypt 哈希）；重新初始化时整行覆写
CREATE TABLE IF NOT EXISTS auth_users (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 会话令牌只存 SHA-256 哈希；expires_at 为 ISO 时间戳，滑动续期由已登录请求按一小时窗口节流推进
CREATE TABLE IF NOT EXISTS auth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
`;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  api_format TEXT NOT NULL DEFAULT 'openai_chat',
  model_parse TEXT NOT NULL DEFAULT '',
  model_summary TEXT NOT NULL DEFAULT '',
  model_question TEXT NOT NULL DEFAULT '',
  model_evaluate TEXT NOT NULL DEFAULT '',
  ocr_mode TEXT NOT NULL DEFAULT 'auto',
  proxy_enabled INTEGER NOT NULL DEFAULT 0,
  proxy_url TEXT NOT NULL DEFAULT '',
  proxy_username TEXT NOT NULL DEFAULT '',
  proxy_password TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  max_output_tokens TEXT NOT NULL DEFAULT '8192'
);

-- 运行时数据世代不参与用户备份；恢复后旧的异步请求必须失效。
CREATE TABLE IF NOT EXISTS runtime_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_generation TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  template TEXT NOT NULL DEFAULT 'classic',
  style_overrides TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  base_version_id INTEGER REFERENCES resume_versions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS resume_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_id INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  parent_id INTEGER REFERENCES resume_versions(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  UNIQUE (resume_id, version)
);

CREATE TABLE IF NOT EXISTS resume_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_id INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('basic','education','work','projects','skills','summary','custom')),
  label TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  UNIQUE (resume_id, module_key)
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '{}',
  summary_updated_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'paste' CHECK (source IN ('paste','file')),
  filename TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_summary_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  ai_baseline TEXT NOT NULL DEFAULT '{}',
  material_snapshot TEXT,
  source TEXT NOT NULL CHECK (source IN ('ai','repo','manual')),
  created_at TEXT NOT NULL
);

-- 练习三来源：project=项目深挖题（project_id 必填），bank=岗位通用题（direction/jd 至少一项），
-- interview=面试追练题（由总结报告的短板维度发起；interview_id 可空——面试删除后追练题保留）
CREATE TABLE IF NOT EXISTS drills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'project' CHECK (source IN ('project','bank','interview')),
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  direction TEXT NOT NULL DEFAULT '',
  jd TEXT NOT NULL DEFAULT '',
  interview_id INTEGER REFERENCES interviews(id) ON DELETE SET NULL,
  focus TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- kind 标记题型来源：'tech'=八股、'behavior'=行为，项目深挖题留空
CREATE TABLE IF NOT EXISTS drill_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drill_id INTEGER NOT NULL REFERENCES drills(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  scores TEXT NOT NULL DEFAULT '',
  answered_at TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT ''
);

-- 岗位通用题库：手动导入的八股/行为题，练习按 JD/方向从中检索出题
CREATE TABLE IF NOT EXISTS bank_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('tech','behavior')),
  question TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 进阶面试：同一岗位串联三轮（一面技术面 → 二面主管面 → 三面 HR 面），
-- 每轮是一条独立的 interviews 记录（独立报告），三轮齐备后合成跨轮总评存于 final_report
CREATE TABLE IF NOT EXISTS interview_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_id INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  jd TEXT NOT NULL,
  rounds INTEGER NOT NULL DEFAULT 8,
  status TEXT NOT NULL DEFAULT 'ongoing' CHECK (status IN ('ongoing','finished')),
  final_report TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  resume_version_id INTEGER REFERENCES resume_versions(id) ON DELETE SET NULL
);

-- series_id 为空 = 单轮面试；round_no 仅在进阶面试中有意义（1/2/3），0 表示单轮
CREATE TABLE IF NOT EXISTS interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_id INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  jd TEXT NOT NULL,
  rounds INTEGER NOT NULL DEFAULT 8,
  style TEXT NOT NULL DEFAULT 'gentle' CHECK (style IN ('gentle','stress','deep','manager','hr','mining')),
  series_id INTEGER REFERENCES interview_series(id) ON DELETE CASCADE,
  round_no INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ongoing' CHECK (status IN ('ongoing','finished')),
  report TEXT NOT NULL DEFAULT '',
  reverse_interview TEXT NOT NULL DEFAULT '',
  evaluator_report TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  resume_version_id INTEGER REFERENCES resume_versions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS interview_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'question' CHECK (kind IN ('question','followup')),
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  scores TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  retries TEXT NOT NULL DEFAULT '[]',
  answered_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS resume_diagnoses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_id INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL DEFAULT '',
  job_title TEXT NOT NULL DEFAULT '',
  jd TEXT NOT NULL,
  report TEXT NOT NULL,
  resume_snapshot TEXT NOT NULL,
  adoptions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  resume_version_id INTEGER REFERENCES resume_versions(id) ON DELETE SET NULL
);

-- 自我介绍工坊：按简历+JD 生成的自我介绍记录，固定含 30s/2min 两版
CREATE TABLE IF NOT EXISTS intros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_id INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  jd TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  resume_version_id INTEGER REFERENCES resume_versions(id) ON DELETE SET NULL
);

-- 版本句子以 [{text, comment}] JSON 存储：text 可编辑，comment 为逐句点评（编辑后置空待重新点评）
CREATE TABLE IF NOT EXISTS intro_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intro_id INTEGER NOT NULL REFERENCES intros(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('30s','2min')),
  sentences TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  UNIQUE (intro_id, kind)
);

-- 样式工厂：用户保存的自定义简历模板，style 为 ResumeStyle 参数 JSON
CREATE TABLE IF NOT EXISTS resume_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  style TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notebook_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (name)
);

-- 错题条目保存收藏时刻的题目快照（不外键关联源表），练习/面试记录删除后仍可回顾
CREATE TABLE IF NOT EXISTS notebook_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES notebook_categories(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('drill','interview','application_interview')),
  source_id INTEGER NOT NULL,
  source_label TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  scores TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, source_id)
);

-- JD 考点画像：解析一段 JD 生成的考点雷达（必考技能/追问方向/公司风格），result 为画像 JSON
CREATE TABLE IF NOT EXISTS jd_portraits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jd TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- 工具箱 · 面试黑话与公司风格暗号解码器
CREATE TABLE IF NOT EXISTS jargon_decodings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_text TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Offer 谈判与薪酬博弈主表
CREATE TABLE IF NOT EXISTS salary_negotiations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_company_tier TEXT NOT NULL,
  target_role TEXT NOT NULL,
  expected_salary TEXT NOT NULL,
  current_or_competing_offer TEXT NOT NULL DEFAULT '',
  hr_style TEXT NOT NULL DEFAULT 'standard' CHECK (hr_style IN ('pressure', 'standard', 'emotional')),
  status TEXT NOT NULL DEFAULT 'ongoing' CHECK (status IN ('ongoing', 'finished')),
  initial_offer TEXT NOT NULL DEFAULT '',
  final_package TEXT NOT NULL DEFAULT '',
  report TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT ''
);

-- 谈判对话回合表
CREATE TABLE IF NOT EXISTS salary_negotiation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  negotiation_id INTEGER NOT NULL REFERENCES salary_negotiations(id) ON DELETE CASCADE,
  turn_no INTEGER NOT NULL,
  user_message TEXT NOT NULL DEFAULT '',
  hr_response TEXT NOT NULL,
  hr_tactics TEXT NOT NULL DEFAULT '',
  hr_mindset TEXT NOT NULL DEFAULT '{}',
  mentor_analysis TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- 求职全流程投递与面试日程看板表
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  salary_range TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL CHECK (stage IN ('interested','applied','interviewing','interview','reviewing','offer','rejected')),
  resume_id INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
  jd TEXT NOT NULL DEFAULT '',
  interview_id INTEGER REFERENCES interviews(id) ON DELETE SET NULL,
  interview_series_id INTEGER REFERENCES interview_series(id) ON DELETE SET NULL,
  next_interview_at TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  submitted_resume TEXT,
  submitted_jd TEXT,
  flow_status TEXT NOT NULL DEFAULT 'active' CHECK (flow_status IN ('active','passed','terminated')),
  batch_name TEXT NOT NULL DEFAULT '',
  hiring_stage TEXT CHECK (hiring_stage IN ('resume_screening','technical_interview','hr_interview','other')),
  stage_changed_at TEXT NOT NULL DEFAULT '',
  terminal_stage TEXT CHECK (terminal_stage IN ('resume_screening','technical_interview','hr_interview','other')),
  terminal_reason TEXT NOT NULL DEFAULT '',
  terminal_at TEXT NOT NULL DEFAULT '',
  resume_version_id INTEGER REFERENCES resume_versions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS application_stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_stage TEXT CHECK (from_stage IN ('interested','applied','interviewing','interview','reviewing','offer','rejected')),
  to_stage TEXT NOT NULL CHECK (to_stage IN ('interested','applied','interviewing','interview','reviewing','offer','rejected')),
  from_hiring_stage TEXT CHECK (from_hiring_stage IN ('resume_screening','technical_interview','hr_interview','other')),
  to_hiring_stage TEXT CHECK (to_hiring_stage IN ('resume_screening','technical_interview','hr_interview','other')),
  terminal_stage TEXT CHECK (terminal_stage IN ('resume_screening','technical_interview','hr_interview','other')),
  changed_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);

-- 投递记录关联的独立面试轮次子表（一面、二面、HR面等）
CREATE TABLE IF NOT EXISTS application_interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  round_name TEXT NOT NULL,
  interview_time TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','passed','failed','completed','cancelled')),
  interviewer TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  meeting_url TEXT NOT NULL DEFAULT '',
  reminder_minutes INTEGER NOT NULL DEFAULT 15,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_interview_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL REFERENCES application_interviews(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position > 0),
  question TEXT NOT NULL CHECK (length(trim(question)) BETWEEN 1 AND 2000),
  answer TEXT NOT NULL DEFAULT '',
  stuck TEXT NOT NULL DEFAULT '',
  feedback TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (interview_id, position)
);

CREATE TABLE IF NOT EXISTS application_interview_recaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL REFERENCES application_interviews(id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  questions TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_interview_recap_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recap_id INTEGER NOT NULL REFERENCES application_interview_recaps(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mistakes','drills','resume_suggestions')),
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  target_id INTEGER NOT NULL DEFAULT 0 CHECK (target_id >= 0),
  UNIQUE (recap_id, kind, item_index)
);

-- 简历排雷：毒舌大厂面试官高危点扫描与防御预案
CREATE TABLE IF NOT EXISTS application_preparation_resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  diagnosis_id INTEGER REFERENCES resume_diagnoses(id) ON DELETE CASCADE,
  intro_id INTEGER REFERENCES intros(id) ON DELETE CASCADE,
  portrait_id INTEGER REFERENCES jd_portraits(id) ON DELETE CASCADE,
  interview_id INTEGER REFERENCES interviews(id) ON DELETE CASCADE,
  series_id INTEGER REFERENCES interview_series(id) ON DELETE CASCADE,
  notebook_id INTEGER REFERENCES notebook_entries(id) ON DELETE CASCADE,
  CHECK ((diagnosis_id IS NOT NULL) + (intro_id IS NOT NULL) + (portrait_id IS NOT NULL) +
         (interview_id IS NOT NULL) + (series_id IS NOT NULL) + (notebook_id IS NOT NULL) = 1),
  UNIQUE (application_id, diagnosis_id), UNIQUE (application_id, intro_id),
  UNIQUE (application_id, portrait_id), UNIQUE (application_id, interview_id),
  UNIQUE (application_id, series_id), UNIQUE (application_id, notebook_id)
);

CREATE TABLE IF NOT EXISTS application_preparation_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  due_time TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resume_defenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_id INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  source_content TEXT NOT NULL,
  target_role TEXT NOT NULL DEFAULT '',
  risk_level TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('critical', 'high', 'medium', 'low')),
  overall_roast TEXT NOT NULL DEFAULT '',
  scanned_items TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  resume_version_id INTEGER REFERENCES resume_versions(id) ON DELETE SET NULL
);

-- 简历排雷：针对具体高危点的防御演练记录
CREATE TABLE IF NOT EXISTS resume_defense_drills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  defense_id INTEGER NOT NULL REFERENCES resume_defenses(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  question TEXT NOT NULL,
  user_answer TEXT NOT NULL DEFAULT '',
  interviewer_roast TEXT NOT NULL DEFAULT '',
  defense_score INTEGER NOT NULL DEFAULT 0,
  defense_critique TEXT NOT NULL DEFAULT '',
  improved_answer TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resume_defenses_res_id ON resume_defenses(resume_id);
CREATE INDEX IF NOT EXISTS idx_defense_drills_def_id ON resume_defense_drills(defense_id);
CREATE INDEX IF NOT EXISTS idx_applications_stage ON applications(stage);
CREATE INDEX IF NOT EXISTS idx_preparation_tasks_application ON application_preparation_tasks(application_id, id);
CREATE INDEX IF NOT EXISTS idx_app_prep_tasks_due ON application_preparation_tasks(due_time, done);
CREATE INDEX IF NOT EXISTS idx_applications_next_interview ON applications(next_interview_at);
CREATE INDEX IF NOT EXISTS idx_applications_resume_id ON applications(resume_id);

-- 工具箱 · 离职原因与空窗期高情商重塑对策库
CREATE TABLE IF NOT EXISTS resignation_gap_remedies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_type TEXT NOT NULL DEFAULT 'both' CHECK (scenario_type IN ('resignation', 'gap', 'both')),
  raw_story TEXT NOT NULL,
  target_role TEXT NOT NULL DEFAULT '',
  persona_style TEXT NOT NULL DEFAULT 'pragmatic' CHECK (persona_style IN ('pragmatic', 'driven', 'composed')),
  result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- AI 调用计量日志：每次 LLM 调用一条，用于用量看板与来源追踪
CREATE TABLE IF NOT EXISTS llm_call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  feature      TEXT NOT NULL,
  entity_type  TEXT NOT NULL DEFAULT '',
  entity_id    INTEGER,
  entity_label TEXT NOT NULL DEFAULT '',
  task         TEXT NOT NULL,
  model        TEXT NOT NULL,
  api_format   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('ok','failed','cancelled')),
  error_code   TEXT NOT NULL DEFAULT '',
  attempts     INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER
);
-- 每张复习卡只引用一个来源；收藏追练后将来源转接到独立错题快照。
CREATE TABLE IF NOT EXISTS review_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notebook_id INTEGER UNIQUE REFERENCES notebook_entries(id) ON DELETE CASCADE,
  drill_question_id INTEGER UNIQUE REFERENCES drill_questions(id) ON DELETE CASCADE,
  interval_days INTEGER NOT NULL DEFAULT 0 CHECK (interval_days BETWEEN 0 AND 365),
  ease_factor INTEGER NOT NULL DEFAULT 250 CHECK (ease_factor >= 130),
  repetitions INTEGER NOT NULL DEFAULT 0 CHECK (repetitions >= 0),
  review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  lapses INTEGER NOT NULL DEFAULT 0 CHECK (lapses >= 0),
  next_review_date TEXT NOT NULL,
  last_reviewed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CHECK ((notebook_id IS NOT NULL) + (drill_question_id IS NOT NULL) = 1)
);

CREATE TABLE IF NOT EXISTS review_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES review_cards(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  answer TEXT NOT NULL CHECK (length(trim(answer)) BETWEEN 1 AND 20000),
  grade TEXT NOT NULL CHECK (grade IN ('again','hard','good','easy')),
  reviewed_at TEXT NOT NULL,
  review_date TEXT NOT NULL,
  interval_days INTEGER NOT NULL CHECK (interval_days BETWEEN 1 AND 365),
  next_review_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_cards_due ON review_cards(next_review_date, id);
CREATE INDEX IF NOT EXISTS idx_review_attempts_card ON review_attempts(card_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_review_attempts_date ON review_attempts(review_date, card_id);
CREATE INDEX IF NOT EXISTS idx_applications_updated_at ON applications(updated_at);
CREATE INDEX IF NOT EXISTS idx_applications_updated_at_id ON applications(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_applications_stage_updated_at_id ON applications(stage, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_app_interviews_app_id ON application_interviews(application_id);
CREATE INDEX IF NOT EXISTS idx_app_interviews_time ON application_interviews(interview_time);
CREATE INDEX IF NOT EXISTS idx_app_interview_questions_round ON application_interview_questions(interview_id, position);
CREATE INDEX IF NOT EXISTS idx_app_interview_recaps_round ON application_interview_recaps(interview_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_app_interview_exports_recap ON application_interview_recap_exports(recap_id);
CREATE INDEX IF NOT EXISTS idx_app_stage_history_app_id ON application_stage_history(application_id, id);
CREATE INDEX IF NOT EXISTS idx_applications_batch ON applications(batch_name);
CREATE INDEX IF NOT EXISTS idx_salary_turns_neg_id ON salary_negotiation_turns(negotiation_id, turn_no);
CREATE INDEX IF NOT EXISTS idx_resume_modules_res_id ON resume_modules(resume_id);
CREATE INDEX IF NOT EXISTS idx_resume_diagnoses_history ON resume_diagnoses(resume_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_resume_diagnoses_job ON resume_diagnoses(resume_id, job_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_project_materials_proj_id ON project_materials(project_id);
CREATE INDEX IF NOT EXISTS idx_project_summary_history_project_id ON project_summary_history(project_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_bank_entries_direction_id ON bank_entries(direction, id);
CREATE INDEX IF NOT EXISTS idx_drills_proj_id ON drills(project_id);
CREATE INDEX IF NOT EXISTS idx_drill_questions_drill_id ON drill_questions(drill_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_interview_turns_position ON interview_turns(interview_id, idx);
CREATE UNIQUE INDEX IF NOT EXISTS idx_interviews_round ON interviews(series_id, round_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_turns_position ON salary_negotiation_turns(negotiation_id, turn_no);
CREATE INDEX IF NOT EXISTS idx_interviews_res_id ON interviews(resume_id);
CREATE INDEX IF NOT EXISTS idx_interviews_series_id ON interviews(series_id);
CREATE INDEX IF NOT EXISTS idx_interview_turns_int_id ON interview_turns(interview_id);
CREATE INDEX IF NOT EXISTS idx_intros_res_id ON intros(resume_id);
CREATE INDEX IF NOT EXISTS idx_notebook_cat_id ON notebook_entries(category_id);
CREATE INDEX IF NOT EXISTS idx_llm_call_logs_created_at ON llm_call_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_call_logs_feature_created_at ON llm_call_logs(feature, created_at);

${AUTH_SCHEMA_SQL}
`;

const INDEX_STATEMENT = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS[\s\S]*?;\s*/g;
const indexStatements = SCHEMA_SQL.match(INDEX_STATEMENT);
if (!indexStatements?.length) throw new Error("数据库 schema 缺少索引定义");
const TABLE_SCHEMA_SQL = SCHEMA_SQL.replace(INDEX_STATEMENT, "");
const INDEX_SCHEMA_SQL = indexStatements.join("\n");

type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type ForeignKeyInfo = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
};

type ExpectedTableSchema = {
  sql: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function expectedSchema(): Map<string, ExpectedTableSchema> {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(SCHEMA_SQL);
    createSearchIndexes(expected);
    const tables = expected
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string }>;
    return new Map(tables.filter(({ name }) => !SEARCH_INDEX_OBJECT_NAMES.has(name)).map(({ name, sql }) => [name, {
      sql,
      columns: expected.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as ColumnInfo[],
      foreignKeys: expected.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all() as ForeignKeyInfo[],
    }]));
  } finally {
    expected.close();
  }
}

const EXPECTED_SCHEMA = expectedSchema();
const EXPECTED_OBJECTS = (() => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(SCHEMA_SQL);
    createSearchIndexes(database);
    return database.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY name").all() as { name: string; sql: string }[];
  } finally {
    database.close();
  }
})();

function normalizedSql(sql: string): string {
  return sql.replace(/\s*,\s*/g, ", ").replace(/\s*\)\s*$/, ")").replace(/\s+/g, " ").trim();
}

export function validateDatabaseSchema(database: DatabaseSync): void {
  const expectedTables = [...EXPECTED_SCHEMA.keys()];
  const actualTables = (database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]).map(({ name }) => name).filter((name) => !SEARCH_INDEX_OBJECT_NAMES.has(name));
  if (actualTables.length !== expectedTables.length ||
      expectedTables.some((table, index) => actualTables[index] !== table)) {
    throw new Error("数据库结构校验失败：业务表集合不匹配");
  }

  for (const [table, { columns: expectedColumns, foreignKeys: expectedForeignKeys }] of EXPECTED_SCHEMA) {
    const actualSql = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string };
    if (normalizedSql(actualSql.sql) !== normalizedSql(EXPECTED_SCHEMA.get(table)!.sql)) {
      throw new Error(`数据库结构校验失败：${table} 建表约束不匹配`);
    }
    const actualColumns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as ColumnInfo[];
    if (actualColumns.length !== expectedColumns.length) {
      throw new Error(`数据库结构校验失败：${table} 列集合不匹配`);
    }
    for (const [index, expected] of expectedColumns.entries()) {
      // 上方已校验长度相等，索引必然命中
      const actual = actualColumns[index]!;
      if (actual.name !== expected.name || actual.type !== expected.type ||
          actual.notnull !== expected.notnull || actual.dflt_value !== expected.dflt_value ||
          actual.pk !== expected.pk) {
        throw new Error(`数据库结构校验失败：${table} 第 ${index + 1} 列定义不匹配`);
      }
    }
    const actualForeignKeys = database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as ForeignKeyInfo[];
    if (JSON.stringify(actualForeignKeys) !== JSON.stringify(expectedForeignKeys)) {
      throw new Error(`数据库结构校验失败：${table} 外键定义不匹配`);
    }
  }
  for (const expected of EXPECTED_OBJECTS) {
    const actual = database.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(expected.name) as { sql: string } | undefined;
    if (!actual || normalizedSql(actual.sql) !== normalizedSql(expected.sql)) {
      throw new Error(`数据库结构校验失败：${expected.name} 索引或触发器不匹配`);
    }
  }
}

/**
 * catch 块里的安全回滚：SQLITE_FULL / SQLITE_IOERR 等错误下 SQLite 已经自动回滚整个事务，
 * 此时再执行 ROLLBACK 会抛 "no transaction is active" 并把原始错误（如 ENOSPC）替换掉，
 * 排障方向会被带偏。回滚再次失败时把回滚异常挂到原错误上，保证原错误向上传播。
 */
export function rollbackIgnoringAutoRollback(
  database: { exec: (statement: string) => void },
  originalError: unknown,
): void {
  try {
    database.exec("ROLLBACK");
  } catch (rollbackError) {
    if (originalError instanceof Error) {
      (originalError as Error & { rollbackError?: unknown }).rollbackError = rollbackError;
    }
  }
}

export function initializeDatabase(database: DatabaseSync): void {
  const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version.user_version !== 0 && version.user_version !== CURRENT_DB_VERSION) {
    throw new Error(`不支持数据库版本 ${version.user_version}：仅支持数据库版本 ${CURRENT_DB_VERSION}`);
  }
  if (version.user_version === CURRENT_DB_VERSION) {
    validateDatabaseSchema(database);
    if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
      throw new Error("数据库结构校验失败：外键完整性校验失败");
    }
    return;
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
      throw new Error("数据库结构不受支持：未标版本的数据库必须为空");
    }
    database.exec(TABLE_SCHEMA_SQL);
    database.exec(INDEX_SCHEMA_SQL);
    createSearchIndexes(database);
    validateDatabaseSchema(database);
    database.exec(`PRAGMA user_version = ${CURRENT_DB_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    rollbackIgnoringAutoRollback(database, error);
    throw error;
  }
}

