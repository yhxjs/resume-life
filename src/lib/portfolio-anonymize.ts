import {
  anonymizeResumeModules,
  replaceSensitiveText,
  maskPersonName,
  type AnonymizeConfig,
  type CustomSensitiveRule,
} from "./resume-anonymize";
import type {
  AssembledPortfolioData,
  AssembledPortfolioProject,
} from "./portfolio-types";
import type { ProjectSummary } from "./summary";
import { assertPortfolioSourceBytes } from "./portfolio-export-budget";

export interface SafePortfolioProject extends AssembledPortfolioProject {
  safeSummary: ProjectSummary;
}

export interface SafePortfolioData extends Omit<AssembledPortfolioData, "projects"> {
  projects: SafePortfolioProject[];
  candidateName: string;
  candidateTitle: string;
}

export function anonymizeProjectSummary(
  summary: ProjectSummary,
  config: AnonymizeConfig,
  onReplacement?: (rule: CustomSensitiveRule) => void
): ProjectSummary {
  if (!config.customRules || config.customRules.length === 0) {
    return summary;
  }

  const clean = (text: string) => replaceSensitiveText(text, config.customRules, onReplacement);

  return {
    overview: clean(summary.overview || ""),
    architecture: clean(summary.architecture || ""),
    highlights: clean(summary.highlights || ""),
    responsibilities: clean(summary.responsibilities || ""),
    challenges: clean(summary.challenges || ""),
    techStack: clean(summary.techStack || ""),
    brief: clean(summary.brief || ""),
    achievements: (summary.achievements || []).map(clean),
  };
}

export function processPortfolioAnonymization(
  data: AssembledPortfolioData
): SafePortfolioData {
  const { resumeSnapshot, anonymizeConfig, projects } = data;
  let reservedBytes = Buffer.byteLength(JSON.stringify(data));
  // 替换前预留新增文本；保守地不扣除被替换内容，避免替换链先膨胀再被后续规则缩短。
  const reserveReplacement = (rule: CustomSensitiveRule) => {
    reservedBytes += Buffer.byteLength(rule.replacement);
    assertPortfolioSourceBytes(reservedBytes);
  };
  if (anonymizeConfig.name.enabled && anonymizeConfig.name.mode === "placeholder") {
    reservedBytes += resumeSnapshot.modules.filter((module) => module.type === "basic").length
      * Buffer.byteLength(anonymizeConfig.name.customPlaceholder ?? "");
  }
  assertPortfolioSourceBytes(reservedBytes);

  const safeModules = anonymizeResumeModules(resumeSnapshot.modules, anonymizeConfig, reserveReplacement);
  const rawBasic = resumeSnapshot.modules.find((m) => m.type === "basic")?.content as { name?: string } | undefined;
  const originalName = typeof rawBasic?.name === "string" ? rawBasic.name.trim() : "";
  const titleRules = [...anonymizeConfig.customRules];
  if (anonymizeConfig.name.enabled && originalName && anonymizeConfig.name.mode !== "keep") {
    titleRules.push({
      id: "portfolio-name", source: originalName,
      replacement: maskPersonName(originalName, anonymizeConfig.name.mode, anonymizeConfig.name.customPlaceholder),
      matchCase: true,
    });
  }
  const cleanTitle = (text: string) => replaceSensitiveText(text, titleRules, reserveReplacement);

  const safeSnapshot = {
    ...resumeSnapshot,
    title: cleanTitle(resumeSnapshot.title),
    modules: safeModules,
  };

  const basicModule = safeModules.find((m) => m.type === "basic");
  const basicContent = (basicModule?.content ?? {}) as { name?: string; title?: string };

  const candidateName = basicContent.name?.trim() || "某候选人";
  const candidateTitle = basicContent.title?.trim() || "";

  const safeProjects: SafePortfolioProject[] = projects.map((p) => {
    let safeName = p.name;
    if (anonymizeConfig.customRules && anonymizeConfig.customRules.length > 0) {
      safeName = replaceSensitiveText(p.name, anonymizeConfig.customRules, reserveReplacement);
    }
    const safeSummary = anonymizeProjectSummary(p.summary, anonymizeConfig, reserveReplacement);
    return {
      ...p,
      name: safeName,
      safeSummary,
    };
  });

  return {
    ...data,
    siteTitle: cleanTitle(data.siteTitle),
    siteSubtitle: cleanTitle(data.siteSubtitle),
    resumeSnapshot: safeSnapshot,
    projects: safeProjects,
    candidateName,
    candidateTitle,
  };
}
