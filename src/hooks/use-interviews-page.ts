"use client";

import { useEffect, useState } from "react";
import { alertDialog, confirmDialog } from "@/components/common/confirm-dialog";
import { useCursorList } from "@/hooks/use-cursor-list";
import { useResumeOptions, type ResumeOption } from "@/hooks/use-resume-options";
import { useResumeVersionSelection } from "@/hooks/use-resume-version-selection";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
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
  const [resumeId, setResumeId] = useState<number | "">("");
  const [keyword, setKeyword] = useState("");

  const { resumes, resumesError, reloadResumes } = useResumeOptions();
  const { resumeVersionId, setResumeVersionId } = useResumeVersionSelection(
    resumes?.find((resume) => resume.id === resumeId),
    queryResumeId && Number(queryResumeId) === resumeId && queryResumeVersionId ? Number(queryResumeVersionId) : null,
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

  // 简历列表就绪后确定当前选中项：URL 指定且存在则用之，否则落到第一份。
  // 与拉取分离，避免 queryResumeId 变化时重取列表（旧响应可能覆盖新参数下的选择）。
  // 这是「外部数据就绪 → 本地默认值」的一次性同步；规则针对的是渲染期级联重渲染，
  // 而此处只在 resumes 或 queryResumeId 变化时触发一次，故显式豁免该规则。
  useEffect(() => {
    if (!resumes || resumes.length === 0) return;
    if (queryResumeId && resumes.some((resume) => resume.id === Number(queryResumeId))) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResumeId(Number(queryResumeId));
    } else {
      setResumeId(resumes[0]!.id);
    }
  }, [resumes, queryResumeId]);

  async function remove(id: number) {
    if (!(await confirmDialog({ title: "删除面试", message: "确定删除这场面试及其全部对话记录？", danger: true }))) return;
    try {
      await jsonFetch(`/api/interviews/${id}`, { method: "DELETE" });
    } catch (err) {
      await alertDialog({ title: "删除失败", message: errorMessage(err) });
      return;
    }
    singles.reload();
  }

  async function removeSeries(id: number) {
    if (
      !(await confirmDialog({
        title: "删除进阶面试",
        message: "确定删除这场进阶面试？三轮对话记录与总评会一并删除，已生成的追练题保留。",
        danger: true,
      }))
    ) return;
    try {
      await jsonFetch(`/api/interviews/series/${id}`, { method: "DELETE" });
    } catch (err) {
      await alertDialog({ title: "删除失败", message: errorMessage(err) });
      return;
    }
    series.reload();
  }

  return {
    resumes,
    resumesError,
    reloadResumes,
    items: singles.items,
    seriesItems: series.items,
    totalCount: singles.total !== null && series.total !== null ? singles.total + series.total : null,
    loadError: singles.listError || series.listError,
    retryLoad: () => {
      if (singles.listError) singles.reload();
      if (series.listError) series.reload();
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
    setResumeId,
    resumeVersionId,
    setResumeVersionId,
    keyword,
    setKeyword,
    remove,
    removeSeries,
  };
}
