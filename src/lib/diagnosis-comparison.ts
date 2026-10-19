import type { DiagnosisRecord, DiagnosisSnapshot } from "@/lib/diagnosis";
import { DIMENSIONS, type ScoreMap } from "@/lib/scores";
import { resumeToMarkdown } from "@/lib/resume-markdown";

export type DiagnosisContentChange = {
  key: string;
  label: string;
  before: string | null;
  after: string | null;
  status: "unchanged" | "changed" | "added" | "removed";
  moved?: boolean;
};

export function compareDiagnosisSnapshots(before: DiagnosisSnapshot | null, after: DiagnosisSnapshot | null): DiagnosisContentChange[] | null {
  if (!before || !after) return null;
  const oldModules = new Map(before.modules.map((module, index) => [module.key, { module, index }]));
  const newModules = new Map(after.modules.map((module, index) => [module.key, { module, index }]));
  const rows: DiagnosisContentChange[] = [{ key: "title", label: "简历名称", before: before.title, after: after.title,
    status: before.title === after.title ? "unchanged" : "changed" }];
  for (const key of new Set([...oldModules.keys(), ...newModules.keys()])) {
    const old = oldModules.get(key);
    const next = newModules.get(key);
    const oldText = old ? resumeToMarkdown("", [old.module]).trim() : null;
    const newText = next ? resumeToMarkdown("", [next.module]).trim() : null;
    const moved = Boolean(old && next && old.index !== next.index);
    rows.push({ key, label: next?.module.label ?? old!.module.label, before: oldText, after: newText, moved,
      status: oldText === null ? "added" : newText === null ? "removed" : oldText !== newText || moved ? "changed" : "unchanged" });
  }
  return rows;
}

export function compareDiagnosisScores(before: DiagnosisRecord | null, after: DiagnosisRecord) {
  if (!before?.report || !after.report || before.job_id !== after.job_id) return null;
  return {
    match: Math.round((after.report.match - before.report.match) * 10) / 10,
    modules: after.report.modules.flatMap((module) => {
      const old = before.report!.modules.find((entry) => entry.moduleKey === module.moduleKey);
      if (!old) return [];
      return [{ moduleKey: module.moduleKey, label: module.label,
        scores: Object.fromEntries(DIMENSIONS.map(({ key }) => [key, module.scores[key] - old.scores[key]])) as ScoreMap }];
    }),
  };
}
