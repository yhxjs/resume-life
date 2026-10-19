import type { ModuleData } from "./modules";
import type { ResumeStyle, ResumeStyleOverrides } from "./templates";

export type ResumeSnapshot = {
  title: string;
  template: string;
  style_overrides: ResumeStyleOverrides;
  resolved_style: ResumeStyle;
  modules: Omit<ModuleData, "revision">[];
};

export type ResumeVersion = {
  id: number;
  resume_id: number;
  version: number;
  parent_id: number | null;
  name: string;
  description: string;
  created_at: string;
  snapshot: ResumeSnapshot;
};

export type ResumeVersionSummary = Pick<ResumeVersion, "id" | "version" | "name">;

/** 版本树列表项：不含 snapshot（单份可达 2MiB，快照经 versions/[versionId] 按需获取） */
export type ResumeVersionListItem = Omit<ResumeVersion, "snapshot">;
