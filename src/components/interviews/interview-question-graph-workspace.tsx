"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { InterviewQuestionGraph } from "@/components/interviews/interview-question-graph";
import { ResumeVersionSelect } from "@/components/resume/resume-version-select";
import { useCursorList } from "@/hooks/use-cursor-list";
import { useResumeOptions } from "@/hooks/use-resume-options";
import { useResumeVersionSelection } from "@/hooks/use-resume-version-selection";
import { errorMessage } from "@/lib/error-message";
import { jsonFetch } from "@/lib/fetcher";
import {
  INTERVIEW_QUESTION_GRAPH_MAX_DEPTH,
  validateSavedInterviewQuestionGraph,
  type SavedInterviewQuestionGraph,
} from "@/lib/interview-question-graph";
import { INTERVIEW_STYLES, type InterviewStyleKey } from "@/lib/interview";
import {
  INTERVIEW_QUESTION_GRAPH_DRAFT_KEY,
  parseInterviewQuestionGraphDraft,
} from "@/lib/interview-question-graph-draft";
import { btnGhost, inputCls, labelCls, textareaCls } from "@/lib/ui";

type GraphHistoryItem = {
  id: number;
  resume_id: number;
  resume_version_id: number | null;
  resume_title: string;
  jd: string;
  style: InterviewStyleKey;
  question: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

function validateHistoryPage(page: { items: GraphHistoryItem[] }) {
  if (page.items.some((item) => !item || !Number.isSafeInteger(item.id) || item.id < 1 ||
    !Number.isSafeInteger(item.resume_id) || item.resume_id < 1 ||
    !(item.resume_version_id === null || (Number.isSafeInteger(item.resume_version_id) && item.resume_version_id > 0)) ||
    typeof item.resume_title !== "string" || typeof item.jd !== "string" ||
    !INTERVIEW_STYLES.some((style) => style.key === item.style) || typeof item.question !== "string" ||
    !Number.isSafeInteger(item.revision) || typeof item.created_at !== "string" || typeof item.updated_at !== "string")) {
    throw new Error("题目图谱历史列表响应无效，请刷新重试");
  }
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function InterviewQuestionGraphWorkspace() {
  const router = useRouter();
  const { resumes, resumesError, reloadResumes } = useResumeOptions();
  const [selectedResumeId, setSelectedResumeId] = useState<number | "">("");
  const [preferredVersionId, setPreferredVersionId] = useState<number | null>(null);
  const resumeId = selectedResumeId || resumes?.[0]?.id || "";
  const resume = resumes?.find((item) => item.id === resumeId);
  const { resumeVersionId, setResumeVersionId } = useResumeVersionSelection(resume, preferredVersionId);
  const [jd, setJd] = useState("");
  const [style, setStyle] = useState<InterviewStyleKey>("gentle");
  const [selectedRecord, setSelectedRecord] = useState<SavedInterviewQuestionGraph | null>(null);
  const [selectionError, setSelectionError] = useState("");
  const [loadingRecordId, setLoadingRecordId] = useState<number | null>(null);
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
  const detailRequest = useRef<AbortController | null>(null);

  const list = useCursorList<GraphHistoryItem>({
    queryKey: "interview-question-graphs",
    buildUrl: (cursor) => `/api/interviews/question-graphs?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    validatePage: (page) => validateHistoryPage(page as { items: GraphHistoryItem[] }),
  });
  const history = useMemo(() => list.items ?? [], [list.items]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("draft") !== "interview") return;
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(INTERVIEW_QUESTION_GRAPH_DRAFT_KEY);
      window.sessionStorage.removeItem(INTERVIEW_QUESTION_GRAPH_DRAFT_KEY);
    } catch {}
    if (raw) {
      try {
        const draft = parseInterviewQuestionGraphDraft(JSON.parse(raw) as unknown);
        if (draft) {
          startTransition(() => {
            setSelectedResumeId(draft.resumeId ?? "");
            setPreferredVersionId(draft.resumeVersionId);
            setJd(draft.jd);
            setStyle(draft.style);
          });
        }
      } catch {}
    }
    router.replace("/interviews/question-graphs", { scroll: false });
  }, [router]);

  const openRecord = useCallback(async (id: number) => {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setLoadingRecordId(id);
    setSelectionError("");
    try {
      const value = await jsonFetch<unknown>(`/api/interviews/question-graphs/${id}`, { signal: controller.signal, cache: "no-store" });
      if (controller.signal.aborted || detailRequest.current !== controller) return;
      const record = validateSavedInterviewQuestionGraph(value);
      setSelectedResumeId(record.resume_id);
      setPreferredVersionId(record.resume_version_id);
      setJd(record.jd);
      setStyle(record.style);
      setSelectedRecord(record);
      setWorkspaceEpoch((epoch) => epoch + 1);
    } catch (reason) {
      if (!controller.signal.aborted && detailRequest.current === controller) setSelectionError(errorMessage(reason));
    } finally {
      if (detailRequest.current === controller) {
        detailRequest.current = null;
        setLoadingRecordId(null);
      }
    }
  }, []);

  const startFresh = useCallback(() => {
    detailRequest.current?.abort();
    detailRequest.current = null;
    setLoadingRecordId(null);
    setSelectionError("");
    setSelectedRecord(null);
    setWorkspaceEpoch((epoch) => epoch + 1);
  }, []);

  const missingSavedVersion = Boolean(selectedRecord && resumeId === selectedRecord.resume_id &&
    (!selectedRecord.resume_version_id || !resume?.versions.some((version) => version.id === selectedRecord.resume_version_id)));
  const configurationError = resumesError || (resumes === null
    ? "正在加载简历列表…"
    : !resumes.length
      ? "请先创建简历并发布一个版本。"
      : !resumeVersionId
        ? "请先选择已发布简历版本。"
        : !jd.trim()
          ? "请填写岗位要求（JD）。"
          : "");

  return (
    <div className="mx-auto max-w-7xl space-y-6 wrap-anywhere">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] font-bold leading-tight text-ink sm:text-[32px]">面试题目图谱</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">切换面试官视角后生成首题，再逐轮扩展回答与追问分支。图谱最多 {INTERVIEW_QUESTION_GRAPH_MAX_DEPTH} 层，每个节点最多两条分支，所有版本会自动保存在历史记录中。</p>
        </div>
        <Link href="/interviews" className={btnGhost}>返回模拟面试</Link>
      </div>

      <div className="grid min-w-0 gap-8 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside aria-labelledby="question-graph-history-title" className="min-w-0 border-b border-line pb-6 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 id="question-graph-history-title" className="text-base font-semibold text-ink">历史记录</h2>
              <p className="mt-1 text-xs text-muted">{list.total === null ? "加载中…" : `共 ${list.total} 条`}</p>
            </div>
            <button type="button" className={btnGhost} onClick={startFresh}>新建图谱</button>
          </div>

          {list.listError && <div role="alert" className="mt-4 space-y-2 text-sm text-danger"><p>{list.listError}</p><button type="button" className={btnGhost} onClick={list.reload}>重试</button></div>}
          {selectionError && <p role="alert" className="mt-4 text-sm text-danger">{selectionError}</p>}
          {!list.listError && !list.loading && history.length === 0 && (
            <p className="mt-5 border-l-2 border-line px-3 py-2 text-sm leading-6 text-muted">还没有图谱记录。选择简历、填写 JD 后即可生成。</p>
          )}
          <div className="mt-4 space-y-2">
            {history.map((item) => (
              <article key={item.id} className={`rounded-md border p-3 transition-colors ${selectedRecord?.id === item.id ? "border-primary bg-primary-soft" : "border-line bg-card hover:bg-surface"}`}>
                <p className="line-clamp-2 text-sm font-medium leading-5 text-ink">{item.question}</p>
                <p className="mt-2 text-xs text-muted">{item.resume_title} · {INTERVIEW_STYLES.find((option) => option.key === item.style)?.label ?? item.style}</p>
                <p className="mt-1 text-[11px] text-faint">{formatUpdatedAt(item.updated_at)}</p>
                <button
                  type="button"
                  className="mt-3 text-xs font-medium text-primary underline underline-offset-4 disabled:opacity-60"
                  onClick={() => void openRecord(item.id)}
                  disabled={loadingRecordId !== null}
                >
                  {loadingRecordId === item.id ? "正在载入…" : selectedRecord?.id === item.id ? "重新载入" : "载入此图谱"}
                </button>
              </article>
            ))}
          </div>
          {list.loading && <p role="status" className="mt-4 text-sm text-muted">正在载入历史记录…</p>}
          {list.hasMore && <button type="button" className={`${btnGhost} mt-4 w-full`} onClick={list.loadMore} disabled={list.loadingMore}>{list.loadingMore ? "正在加载…" : "加载更多"}</button>}
        </aside>

        <main className="min-w-0 space-y-6">
          <section aria-labelledby="question-graph-config-title" className="space-y-4">
            <div>
              <h2 id="question-graph-config-title" className="text-base font-semibold text-ink">生成条件</h2>
              {selectedRecord && <p className="mt-1 text-xs text-muted">正在查看历史记录 #{selectedRecord.id}。修改下方条件后，现有图谱仍可查看，点击重新生成会创建新的历史记录。</p>}
              {missingSavedVersion && <p role="status" className="mt-2 text-xs text-accent">此历史记录关联的发布版本已删除，原图仍可查看；选择其他发布版本并重新生成可创建新图谱。</p>}
            </div>
            {resumesError && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger"><span>{resumesError}</span><button type="button" className={btnGhost} onClick={reloadResumes}>重试加载简历</button></div>}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className={labelCls}>参考简历</span>
                <select className={`${inputCls} mt-1`} value={resumeId} disabled={!resumes?.length} onChange={(event) => {
                  setSelectedResumeId(Number(event.target.value));
                  setPreferredVersionId(null);
                }}>
                  {!resumes?.length && <option value="">{resumes === null ? "正在加载…" : "暂无简历"}</option>}
                  {resumes?.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                </select>
              </label>
              <ResumeVersionSelect
                resume={resume}
                value={resumeVersionId}
                onChange={(id) => setResumeVersionId(id)}
              />
              <label className="block sm:col-span-2">
                <span className={labelCls}>岗位要求（JD）</span>
                <textarea className={`${textareaCls} mt-1 min-h-32`} value={jd} onChange={(event) => setJd(event.target.value)} placeholder="粘贴岗位职责、任职要求或关键技能" />
              </label>
              <label className="block sm:max-w-sm">
                <span className={labelCls}>考官风格</span>
                <select className={`${inputCls} mt-1`} value={style} onChange={(event) => setStyle(event.target.value as InterviewStyleKey)}>
                  {INTERVIEW_STYLES.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                </select>
              </label>
            </div>
            {!selectedRecord && configurationError && resumes !== null && !resumesError && <p role="status" className="text-xs text-muted">{configurationError}</p>}
          </section>

          <InterviewQuestionGraph
            key={`${selectedRecord?.id ?? "new"}-${workspaceEpoch}`}
            hidden={false}
            resumeId={resumeId}
            resumeVersionId={resumeVersionId}
            jd={jd}
            style={style}
            configurationError={configurationError}
            initialRecord={selectedRecord}
            onRecordSaved={list.reload}
          />
        </main>
      </div>
    </div>
  );
}
