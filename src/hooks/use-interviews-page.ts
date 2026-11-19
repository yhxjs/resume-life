"use client";

import { useEffect, useState } from "react";
import { useCursorList } from "@/hooks/use-cursor-list";
import { useResumeOptions, type ResumeOption } from "@/hooks/use-resume-options";
import { useResumeVersionSelection } from "@/hooks/use-resume-version-selection";
import { useRecordDeletion } from "@/hooks/use-record-deletion";
import { interviewDeletionTitle, validateExistingInterview, validateExistingInterviewSeries } from "@/lib/interview-history";
import type { ResumeVersionBinding } from "@/components/resume/resume-version-badge";

export type ResumeBrief = ResumeOption;
export type InterviewItem = ResumeVersionBinding & {
  id: number;
  jd: string;
  rounds: number;
  style: string;
  status: string;
  created_at: string;
  resume_title: string;
  answered: number;
};
export type SeriesItem = ResumeVersionBinding & {
  id: number;
  jd: string;
  status: string;
  created_at: string;
  resume_title: string;
  rounds_done: number;
  rounds_total: number;
  final_overall: number | null;
};

export function useInterviewsPage(queryResumeId: string | null, queryResumeVersionId: string | null = null) {
  const [selection, setSelection] = useState<{ key: string; id: number | "" } | null>(null);
  const [keyword, setKeyword] = useState("");

  const { resumes, resumesError, reloadResumes } = useResumeOptions();
  const selectionKey = JSON.stringify([queryResumeId, queryResumeVersionId]);
  const candidate = selection?.key === selectionKey ? selection.id
    : queryResumeId !== null ? Number(queryResumeId) : resumes?.[0]?.id ?? "";
  const resumeId: number | "" = typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0 && resumes?.some((resume) => resume.id === candidate) ? candidate : "";
  const { resumeVersionId, setResumeVersionId } = useResumeVersionSelection(
    resumes?.find((resume) => resume.id === resumeId),
    queryResumeId !== null && Number(queryResumeId) === resumeId && queryResumeVersionId !== null ? Number(queryResumeVersionId) : null,
  );
  const buildListUrl = (path: string, cursor?: string) => {
    const params = new URLSearchParams();
    if (keyword.trim()) params.set("q", keyword.trim());
    if (cursor) params.set("cursor", cursor);
    const query = params.toString();
    return `${path}${query ? `?${query}` : ""}`;
  };
  const singles = useCursorList<InterviewItem>({
    queryKey: `interviews:single:${keyword.trim()}`,
    delay: 250,
    buildUrl: (cursor) => buildListUrl("/api/interviews", cursor),
  });
  const series = useCursorList<SeriesItem>({
    queryKey: `interviews:series:${keyword.trim()}`,
    delay: 250,
    buildUrl: (cursor) => buildListUrl("/api/interviews/series", cursor),
  });
  const singleDeletion = useRecordDeletion({
    baseUrl: "/api/interviews", confirmTitle: "删除面试", recordLabel: "面试", listLabel: "面试历史",
    confirmMessage: (id, title) => `确定删除面试 #${id}「${title}」？该场全部对话与报告会一并删除，已收藏错题及已生成追练题保留。`,
    validateExisting: validateExistingInterview,
  }, singles.reload);
  const seriesDeletion = useRecordDeletion({
    baseUrl: "/api/interviews/series", confirmTitle: "删除进阶面试", recordLabel: "进阶面试", listLabel: "进阶面试历史",
    confirmMessage: (id, title) => `确定删除进阶面试 #${id}「${title}」？三轮对话记录与总评会一并删除，已收藏错题及已生成的追练题保留。`,
    validateExisting: validateExistingInterviewSeries,
  }, series.reload);
  const canDelete = () => singleDeletion.canStart() && seriesDeletion.canStart();
  const items = singles.items?.filter(item => !singleDeletion.deletedIds.has(item.id)) ?? null;
  const seriesItems = series.items?.filter(item => !seriesDeletion.deletedIds.has(item.id)) ?? null;
  // 原列表仍包含已确认删除的条目时同步扣除；服务端刷新已移除后不重复扣减。
  const removedSingles = singles.items?.filter(item => singleDeletion.deletedIds.has(item.id)).length ?? 0;
  const removedSeries = series.items?.filter(item => seriesDeletion.deletedIds.has(item.id)).length ?? 0;

  // 仅固定当前来源的首次选择；刷新不重置手选，指定材料缺失时也不借用另一份。
  useEffect(() => {
    if (!resumes || selection?.key === selectionKey || (candidate === "" && queryResumeId === null)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelection({ key: selectionKey, id: candidate });
  }, [resumes, selection?.key, selectionKey, candidate, queryResumeId]);

  async function remove(id: number) {
    if (!canDelete()) return;
    const item = items?.find(item => item.id === id);
    if (item) await singleDeletion.remove(id, interviewDeletionTitle(item));
  }

  async function removeSeries(id: number) {
    if (!canDelete()) return;
    const item = seriesItems?.find(item => item.id === id);
    if (item) await seriesDeletion.remove(id, interviewDeletionTitle(item));
  }

  return {
    resumes,
    resumesError,
    reloadResumes,
    items,
    seriesItems,
    totalCount: singles.total !== null && series.total !== null ? Math.max(0, singles.total - removedSingles) + Math.max(0, series.total - removedSeries) : null,
    deletion: { single: singleDeletion, series: seriesDeletion, busy: singleDeletion.busy || seriesDeletion.busy, canStart: canDelete },
    loadError: singles.listError || series.listError,
    retryLoad: () => {
      if (singles.listError) singles.reload();
      if (series.listError) series.reload();
    },
    reloadHistory: () => {
      singles.reload();
      series.reload();
    },
    itemsHasMore: singles.hasMore,
    itemsLoadingMore: singles.loadingMore,
    itemsLoadFailed: typeof singles.failedCursor === "string",
    loadMoreItems: singles.loadMore,
    seriesHasMore: series.hasMore,
    seriesLoadingMore: series.loadingMore,
    seriesLoadFailed: typeof series.failedCursor === "string",
    loadMoreSeries: series.loadMore,
    resumeId,
    setResumeId: (id: number) => setSelection({ key: selectionKey, id }),
    resumeVersionId,
    setResumeVersionId,
    keyword,
    setKeyword,
    remove,
    removeSeries,
  };
}
