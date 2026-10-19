import type { AnonymizeConfig } from "./resume-anonymize";
import type { ResumeSnapshot } from "./resume-version-types";
import type { ProjectSummary } from "./summary";
import type { PortfolioTemplateId } from "./portfolio-templates";

export interface PortfolioProjectCustomLink {
  demoUrl?: string;
  repoUrl?: string;
  docUrl?: string;
}

export interface PortfolioProjectSelection {
  projectId: number;
  featured?: boolean;
  order?: number;
  customLinks?: PortfolioProjectCustomLink;
}

export interface PortfolioExportOptions {
  resumeId: number;
  versionId?: number | null;
  selectedProjects: PortfolioProjectSelection[];
  themeMode?: "auto" | "light" | "dark";
  siteTemplate?: PortfolioTemplateId;
  accentColor?: string;
  siteTitle?: string;
  siteSubtitle?: string;
  anonymizeConfig?: AnonymizeConfig;
}

export interface PortfolioSourceResumeVersion {
  id: number;
  version: number;
  name: string;
  description: string;
  created_at: string;
}

export interface PortfolioSourceProjectItem {
  id: number;
  name: string;
  summary: ProjectSummary;
  summary_updated_at: string;
  updated_at: string;
}

export interface PortfolioSourcesData {
  resumes: Array<{
    id: number;
    title: string;
    updated_at: string;
    versions: PortfolioSourceResumeVersion[];
  }>;
  projects: PortfolioSourceProjectItem[];
}

export interface AssembledPortfolioProject {
  id: number;
  name: string;
  role?: string;
  period?: string;
  summary: ProjectSummary;
  customLinks: PortfolioProjectCustomLink;
  featured: boolean;
}

export interface AssembledPortfolioData {
  siteTitle: string;
  siteSubtitle: string;
  accentColor: string;
  themeMode: "auto" | "light" | "dark";
  siteTemplate?: PortfolioTemplateId;
  resumeSnapshot: ResumeSnapshot;
  projects: AssembledPortfolioProject[];
  anonymizeConfig: AnonymizeConfig;
}
