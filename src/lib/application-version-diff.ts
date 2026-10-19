import type { ApplicationVersions } from "@/lib/applications-types";
import type { ModuleData } from "@/lib/modules";
import { resumeToMarkdown } from "@/lib/resume-markdown";

export type ApplicationDiffRow = {
  key: string;
  label: string;
  before: string | null;
  after: string | null;
  status: "unchanged" | "added" | "removed" | "changed";
  moved?: boolean;
};

function diffRow(key: string, label: string, before: string | null, after: string | null): ApplicationDiffRow {
  const status = before === after ? "unchanged" : before === null ? "added" : after === null ? "removed" : "changed";
  return { key, label, before, after, status };
}

function moduleText(module: ModuleData): string {
  const markdown = resumeToMarkdown("", [module]).replace(/^# 简历\n\n/, "").trim();
  return module.type === "basic" ? `## ${module.label}\n\n${markdown}`.trim() : markdown || `## ${module.label}`;
}

/** 按稳定模块 key 比较正文和排列，避免模块插入导致后续内容被错位配对。 */
export function compareApplicationVersions(versions: ApplicationVersions): ApplicationDiffRow[] {
  const { submitted, current } = versions;
  if (!submitted) return [];
  const before = submitted.resume?.modules ?? [];
  const after = current.resume?.modules ?? [];
  const beforeByKey = new Map(before.map((module, index) => [module.key, { module, index }]));
  const afterByKey = new Map(after.map((module, index) => [module.key, { module, index }]));
  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
  const rows = [diffRow("title", "简历名称", submitted.resume?.title ?? null, current.resume?.title ?? null)];
  for (const key of keys) {
    const old = beforeByKey.get(key);
    const latest = afterByKey.get(key);
    const row = diffRow(`module:${key}`, latest?.module.label ?? old!.module.label,
      old ? moduleText(old.module) : null, latest ? moduleText(latest.module) : null);
    if (old && latest && old.index !== latest.index) {
      row.moved = true;
      row.status = "changed";
    }
    rows.push(row);
  }
  rows.push(diffRow("jd", "岗位 JD", submitted.jd, current.jd));
  return rows;
}
