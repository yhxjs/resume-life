import { clearEntityLlmLabels } from "./llm-label-cleanup";
import { dataGeneration, getDb, inTransaction } from "@/lib/db";
import { createHash } from "node:crypto";
import {
  MODULE_LABELS,
  type ModuleData,
  defaultContent,
  isModuleKey,
  normalizeContent,
} from "@/lib/modules";
import { sanitizeStyleOverrides, type ResumeStyle, type ResumeStyleOverrides } from "@/lib/templates";
import { ResumeContextError, ResumeNotFoundError } from "./resume-errors";
import { assertResumeModelModules } from "./resume-model-material";
import type { ResumeSnapshot } from "./resume-version-types";
import { listResumeAvatarUrls, removeUnreferencedUploadsByUrls } from "./upload-storage";

type ResumeRow = {
  id: number;
  title: string;
  template: string;
  style_overrides: ResumeStyleOverrides;
  /** 默认样式仅供修复预览，显式保存排版后才可发布或导出。 */
  styleCorrupted?: boolean;
  resolved_style?: ResumeStyle;
  created_at: string;
  updated_at: string;
  base_version_id?: number | null;
  titleRevision?: string;
  styleRevision?: string;
  draftRevision?: string;
  dataGeneration?: string | null;
};
export type ResumeWithModules = {
  resume: ResumeRow;
  /** 按用户排序（sort）排列的模块列表 */
  modules: ModuleData[];
  /** 模块内容损坏时的提示；非空表示该模块显示为空，直接保存会覆盖原内容 */
  warnings: string[];
  /** 数据解析损坏的模块 key 清单 */
  corruptedKeys: string[];
};

/** 客户端保存令牌绑定恢复世代和字段，恢复同内容或复制同内容也不能复用。 */
export function revisionOf(value: string, resumeId: number, field: string, generation: string | null = dataGeneration()): string {
  return createHash("sha256").update(JSON.stringify([generation, resumeId, field, value])).digest("hex");
}

/** 级联前收集头像并擦除派生实体标题；提交成功后再清理不再共享的文件。 */
export function deleteResume(id: number): boolean {
  const db = getDb();
  let avatarUrls: string[] = [];
  const deleted = inTransaction(() => {
    if (!db.prepare("SELECT id FROM resumes WHERE id = ?").get(id)) return false;
    avatarUrls = listResumeAvatarUrls(db, id);
    clearEntityLlmLabels(db, "resume", id);
    return db.prepare("DELETE FROM resumes WHERE id = ?").run(id).changes > 0;
  });
  if (deleted) {
    removeUnreferencedUploadsByUrls(avatarUrls);
  }
  return deleted;
}

/** 加载简历与全部模块内容（缺失模块不出现在列表里，损坏模块回退默认值并记录警告与损坏标记） */
export function loadResume(id: number, versionId?: number | null): ResumeWithModules | null {
  const db = getDb();
  const rawResume = db
    .prepare("SELECT id, title, template, style_overrides, created_at, updated_at, base_version_id FROM resumes WHERE id = ?")
    .get(id) as { id: number; title: string; template: string; style_overrides?: string; created_at: string; updated_at: string; base_version_id: number | null } | undefined;
  if (!rawResume) return null;
  if (versionId != null) {
    const version = db.prepare("SELECT snapshot, created_at FROM resume_versions WHERE id = ? AND resume_id = ?").get(versionId, id) as { snapshot: string; created_at: string } | undefined;
    if (!version) return null;
    const snapshot = JSON.parse(version.snapshot) as ResumeSnapshot;
    return {
      resume: {
        id, title: snapshot.title, template: snapshot.template, style_overrides: snapshot.style_overrides, resolved_style: snapshot.resolved_style,
        created_at: rawResume.created_at, updated_at: version.created_at, base_version_id: versionId,
      },
      modules: snapshot.modules,
      warnings: [], corruptedKeys: [],
    };
  }

  let styleOverrides: ResumeStyleOverrides = {};
  let styleCorrupted = false;
  if (rawResume.style_overrides != null) {
    try {
      const parsed: unknown = JSON.parse(rawResume.style_overrides);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid style overrides");
      styleOverrides = sanitizeStyleOverrides(parsed);
    } catch {
      styleOverrides = {};
      styleCorrupted = true;
    }
  }

  const generation = dataGeneration(db);
  const resume: ResumeRow = {
    id: rawResume.id,
    title: rawResume.title,
    template: rawResume.template,
    style_overrides: styleOverrides,
    ...(styleCorrupted ? { styleCorrupted: true } : {}),
    created_at: rawResume.created_at,
    updated_at: rawResume.updated_at,
    base_version_id: rawResume.base_version_id,
    titleRevision: revisionOf(rawResume.title, id, "title", generation),
    styleRevision: revisionOf(rawResume.style_overrides ?? "{}", id, "style", generation),
    dataGeneration: generation,
  };
  const modules: ModuleData[] = [];
  const warnings: string[] = [];
  if (styleCorrupted) warnings.push("排版数据损坏：当前仅显示默认样式预览；请在排版微调中调整并保存，或显式重置排版后再发布或导出。");
  const corruptedKeys: string[] = [];
  const rows = db
    .prepare(
      "SELECT module_key, type, label, sort, content FROM resume_modules WHERE resume_id = ? ORDER BY sort, id"
    )
    .all(id) as { module_key: string; type: string; label: string; sort: number; content: string }[];
  resume.draftRevision = revisionOf(JSON.stringify([rawResume, rows]), id, "draft", generation);
  for (const row of rows) {
    const type = isModuleKey(row.type) ? row.type : null;
    if (!type) continue;
    const label = row.label.trim() || MODULE_LABELS[type];
    let content: unknown;
    try {
      content = normalizeContent(type, JSON.parse(row.content), {
        stableIdPrefix: revisionOf(row.module_key, id, "entry-id", null).slice(0, 16),
      });
    } catch {
      content = defaultContent(type);
      warnings.push(`「${label}」模块数据无法解析，已显示为空；直接保存将覆盖原内容。`);
      corruptedKeys.push(row.module_key);
    }
    modules.push({ key: row.module_key, type, label, sort: row.sort, content, revision: revisionOf(row.content, id, `module:${row.module_key}`, generation) });
  }
  return { resume, modules, warnings, corruptedKeys };
}

type EntryContent = {
  school?: string;
  company?: string;
  name?: string;
  degree?: string;
  field?: string;
  title?: string;
  subTitle?: string;
  role?: string;
  start?: string;
  end?: string;
  description?: string;
  descriptionItems?: string[];
  subItems?: { label?: string; value?: string }[];
};

/** 条目型内容的展示键：title 主标题、sub 副标题、period 起止时间、description 描述 */
const ENTRY_KEYS: Record<string, { title: (keyof EntryContent)[]; sub: (keyof EntryContent)[] }> = {
  education: { title: ["school"], sub: ["degree", "field"] },
  work: { title: ["company"], sub: ["title"] },
  projects: { title: ["name"], sub: ["role"] },
  custom: { title: ["title"], sub: ["subTitle"] },
};

/** 生成与提交复核共用严格读取；编辑器继续使用 loadResume 的修复预览。 */
export function loadResumeForModel(id: number, versionId?: number | null): ResumeWithModules | null {
  try {
    const data = loadResume(id, versionId);
    if (!data) return null;
    if (versionId == null) {
      // 合法 JSON 的错误字段形状也可能被 normalizeContent 清空，必须核对原始存储。
      const rows = getDb().prepare("SELECT module_key, type, label, content FROM resume_modules WHERE resume_id = ? ORDER BY sort, id")
        .all(id) as { module_key: string; type: string; label: string; content: string }[];
      assertResumeModelModules(rows.map(row => ({ key: row.module_key, type: row.type, label: row.label,
        content: row.type === "basic" ? null : JSON.parse(row.content),
      })));
    }
    assertResumeModelModules(data.modules);
    // 基本身份和排版不进入模型材料；只拒绝职业模块的损坏空回退。
    if (data.modules.some(module => module.type !== "basic" && data.corruptedKeys.includes(module.key))) {
      throw new ResumeContextError();
    }
    return data;
  } catch (error) {
    // 发布快照 JSON 或字段形状无法读取时，生成与提交复核使用同一错误类型。
    if (error instanceof SyntaxError || error instanceof TypeError) throw new ResumeContextError();
    throw error;
  }
}

/** 供 LLM 使用的职业经历与技能；基本身份、联系方式和精确位置不参与模型任务 */
export function loadResumeContext(id: number, versionId?: number | null): string {
  const data = loadResumeForModel(id, versionId);
  if (!data) throw new ResumeNotFoundError();
  return formatResumeContext(data.modules);
}

/** 当前简历、发布版本与投递快照共用的职业字段白名单；不修改原模块。 */
export function formatResumeContext(modules: readonly Pick<ModuleData, "type" | "label" | "content">[]): string {
  const records = resumeContextRecords(modules);
  return records.length ? JSON.stringify(records) : "";
}

function resumeContextRecords(modules: readonly Pick<ModuleData, "type" | "label" | "content">[]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const resumeModule of modules) {
    const entryKeys = ENTRY_KEYS[resumeModule.type];
    if (entryKeys) {
      const items = (Array.isArray(resumeModule.content) ? resumeModule.content : []) as EntryContent[];
      const entries = items.map(item => {
        const fields = [...entryKeys.title, ...entryKeys.sub, "start" as const, "end" as const, "description" as const];
        const entry: Record<string, unknown> = Object.fromEntries(fields.map(key => [key, typeof item[key] === "string" ? item[key] : ""]));
        if (Array.isArray(item.descriptionItems) && item.descriptionItems.length) entry.descriptionItems = item.descriptionItems.filter(value => typeof value === "string");
        entry.subItems = (item.subItems ?? []).map(sub => ({
          label: typeof sub.label === "string" ? sub.label : "",
          value: typeof sub.value === "string" ? sub.value : "",
        }));
        return entry;
      }).filter(hasResumeContextText);
      if (entries.length) records.push({ type: resumeModule.type, label: resumeModule.label, entries });
    } else if (resumeModule.type === "skills") {
      const items = (resumeModule.content as { items?: string[] })?.items ?? [];
      if (hasResumeContextText(items)) records.push({ type: resumeModule.type, label: resumeModule.label, items: [...items] });
    } else if (resumeModule.type === "summary") {
      const content = resumeModule.content as { text?: string; descriptionItems?: string[] };
      const text = content?.text ?? "";
      const descriptionItems = content?.descriptionItems ?? [];
      if (text.trim() || hasResumeContextText(descriptionItems)) records.push({ type: resumeModule.type, label: resumeModule.label, text,
        ...(descriptionItems.length ? { descriptionItems: [...descriptionItems] } : {}),
      });
    }
  }
  return records;
}

function hasResumeContextText(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.some(hasResumeContextText);
  return value !== null && typeof value === "object" && Object.values(value).some(hasResumeContextText);
}

/** 引文只能来自模型实际可见的单个职业字段；模块标题和展示分隔符不是正文。 */
export function collectResumeEvidenceParts(modules: readonly Pick<ModuleData, "type" | "label" | "content">[]): string[] {
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.trim()) parts.push(value);
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(collect);
  };
  // 与模型输入共用白名单，不从原模块递归收集内部标识或基本身份字段。
  for (const record of resumeContextRecords(modules)) {
    for (const key of ["entries", "items", "text", "descriptionItems"]) collect(record[key]);
  }
  return parts;
}

/** 排雷报告展示与原文引用使用的职业文本；模型输入使用上面的结构化记录。 */
export function formatResumeEvidenceText(modules: readonly Pick<ModuleData, "type" | "label" | "content">[]): string {
  const parts: string[] = [];

  for (const m of modules) {
    const entryKeys = ENTRY_KEYS[m.type];
    if (entryKeys) {
      const items = (Array.isArray(m.content) ? m.content : []) as EntryContent[];
      const lines = items
        .map((it) => {
          const fields = [...entryKeys.title, ...entryKeys.sub, "start" as const, "end" as const, "description" as const]
            .map((k) => (typeof it[k] === "string" ? it[k]?.trim() : ""));
          // 旧快照可能只保存分条；展示和引文仍保留模型能读取的每条原文。
          const extraDescriptions = (it.descriptionItems ?? []).filter(text => typeof text === "string" && text.trim() && !it.description?.includes(text));
          const subItems = (it.subItems ?? []).map((item) => [item.label, item.value]
            .map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean).join("："));
          return [...fields, ...extraDescriptions, ...subItems].filter(Boolean).join(" | ");
        })
        .filter(Boolean);
      if (lines.length) parts.push(`${m.label}：\n${lines.map((s) => `- ${s}`).join("\n")}`);
      continue;
    }
    if (m.type === "skills") {
      const items = (m.content as { items?: string[] })?.items ?? [];
      if (items.length) parts.push(`${m.label}：${items.join("、")}`);
      continue;
    }
    if (m.type === "summary") {
      const content = m.content as { text?: string; descriptionItems?: string[] };
      const rawText = content?.text ?? "";
      const extraDescriptions = (content?.descriptionItems ?? []).filter(text => typeof text === "string" && text.trim() && !rawText.includes(text));
      const text = [rawText.trim(), ...extraDescriptions].filter(Boolean).join("\n");
      if (text) parts.push(`${m.label}：${text}`);
      continue;
    }
  }
  return parts.join("\n\n");
}
