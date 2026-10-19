import { getDb } from "./db";
import { loadResume } from "./resumes";
import { getResumeVersion } from "./resume-versions";
import { parseSummary, ProjectSummaryCorruptError, type ProjectSummary } from "./summary";
import type { ResumeSnapshot } from "./resume-version-types";
import { DEFAULT_ANONYMIZE_CONFIG } from "./resume-anonymize";
import { normalizePortfolioLink } from "./portfolio-links";
import { isPortfolioTemplate } from "./portfolio-templates";
import { resolveStyle } from "./templates";
import { CorruptedTemplateError, loadCustomTemplate } from "./custom-templates";
import { PortfolioError, MAX_PORTFOLIO_PROJECTS, assertPortfolioSourceBytes } from "./portfolio-export-budget";
export { PortfolioError } from "./portfolio-export-budget";
import type {
  PortfolioSourcesData,
  PortfolioExportOptions,
  AssembledPortfolioData,
  AssembledPortfolioProject,
} from "./portfolio-types";

function parsePortfolioSummary(project: { id: number; summary: string }): ProjectSummary {
  try {
    return parseSummary(project.summary);
  } catch (error) {
    if (error instanceof ProjectSummaryCorruptError) {
      throw new PortfolioError(`项目 #${project.id} 的总结数据损坏，请先修复项目档案或恢复有效备份`, 422);
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function assertPortfolioExportOptions(value: unknown): asserts value is PortfolioExportOptions {
  if (!isRecord(value)) throw new PortfolioError("请求体格式无效");
  if (!isPositiveId(value.resumeId)) throw new PortfolioError("请选择一份有效简历");
  if (value.versionId !== undefined && value.versionId !== null && !isPositiveId(value.versionId)) {
    throw new PortfolioError("简历版本参数无效");
  }

  if (value.selectedProjects !== undefined) {
    if (!Array.isArray(value.selectedProjects)) throw new PortfolioError("项目列表必须是数组");
    if (value.selectedProjects.length > MAX_PORTFOLIO_PROJECTS) {
      throw new PortfolioError(`每次最多导出 ${MAX_PORTFOLIO_PROJECTS} 个项目`);
    }
    const selectedIds = new Set<number>();
    for (const item of value.selectedProjects) {
      if (!isRecord(item) || !isPositiveId(item.projectId)
        || (item.featured !== undefined && typeof item.featured !== "boolean")
        || (item.order !== undefined && (typeof item.order !== "number" || !Number.isFinite(item.order)))) {
        throw new PortfolioError("项目选择参数无效");
      }
      if (selectedIds.has(item.projectId)) throw new PortfolioError(`项目 #${item.projectId} 重复选择`);
      selectedIds.add(item.projectId);
      if (item.customLinks !== undefined) {
        if (!isRecord(item.customLinks)) throw new PortfolioError("项目链接参数无效");
        for (const key of ["demoUrl", "repoUrl", "docUrl"]) {
          if (item.customLinks[key] !== undefined && typeof item.customLinks[key] !== "string") {
            throw new PortfolioError("项目链接必须是字符串");
          }
          if (typeof item.customLinks[key] === "string" && normalizePortfolioLink(item.customLinks[key]) === null) {
            throw new PortfolioError("项目链接必须是完整的 HTTP/HTTPS 地址");
          }
        }
      }
    }
  }

  for (const key of ["siteTitle", "siteSubtitle", "accentColor"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new PortfolioError("作品集展示参数必须是字符串");
    }
  }
  if (value.accentColor !== undefined && !/^#[0-9a-f]{6}$/i.test(value.accentColor as string)) {
    throw new PortfolioError("作品集主色调必须是六位十六进制颜色（例如 #b8722c）");
  }
  if (value.themeMode !== undefined && !["auto", "light", "dark"].includes(value.themeMode as string)) {
    throw new PortfolioError("作品集主题参数无效");
  }
  if (value.siteTemplate !== undefined && !isPortfolioTemplate(value.siteTemplate)) {
    throw new PortfolioError("主页模板参数无效");
  }

  if (value.anonymizeConfig !== undefined) {
    const config = value.anonymizeConfig;
    if (!isRecord(config)) throw new PortfolioError("匿名配置格式无效");
    const modes = {
      name: ["surname_only", "placeholder", "keep"],
      phone: ["prefix_only", "mask_middle", "placeholder", "remove"],
      email: ["mask_account", "placeholder", "remove"],
      location: ["city_only", "placeholder", "remove"],
      birthday: ["year_only", "placeholder", "remove"],
      links: ["domain_only", "remove"],
    };
    for (const [key, allowedModes] of Object.entries(modes)) {
      const section = config[key];
      if (!isRecord(section) || typeof section.enabled !== "boolean"
        || typeof section.mode !== "string" || !allowedModes.includes(section.mode)) {
        throw new PortfolioError(`匿名配置 ${key} 参数无效`);
      }
    }
    const name = config.name as Record<string, unknown>;
    if (name.customPlaceholder !== undefined && typeof name.customPlaceholder !== "string") {
      throw new PortfolioError("匿名名字占位符必须是字符串");
    }
    if (!isRecord(config.avatar) || typeof config.avatar.enabled !== "boolean") {
      throw new PortfolioError("匿名头像配置无效");
    }
    if (!Array.isArray(config.customRules)) throw new PortfolioError("匿名自定义规则必须是数组");
    for (const rule of config.customRules) {
      if (!isRecord(rule) || typeof rule.id !== "string" || typeof rule.source !== "string"
        || typeof rule.replacement !== "string"
        || (rule.matchCase !== undefined && typeof rule.matchCase !== "boolean")) {
        throw new PortfolioError("匿名自定义规则参数无效");
      }
    }
  }
}

/**
 * 加载所有可供组合为作品集的简历（及其已发布版本）和项目库列表
 */
export function loadPortfolioSources(): PortfolioSourcesData {
  const db = getDb();

  const resumeRows = db
    .prepare("SELECT id, title, updated_at FROM resumes ORDER BY updated_at DESC")
    .all() as Array<{ id: number; title: string; updated_at: string }>;

  const versionRows = db
    .prepare(
      "SELECT id, resume_id, version, name, description, created_at FROM resume_versions ORDER BY version DESC"
    )
    .all() as Array<{
      id: number;
      resume_id: number;
      version: number;
      name: string;
      description: string;
      created_at: string;
    }>;

  const versionMap = new Map<number, typeof versionRows>();
  for (const v of versionRows) {
    const list = versionMap.get(v.resume_id) ?? [];
    list.push(v);
    versionMap.set(v.resume_id, list);
  }

  const resumes = resumeRows.map((r) => ({
    id: r.id,
    title: r.title,
    updated_at: r.updated_at,
    versions: (versionMap.get(r.id) ?? []).map((v) => ({
      id: v.id,
      version: v.version,
      name: v.name,
      description: v.description,
      created_at: v.created_at,
    })),
  }));

  const projectRows = db
    .prepare(
      "SELECT id, name, summary, summary_updated_at, updated_at FROM projects ORDER BY updated_at DESC"
    )
    .all() as Array<{
      id: number;
      name: string;
      summary: string;
      summary_updated_at: string;
      updated_at: string;
    }>;

  const projects = projectRows.map((p) => {
    const parsed = parsePortfolioSummary(p);
    return {
      id: p.id,
      name: p.name,
      summary: parsed,
      summary_updated_at: p.summary_updated_at,
      updated_at: p.updated_at,
    };
  });

  return { resumes, projects };
}

/**
 * 组装作品集所需的所有数据：解析简历快照 + 关联项目库五维档案
 */
export function assemblePortfolioData(options: unknown): AssembledPortfolioData {
  assertPortfolioExportOptions(options);
  const { resumeId, versionId, selectedProjects = [] } = options;

  let snapshot: ResumeSnapshot | null = null;
  if (versionId) {
    const ver = getResumeVersion(resumeId, versionId);
    if (!ver) {
      throw new PortfolioError(`未找到指定的简历版本 (id: ${versionId})`, 404);
    }
    snapshot = ver.snapshot;
  } else {
    const loaded = loadResume(resumeId);
    if (!loaded) {
      throw new PortfolioError(`未找到指定的简历 (id: ${resumeId})`, 404);
    }
    if (loaded.resume.styleCorrupted) {
      throw new PortfolioError("简历排版数据损坏，请修复并保存排版后再导出作品集", 422);
    }
    if (loaded.corruptedKeys.length > 0) {
      throw new PortfolioError("简历包含损坏模块，请先修复简历草稿或恢复有效备份再导出作品集", 422);
    }
    let resolvedStyle;
    const customId = /^custom:(\d+)$/.exec(loaded.resume.template)?.[1];
    try {
      const customs = customId ? [loadCustomTemplate(Number(customId))] : [];
      resolvedStyle = resolveStyle(loaded.resume.template, customs, loaded.resume.style_overrides);
    } catch (error) {
      if (error instanceof CorruptedTemplateError) throw new PortfolioError(error.message, 422);
      throw error;
    }
    snapshot = {
      title: loaded.resume.title,
      template: loaded.resume.template,
      style_overrides: loaded.resume.style_overrides,
      resolved_style: resolvedStyle,
      modules: loaded.modules,
    };
  }

  const db = getDb();
  const assembledProjects: AssembledPortfolioProject[] = [];
  const baseBytes = Buffer.byteLength(JSON.stringify(snapshot)) + Buffer.byteLength(JSON.stringify(options));
  assertPortfolioSourceBytes(baseBytes);

  if (selectedProjects.length > 0) {
    const projectIds = [...new Set(selectedProjects.map((item) => item.projectId))];
    const placeholders = projectIds.map(() => "?").join(",");
    // 先在 SQLite 中计量 UTF-8 字节，避免先加载并解析超大总结。
    const budget = db.prepare(`SELECT COALESCE(SUM(length(CAST(name AS BLOB)) + length(CAST(summary AS BLOB))), 0) AS bytes FROM projects WHERE id IN (${placeholders})`)
      .get(...projectIds) as { bytes: number };
    assertPortfolioSourceBytes(baseBytes + budget.bytes);
    const rows = db
      .prepare(`SELECT id, name, summary FROM projects WHERE id IN (${placeholders})`)
      .all(...projectIds) as Array<{ id: number; name: string; summary: string }>;
    const projectMap = new Map(rows.map((row) => [row.id, row]));

    for (const item of selectedProjects) {
      const row = projectMap.get(item.projectId);
      if (!row) throw new PortfolioError(`项目 #${item.projectId} 已不存在，请刷新项目列表后重新导出`, 409);

      const summary = parsePortfolioSummary(row);

      assembledProjects.push({
        id: row.id,
        name: row.name,
        summary,
        customLinks: item.customLinks ?? {},
        featured: item.featured ?? true,
      });
    }
  }

  const anonymizeConfig = options.anonymizeConfig ?? DEFAULT_ANONYMIZE_CONFIG;

  return {
    siteTitle: options.siteTitle || `${snapshot.title} - 个人作品集`,
    siteSubtitle: options.siteSubtitle || "",
    accentColor: options.accentColor || "#b8722c",
    themeMode: options.themeMode || "auto",
    siteTemplate: options.siteTemplate ?? "flow",
    resumeSnapshot: snapshot,
    projects: assembledProjects,
    anonymizeConfig,
  };
}
