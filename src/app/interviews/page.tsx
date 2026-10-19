"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  InterviewStartForm,
  type InterviewStartMode,
} from "@/components/interviews/interview-start-form";
import { InterviewHistory } from "@/components/interviews/interview-history";
import { Loading } from "@/components/common/ui-bits";
import { useInterviewsPage } from "@/hooks/use-interviews-page";
import { useTypewriter } from "@/hooks/use-typewriter";
import { fetchSse } from "@/lib/fetch-sse";
import type { InterviewStyleKey } from "@/lib/interview";
import { errorMessage } from "@/lib/error-message";
import { jsonFetch } from "@/lib/fetcher";
import type { Application } from "@/lib/applications-types";
import { PreparationReturnLink } from "@/components/application/preparation-return-link";
import { btnGhost } from "@/lib/ui";

export default function InterviewsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <InterviewsWithApplication />
    </Suspense>
  );
}

function InterviewsWithApplication() {
  const searchParams = useSearchParams();
  const id = searchParams.get("applicationId");
  return id ? <ApplicationInterviewSetup key={id} id={id} /> : <InterviewsContent />;
}

function ApplicationInterviewSetup({ id }: { id: string }) {
  const [application, setApplication] = useState<Application | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    jsonFetch<Application>(`/api/applications/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(setApplication).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [id, attempt]);
  if (error) return <div className="space-y-4"><PreparationReturnLink /><p role="alert" className="text-danger">{error}</p><button className={btnGhost} onClick={() => { setError(""); setAttempt((value) => value + 1); }}>重试</button></div>;
  if (!application) return <Loading label="读取投递简历与 JD…" />;
  if (!application.resume_id || !application.resume_version_id || !application.jd.trim()) return <div className="space-y-4"><PreparationReturnLink /><p>请先在投递准备页选择已发布的简历版本，并补充岗位 JD。</p></div>;
  return <InterviewsContent application={application} />;
}

function InterviewsContent({ application }: { application?: Application }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryJd = application?.jd ?? searchParams.get("jd") ?? "";
  const queryResumeId = application?.resume_id ? String(application.resume_id) : searchParams.get("resumeId");
  const queryResumeVersionId = application?.resume_version_id ? String(application.resume_version_id) : searchParams.get("resumeVersionId");
  const {
    resumes,
    resumesError,
    reloadResumes,
    items,
    seriesItems,
    totalCount,
    loadError,
    retryLoad,
    itemsHasMore,
    itemsLoadingMore,
    itemsLoadFailed,
    loadMoreItems,
    seriesHasMore,
    seriesLoadingMore,
    seriesLoadFailed,
    loadMoreSeries,
    resumeId,
    setResumeId,
    resumeVersionId,
    setResumeVersionId,
    keyword,
    setKeyword,
    remove,
    removeSeries,
  } = useInterviewsPage(queryResumeId, queryResumeVersionId);
  const [mode, setMode] = useState<InterviewStartMode>("single");
  const [jd, setJd] = useState(queryJd);
  const [rounds, setRounds] = useState(8);
  const [style, setStyle] = useState<InterviewStyleKey>("gentle");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const typewriter = useTypewriter();
  const startController = useRef<AbortController | null>(null);
  const recordsLoaded = items !== null && seriesItems !== null;

  // 离页时中止进行中的开场请求，避免服务端卡顿时连接一直挂着
  useEffect(() => () => startController.current?.abort(), []);

  async function start() {
    if (resumeId === "" || resumeVersionId === "" || !jd.trim()) return;
    setStarting(true);
    setError("");
    typewriter.reset();
    const controller = new AbortController();
    startController.current = controller;
    try {
      await fetchSse<{ id: number; series_id: number | null }>("/api/interviews", {
        body: { resume_id: resumeId, resume_version_id: resumeVersionId, jd: jd.trim(), rounds, style, mode, ...(application ? { application_id: application.id } : {}) },
        signal: controller.signal,
        onDelta: (delta) => {
          typewriter.appendDelta(delta);
        },
        onDone: (data) => {
          typewriter.flush();
          router.push(`/interviews/${data.id}${application ? `?applicationId=${application.id}` : ""}`);
        },
        onError: (reason) => {
          setError(reason.message);
          setStarting(false);
          typewriter.reset();
        },
      });
    } catch (reason) {
      setError(errorMessage(reason));
      setStarting(false);
      typewriter.reset();
    } finally {
      if (startController.current === controller) startController.current = null;
    }
  }

  /** 取消开场请求：中止后 fetchSse 静默返回，这里负责把按钮恢复为可用 */
  function cancelStart() {
    const controller = startController.current;
    if (!controller) return;
    startController.current = null;
    controller.abort();
    setStarting(false);
    typewriter.reset();
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      {application && <div className="space-y-3"><PreparationReturnLink /><p className="text-sm text-muted">正在为 {application.company} · {application.role} 准备，已带入该投递的简历与 JD。结果会自动加入投递准备页；如需调整资料，请返回编辑投递。</p></div>}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">全真模拟面试</h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            输入岗位要求并选择简历，面试官逐题出题、根据回答动态深度追问；支持单轮高压模考与三轮进阶连打。
          </p>
        </div>
        {recordsLoaded && totalCount !== null && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>已累计实战：<strong className="font-mono text-ink font-bold text-sm">{totalCount}</strong> 场</span>
          </div>
        )}
      </div>

      <InterviewStartForm
        applicationBound={Boolean(application)}
        resumes={resumes}
        resumesError={resumesError}
        onRetryResumes={reloadResumes}
        mode={mode}
        resumeId={resumeId}
        resumeVersionId={resumeVersionId}
        jd={jd}
        rounds={rounds}
        style={style}
        starting={starting}
        error={error}
        displayedText={typewriter.displayedText}
        isTyping={typewriter.isTyping}
        onModeChange={setMode}
        onResumeIdChange={setResumeId}
        onResumeVersionIdChange={setResumeVersionId}
        onJdChange={setJd}
        onRoundsChange={setRounds}
        onStyleChange={setStyle}
        onStart={start}
        onCancel={cancelStart}
      />

      <InterviewHistory
        items={items}
        seriesItems={seriesItems}
        loadError={loadError}
        onRetry={retryLoad}
        itemsHasMore={itemsHasMore}
        itemsLoadingMore={itemsLoadingMore}
        itemsLoadFailed={itemsLoadFailed}
        onLoadMoreItems={loadMoreItems}
        seriesHasMore={seriesHasMore}
        seriesLoadingMore={seriesLoadingMore}
        seriesLoadFailed={seriesLoadFailed}
        onLoadMoreSeries={loadMoreSeries}
        keyword={keyword}
        onKeywordChange={setKeyword}
        onRemove={remove}
        onRemoveSeries={removeSeries}
      />
    </div>
  );
}
