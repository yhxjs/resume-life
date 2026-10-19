import { RESUME_SUMMARY_LABELS, SUMMARY_SECTIONS, type ProjectSummary } from "./summary";

export type SummaryUnitKey = Exclude<keyof ProjectSummary, "achievements"> | `achievement:${number}`;
export type SummaryChange = {
  key: SummaryUnitKey;
  label: string;
  status: "new" | "changed" | "conflict";
  previous: string;
  next: string;
};
export type SummaryAiBaseline = Record<string, string>;

const STRING_UNITS = [
  ...SUMMARY_SECTIONS,
  { key: "techStack", label: RESUME_SUMMARY_LABELS.techStack },
  { key: "brief", label: RESUME_SUMMARY_LABELS.brief },
] as const;

function classify(key: SummaryUnitKey, previous: string, next: string, baseline: SummaryAiBaseline): SummaryChange["status"] {
  if (!previous && next) return "new";
  if (Object.hasOwn(baseline, key) && previous !== baseline[key] && next !== previous) return "conflict";
  return "changed";
}

export function compareProjectSummaries(
  current: ProjectSummary,
  generated: ProjectSummary,
  baseline: SummaryAiBaseline,
): SummaryChange[] {
  const changes: SummaryChange[] = [];
  for (const unit of STRING_UNITS) {
    const previous = current[unit.key];
    const next = generated[unit.key];
    if (previous !== next) changes.push({ key: unit.key, label: unit.label, status: classify(unit.key, previous, next, baseline), previous, next });
  }
  for (let index = 0; index < Math.max(current.achievements.length, generated.achievements.length); index++) {
    const key = `achievement:${index}` as const;
    const previous = current.achievements[index] ?? "";
    const next = generated.achievements[index] ?? "";
    if (previous !== next) changes.push({ key, label: `${RESUME_SUMMARY_LABELS.achievements} ${index + 1}`, status: classify(key, previous, next, baseline), previous, next });
  }
  return changes;
}

export function adoptSummaryChanges(
  current: ProjectSummary,
  generated: ProjectSummary,
  baseline: SummaryAiBaseline,
  selectedKeys: readonly SummaryUnitKey[],
): { summary: ProjectSummary; aiBaseline: SummaryAiBaseline } {
  const selected = new Set(selectedKeys);
  const summary: ProjectSummary = { ...current, achievements: [] };
  const aiBaseline: SummaryAiBaseline = {};
  for (const unit of STRING_UNITS) {
    summary[unit.key] = selected.has(unit.key) ? generated[unit.key] : current[unit.key];
    if (selected.has(unit.key)) aiBaseline[unit.key] = generated[unit.key];
    else if (Object.hasOwn(baseline, unit.key)) aiBaseline[unit.key] = baseline[unit.key]!;
  }
  for (let index = 0; index < Math.max(current.achievements.length, generated.achievements.length); index++) {
    const key = `achievement:${index}` as const;
    const accepted = selected.has(key);
    const value = accepted ? generated.achievements[index] : current.achievements[index];
    if (!value) continue;
    const outputKey = `achievement:${summary.achievements.length}`;
    summary.achievements.push(value);
    if (accepted) aiBaseline[outputKey] = value;
    else if (Object.hasOwn(baseline, key)) aiBaseline[outputKey] = baseline[key]!;
  }
  return { summary, aiBaseline };
}
