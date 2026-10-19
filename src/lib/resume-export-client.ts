import type { ResumeExportLayoutEntry } from "@/lib/resume-export-check";
import { apiFetch } from "@/lib/api-fetch";

/** 读取原始纸面坐标，消除编辑器缩放的影响，不只检查 paper 的最小高度。 */
export function measureResumeExportLayout(paper: HTMLElement | null): ResumeExportLayoutEntry[] {
  if (!paper) return [];
  const root = paper.getBoundingClientRect();
  if (!root.width || !paper.offsetWidth) return [];
  const scale = root.width / paper.offsetWidth;
  return Array.from(paper.querySelectorAll<HTMLElement>("[data-resume-module]")).flatMap((module) => {
    const entries = Array.from(module.querySelectorAll<HTMLElement>("[data-resume-entry]"));
    return (entries.length ? entries : [module]).map((element) => {
      const rect = element.getBoundingClientRect();
      return { moduleKey: module.dataset.resumeModule!,
        entryIndex: element.dataset.resumeEntry === undefined ? undefined : Number(element.dataset.resumeEntry),
        top: (rect.top - root.top) / scale, bottom: (rect.bottom - root.top) / scale };
    });
  });
}

export async function downloadCheckedResume(id: string | number, title: string, format: "pdf" | "md" | "docx", confirmedIssueIds: string[], options: { anonymizeConfig?: unknown; skipExportCheck?: boolean } = {}) {
  const response = await apiFetch("/api/resumes/" + id + "/export" + (format === "md" ? "" : "/" + format), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmedIssueIds, ...options }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || "导出失败，请稍后重试");
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  const docxFilename = format === "docx" ? response.headers.get("Content-Disposition")?.match(/filename\*=UTF-8''([^;]+)/i)?.[1] : undefined;
  anchor.download = docxFilename ? decodeURIComponent(docxFilename) : (title || "简历") + "." + format;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
