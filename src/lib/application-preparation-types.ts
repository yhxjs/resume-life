import type { Application } from "@/lib/applications-types";
import type { CursorPage } from "@/lib/cursor-pagination";

export const PREPARATION_KINDS = ["diagnosis", "intro", "portrait", "interview", "series", "notebook"] as const;
export type PreparationKind = (typeof PREPARATION_KINDS)[number];
export const PREPARATION_LABELS: Record<PreparationKind, string> = {
  diagnosis: "简历诊断", intro: "自我介绍", portrait: "JD 考点画像",
  interview: "模拟面试", series: "进阶面试", notebook: "错题",
};

export type PreparationResource = {
  id: number;
  title: string;
  summary: string;
  created_at: string;
  resume_id: number | null;
  href: string | null;
  linked: boolean;
};
export type PreparationTask = { id: number; title: string; done: boolean; due_time?: string; created_at: string };
export type ApplicationPreparation = {
  application: Application;
  resources: Record<PreparationKind, CursorPage<PreparationResource>>;
  tasks: PreparationTask[];
};
