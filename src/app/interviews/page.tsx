"use client";

import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  InterviewStartForm,
  type InterviewStartMode,
} from "@/components/interviews/interview-start-form";
import { InterviewHistory } from "@/components/interviews/interview-history";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { useInterviewsPage } from "@/hooks/use-interviews-page";
import { useTypewriter } from "@/hooks/use-typewriter";
import { fetchSse, SseServerError } from "@/lib/fetch-sse";
import { DEFAULT_INTERVIEW_ROUNDS, isInterviewRounds, type InterviewStyleKey } from "@/lib/interview";
import { errorMessage } from "@/lib/error-message";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import type { Application } from "@/lib/applications-types";
import { PreparationReturnLink } from "@/components/application/preparation-return-link";
import { btnGhost } from "@/lib/ui";

type InterviewApplication = Pick<Application, "id" | "company" | "role" | "jd" | "resume_id" | "resume_version_id">;
const isRecordId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function readSetupRecord(value: unknown, id: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || !isRecordId((value as { id?: unknown }).id) || (value as { id: number }).id !== Number(id)) {
    throw new Error("来源记录响应不完整或与当前记录不符，请重新读取");
  }
  return value as Record<string, unknown>;
}

export default function InterviewsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <InterviewsWithSource />
    </Suspense>
  );
}

function InterviewsWithSource() {
  const searchParams = useSearchParams();
  const id = searchParams.get("applicationId");
  if (id) return <ApplicationInterviewSetup key={id} id={id} />;
  const portraitId = searchParams.get("portraitId");
  return portraitId ? <PortraitInterviewSetup key={portraitId} id={portraitId} /> : <InterviewsContent />;
}

function PortraitInterviewSetup({ id }: { id: string }) {
  const [jd, setJd] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    jsonFetch<unknown>(`/api/tools/jd-portraits/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        const portrait = readSetupRecord(value, id);
        if (typeof portrait.jd !== "string") throw new Error("画像原始 JD 响应不完整，请重新读取");
        if (!portrait.jd.trim()) throw new Error("该画像的岗位 JD 为空，请返回考点画像页确认。");
        setJd(portrait.jd);
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [id, attempt]);
  if (error) return <LoadError message={error} onRetry={() => { setError(""); setAttempt((value) => value + 1); }} />;
  if (jd === null) return <Loading label="读取完整岗位 JD…" />;
  return <InterviewsContent initialJd={jd} />;
}

function ApplicationInterviewSetup({ id }: { id: string }) {
  const [application, setApplication] = useState<InterviewApplication | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    jsonFetch<unknown>(`/api/applications/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        const record = readSetupRecord(value, id);
        if (typeof record.company !== "string" || typeof record.role !== "string" || typeof record.jd !== "string" ||
          (record.resume_id !== null && !isRecordId(record.resume_id)) ||
          (record.resume_version_id !== null && !isRecordId(record.resume_version_id))) {
          throw new Error("投递的简历与 JD 响应不完整，请重新读取");
        }
        setApplication(record as InterviewApplication);
      }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [id, attempt]);
  if (error) return <div className="space-y-4"><PreparationReturnLink /><p role="alert" className="text-danger">{error}</p><button className={btnGhost} onClick={() => { setError(""); setAttempt((value) => value + 1); }}>重试</button></div>;
  if (!application) return <Loading label="读取投递简历与 JD…" />;
  if (!application.resume_id || !application.resume_version_id || !application.jd.trim()) return <div className="space-y-4"><PreparationReturnLink /><p>请先在投递准备页选择已发布的简历版本，并补充岗位 JD。</p></div>;
  return <InterviewsContent application={application} />;
}

function InterviewsContent({ application, initialJd }: { application?: InterviewApplication; initialJd?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryJd = application?.jd ?? initialJd ?? searchParams.get("jd") ?? "";
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
    reloadHistory,
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
    deletion,
  } = useInterviewsPage(queryResumeId, queryResumeVersionId);
  const [mode, setMode] = useState<InterviewStartMode>("single");
  const [jd, setJd] = useState(queryJd);
  const [rounds, setRounds] = useState<number | "">(DEFAULT_INTERVIEW_ROUNDS);
  const [style, setStyle] = useState<InterviewStyleKey>("gentle");
  const [starting, setStarting] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [error, setError] = useState("");
  const typewriter = useTypewriter();
  const [creationUncertain, setCreationUncertain] = useState(false);
  const startController = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const navigationAccepted = useRef(false);
  const recordsLoaded = items !== null && seriesItems !== null;
  const boundMaterialsAvailable = !application || (resumeId === application.resume_id && resumeVersionId === application.resume_version_id &&
    resumes?.some((resume) => resume.id === application.resume_id && resume.versions.some((version) => version.id === application.resume_version_id)));
  const configurationError = application && resumes !== null && !boundMaterialsAvailable
    ? "投递绑定的简历或发布版不在当前列表中。请重新读取简历列表，或返回投递准备页确认。" : "";

  useLayoutEffect(() => {
    // 来源异步载入后，表单一旦可交互就必须持有所属页面，避免首个点击被丢弃。
    mounted.current = true;
    return () => {
      mounted.current = false;
      startController.current?.abort();
      startController.current = null;
    };
  }, []);

  async function start() {
    if (!mounted.current || startController.current || navigationAccepted.current || !deletion.canStart() || !boundMaterialsAvailable || !isInterviewRounds(rounds) || resumeId === "" || resumeVersionId === "" || !jd.trim()) return;
    const controller = new AbortController();
    startController.current = controller;
    const isCurrent = () => mounted.current && startController.current === controller && !controller.signal.aborted && !navigationAccepted.current;
    setStarting(true);
    setError("");
    setCreationUncertain(false);
    typewriter.reset();
    try {
      await fetchSse<unknown>("/api/interviews", {
        body: { resume_id: resumeId, resume_version_id: resumeVersionId, jd: jd.trim(), rounds, style, mode, ...(application ? { application_id: application.id } : {}) },
        signal: controller.signal,
        onDelta: (delta) => {
          if (!isCurrent()) return;
          typewriter.appendDelta(delta);
        },
        onDone: (data) => {
          if (!isCurrent()) return;
          const id = data && typeof data === "object" ? (data as { id?: unknown }).id : undefined;
          if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("创建完成响应不完整，请先核对历史记录是否已保存");
          typewriter.flush();
          router.push(`/interviews/${id}${application ? `?applicationId=${application.id}` : ""}`);
          navigationAccepted.current = true;
          setNavigating(true);
        },
      });
    } catch (reason) {
      if (!isCurrent()) return;
      startController.current = null;
      controller.abort();
      setError(errorMessage(reason));
      setCreationUncertain(!(reason instanceof SseServerError ||
        (reason instanceof HttpError && reason.status >= 400 && reason.status < 500 && reason.status !== 408)));
      setStarting(false);
      typewriter.reset();
      reloadHistory();
    }
  }

  /** 取消开场请求：中止后 fetchSse 静默返回，这里负责把按钮恢复为可用 */
  function cancelStart() {
    const controller = startController.current;
    if (!mounted.current || !controller || navigationAccepted.current) return;
    startController.current = null;
    controller.abort();
    setStarting(false);
    typewriter.reset();
    setCreationUncertain(true);
    setError("已取消本页等待。取消不保证撤销服务端保存，请先核对历史记录再重新开始。");
    reloadHistory();
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8 wrap-anywhere">
      {application && <div className="space-y-3"><PreparationReturnLink /><p className="text-sm text-muted">正在为 {application.company} · {application.role} 准备，JD 来自该投递，简历须与其绑定发布版一致。结果会自动加入投递准备页；如需调整资料，请返回编辑投递。</p></div>}
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

      <fieldset disabled={deletion.busy} className="min-w-0">
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
          navigating={navigating}
          error={error}
          creationUncertain={creationUncertain}
          configurationError={configurationError}
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
      </fieldset>

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
        onRemove={id => { if (!startController.current && !navigationAccepted.current) void remove(id); }}
        onRemoveSeries={id => { if (!startController.current && !navigationAccepted.current) void removeSeries(id); }}
        deletion={deletion}
        starting={starting || navigating}
      />
    </div>
  );
}
