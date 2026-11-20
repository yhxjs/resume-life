import { SUMMARY_SECTIONS, type ProjectSummary } from "./summary";

/** Saved archive text is secondary material, never reconstructed source code. */
export function projectSummaryEvidence(summary?: ProjectSummary) {
  if (!summary) return [];
  return [
    ...SUMMARY_SECTIONS.map(({ key, label }) => ({ key: String(key), label, content: summary[key] })),
    { key: "techStack", label: "技术栈", content: summary.techStack },
    { key: "brief", label: "项目简要概述", content: summary.brief },
    ...summary.achievements.map((content, index) => ({ key: `achievement:${index}`, label: `项目成果 ${index + 1}`, content })),
  ].filter(section => section.content.trim());
}
