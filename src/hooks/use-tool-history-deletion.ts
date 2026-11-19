"use client";

import { useRecordDeletion } from "@/hooks/use-record-deletion";
import { parseJdPortraitResult } from "@/lib/jd-portrait";
import { parseJargonDecoderResult } from "@/lib/jargon-decoder";
import { readCareerGapRemedyDetail } from "@/lib/career-gap-remedy-detail";
import { readSalaryNegotiationHistory } from "@/lib/salary-negotiation-history";

type Kind = "jd-portraits" | "jargon-decodings" | "resume-defenses" | "salary-negotiations" | "career-gap-remedies";
function validateExisting(value: unknown, id: number, kind: Kind): void {
  if (kind === "salary-negotiations") {
    readSalaryNegotiationHistory(value, id);
    return;
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (kind === "career-gap-remedies") {
      readCareerGapRemedyDetail(value, id);
      return;
    }
    if (kind === "resume-defenses") {
      const report = row.report && typeof row.report === "object" ? row.report as Record<string, unknown> : null;
      // 这里只确认同一报告仍存在，不把历史审阅条目当作新生成结果重新校验。
      if (report?.id === id && typeof report.title === "string" && typeof report.sourceContent === "string" &&
        typeof report.targetRole === "string" && typeof report.createdAt === "string") return;
      throw new Error("读取响应不完整或记录不符");
    }
    const source = kind === "jd-portraits" ? row.jd : row.source_text;
    const parse = kind === "jd-portraits" ? parseJdPortraitResult : parseJargonDecoderResult;
    if (row.id === id && typeof source === "string" && typeof row.created_at === "string" &&
      (row.result === null || parse(JSON.stringify(row.result)))) return;
  }
  throw new Error("读取响应不完整或记录不符");
}

/** kind 在页面挂载期间固定，历史协议由各工具保留。 */
export function useToolHistoryDeletion(kind: Kind, onDeleted: () => void) {
  const label = kind === "jd-portraits" ? "考点画像" : kind === "jargon-decodings" ? "暗号解码报告" : kind === "salary-negotiations" ? "谈薪演练" : kind === "career-gap-remedies" ? "空窗沟通报告" : "简历排雷报告";
  const cascade = kind === "resume-defenses" ? "删除后相关防御演练记录将一并清除。" : kind === "salary-negotiations" ? "删除后所有谈判回合及复盘将一并清除。" : "";
  return useRecordDeletion({
    baseUrl: `/api/tools/${kind}`,
    confirmTitle: "删除历史记录",
    confirmMessage: (id, title) => `确定删除${label} #${id}「${title}」？${cascade}`,
    validateExisting: (value, id) => validateExisting(value, id, kind),
    recordLabel: "记录",
    listLabel: "历史列表",
  }, onDeleted);
}
