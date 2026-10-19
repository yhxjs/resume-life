"use client";

import { useState } from "react";
import Link from "next/link";
import { PreparationReturnLink } from "@/components/application/preparation-return-link";
import { useParams } from "next/navigation";
import {
  DIMENSIONS,
  INTERVIEW_DIMENSIONS,
  weakDimensions,
} from "@/lib/scores";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { NotebookStarButton } from "@/components/notebook";
import { interviewStyleOf } from "@/lib/interview";
import { motionSafeScrollBehavior } from "@/lib/reduced-motion";
import { SERIES_ROUND_DEFS, seriesRoundOf } from "@/lib/series";
import { btnPrimary, scoreTextCls, textErr } from "@/lib/ui";
import { InterviewReviewTurn } from "@/components/interview/review-turn";
import { InterviewReverseCard } from "@/components/interview/reverse-card";
import { InterviewAnswerPanel } from "@/components/interview/interview-answer-panel";
import { InterviewReportSection, type ReportTab } from "@/components/interview/interview-report-section";
import { ReverseInterviewModals } from "@/components/interview/reverse-modals";
import { useInterviewCommands } from "@/hooks/use-interview-session";
import { usePreparationHref } from "@/hooks/use-preparation-href";
import { ResumeVersionBadge } from "@/components/resume/resume-version-badge";

export default function InterviewPage() {
  const params = useParams<{ id: string }>();
  return <InterviewDetail key={params.id} interviewId={params.id} />;
}

function InterviewDetail({ interviewId }: { interviewId: string }) {
  const preparationHref = usePreparationHref();
  const [viewMode, setViewMode] = useState<"review" | "chat">("review");
  const [reportTab, setReportTab] = useState<ReportTab>("candidate");
  const {
    data, setData, loadError, retryLoad, answer, setAnswer, busy, error,
    remediating, remedialError, advancing, advanceError,
    showReverseChoiceModal,
    showReverseInputModal, setShowReverseInputModal,
    reverseBusy, reverseError, answerTypewriter, current, answeredCount,
    setTurnNotebook, updateTurnData, submitAnswer, generateReportDirectly,
    finish, handleStartReverse, handleSkipReverse, handleSubmitReverse,
    startRemediation, advance,
  } = useInterviewCommands(interviewId);

  if (loadError) return <LoadError message={loadError} onRetry={retryLoad} />;
  if (!data) return <Loading />;

  const isFinished = data.status === "finished";
  const focusLabels = data.report
    ? weakDimensions(data.report).map((k) => INTERVIEW_DIMENSIONS.find((d) => d.key === k)?.label ?? k)
    : [];
  // 进阶面试：本轮报告已出时的去向——下一轮未建则进入下一轮；三轮齐备则去总览生成/查看总评
  const nextRoundDef = data.series_id && data.report ? seriesRoundOf(data.round_no + 1) : undefined;
  const nextCreated = nextRoundDef
    ? data.series_rounds.some((x) => x.round_no === nextRoundDef!.no)
    : false;

  const isReviewMode = isFinished && viewMode === "review";

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <PreparationReturnLink />
      {/* 顶部面包屑与状态头 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Link
              href="/interviews"
              className="text-xs font-medium text-muted transition-colors hover:text-primary"
            >
              ← 返回模拟面试大厅
            </Link>
            <span className="text-xs text-faint">/</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary-soft px-2.5 py-0.5 text-[11px] font-medium text-primary">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
              <span>
                {data.series_id ? seriesRoundOf(data.round_no)?.label : interviewStyleOf(data.style).label}
              </span>
            </span>
          </div>
          <h1 className="font-serif text-[26px] sm:text-[30px] font-bold text-ink leading-tight">
            模拟面试实战{" "}
            <span className="font-sans text-base sm:text-lg font-normal text-muted">
              · {data.resume_title}
              <ResumeVersionBadge {...data} />
            </span>
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">
            {data.status === "finished" ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary-soft px-3 py-1 font-medium text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                已完结 · {new Date(data.finished_at).toLocaleDateString()}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent-wash px-3 py-1 font-medium text-accent">
                <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                答辩进行中：第 <strong className="font-mono">{answeredCount + 1}</strong> / {data.rounds} 轮
              </span>
            )}
          </span>
        </div>
      </div>

      {/* 视图模式切换：面试结束后可在「复盘重放」与「问答实况」间自由切换 */}
      {isFinished && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-card p-3.5 shadow-card-subtle">
          <div className="flex items-center gap-2">
            <span className="font-serif text-xs font-bold text-muted">复盘模式：</span>
            <div className="flex rounded-xl border border-line bg-surface p-1 text-xs">
              <button
                type="button"
                onClick={() => setViewMode("review")}
                className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 font-medium transition-all ${
                  viewMode === "review"
                    ? "bg-primary text-on-primary font-bold shadow-xs"
                    : "text-muted hover:text-ink"
                }`}
              >
                <span>🎬 复盘重放</span>
                <span className="text-[11px] opacity-85 hidden sm:inline">（并排精修对比）</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("chat")}
                className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 font-medium transition-all ${
                  viewMode === "chat"
                    ? "bg-primary text-on-primary font-bold shadow-xs"
                    : "text-muted hover:text-ink"
                }`}
              >
                <span>💬 现场问答实况流</span>
              </button>
            </div>
          </div>
          <p className="text-xs text-muted">
            {viewMode === "review"
              ? "支持展开对比考官精修参考，并可针对薄弱题反复重答"
              : "按时间线沉浸式回看现场对话与追问脉络"}
          </p>
        </div>
      )}

      {/* 进阶多轮面试导航胶囊 */}
      {data.series_id && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card p-4 shadow-card-subtle">
          <Link
            href={preparationHref(`/interviews/series/${data.series_id}`)}
            className="font-serif text-xs font-bold text-primary hover:underline mr-1"
          >
            ← 连环面总览
          </Link>
          {SERIES_ROUND_DEFS.map((def) => {
            const r = data.series_rounds.find((x) => x.round_no === def.no);
            const isCurrent = def.no === data.round_no;
            return (
              <span key={def.no} className="flex items-center gap-2">
                <span className="text-xs text-faint">/</span>
                {r ? (
                  <Link
                    href={preparationHref(`/interviews/${r.id}`)}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs transition-all ${
                      isCurrent
                        ? "bg-primary text-white font-bold shadow-xs"
                        : "border border-line bg-surface text-ink hover:border-primary/40"
                    }`}
                  >
                    <span>{def.label}</span>
                    {r.overall !== null ? (
                      <span className="font-mono font-bold">({r.overall}分)</span>
                    ) : r.status === "ongoing" ? (
                      <span className="text-accent text-[10px]">进行中</span>
                    ) : (
                      <span className="text-muted text-[10px]">已完结</span>
                    )}
                  </Link>
                ) : (
                  <span className="rounded-lg border border-dashed border-line px-2.5 py-1 text-xs text-faint opacity-70">
                    {def.label} · 未开练
                  </span>
                )}
              </span>
            );
          })}
        </div>
      )}

      <InterviewReportSection
        data={data}
        reportTab={reportTab}
        setReportTab={setReportTab}
        focusLabels={focusLabels}
        remediating={remediating}
        remedialError={remedialError}
        onStartRemediation={startRemediation}
        onEvaluatorReportGenerated={(newReport) => {
          setData((previous) => (previous ? { ...previous, evaluator_report: newReport } : null));
        }}
      />

      {/* 反问环节卡片 */}
      {data.report && data.reverse_interview && (
        <div className="rounded-2xl border border-accent/30 bg-card p-5 shadow-card-subtle">
          <InterviewReverseCard
            data={data.reverse_interview}
            styleName={data.series_id ? seriesRoundOf(data.round_no)?.label : interviewStyleOf(data.style).label}
          />
        </div>
      )}

      {/* 进阶轮次流转卡片 */}
      {data.report && data.series_id && (
        nextRoundDef && !nextCreated ? (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-card p-5 shadow-card-subtle">
            <div className="min-w-0 space-y-1">
              <p className="font-serif text-sm font-bold text-ink">本轮面试完成，{nextRoundDef.label}已就绪！</p>
              <p className="text-xs text-muted leading-relaxed">
                {nextRoundDef.desc} · 前轮报告已自动呈报下一位考官，将换角度深挖短板
              </p>
            </div>
            <button
              type="button"
              className={btnPrimary}
              onClick={advance}
              disabled={advancing}
            >
              {advancing ? "考官正在准备第一题…" : `进入 ${nextRoundDef.label}`}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-card p-5 shadow-card-subtle">
            <div className="min-w-0 space-y-1">
              <p className="font-serif text-sm font-bold text-ink">
                {!nextRoundDef || data.series_status === "finished" ? "🎉 连环三轮已全部完结" : "本轮完成，后续轮次进行中"}
              </p>
              <p className="text-xs text-muted">
                {data.series_status === "finished"
                  ? "跨轮综合评审与录用建议已生成，可随时查看。"
                  : !nextRoundDef
                    ? "三轮报告已齐备，点击下方生成跨轮总评。"
                    : "下一轮的状态与动作见总览页。"}
              </p>
            </div>
            <a href={preparationHref(`/interviews/series/${data.series_id}`)} className={btnPrimary}>
              {data.series_status === "finished" ? "查看总评报告" : !nextRoundDef ? "去生成跨轮总评" : "返回系列总览"}
            </a>
          </div>
        )
      )}
      {advanceError && <p className={`mt-2 text-sm ${textErr}`}>{advanceError}</p>}

      {/* 复盘模式：题号导航条 + 逐题并排卡片 */}
      {isReviewMode ? (
        <div className="space-y-6">
          {/* 题号快速定位条 */}
          {data.turns.length > 0 && (
            <div className="sticky top-16 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card/95 p-3.5 backdrop-blur-md shadow-card-subtle">
              <span className="font-serif text-xs font-bold text-muted mr-1">快速跳题：</span>
              {data.turns.map((t) => {
                let score = null;
                if (t.scores) {
                  score = Math.round(((t.scores.depth + t.scores.structure + t.scores.authenticity + t.scores.completeness) / 4) * 10) / 10;
                }
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      document.getElementById(`turn-${t.id}`)?.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "start" });
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink transition-all hover:border-primary hover:text-primary"
                  >
                    <span className="font-mono font-bold">Q{t.idx}</span>
                    {score !== null ? (
                      <span className={`font-mono font-bold ${scoreTextCls(score)}`}>
                        {score}
                      </span>
                    ) : (
                      <span className="text-faint">-</span>
                    )}
                    {t.retries && t.retries.length > 0 && (
                      <span className="h-1.5 w-1.5 rounded-full bg-accent" title="已重答" />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* 逐题复盘卡片流 */}
          <div className="space-y-6">
            {data.turns.map((t) => (
              <InterviewReviewTurn
                key={t.id}
                interviewId={data.id}
                turn={t}
                onTurnUpdated={(updated) => updateTurnData(t.id, updated)}
                onNotebookChanged={(nbId) => setTurnNotebook(t.id, nbId)}
              />
            ))}
            {data.reverse_interview && (
              <InterviewReverseCard
                data={data.reverse_interview}
                styleName={data.series_id ? seriesRoundOf(data.round_no)?.label : interviewStyleOf(data.style).label}
              />
            )}
          </div>
        </div>
      ) : (
        /* 原有时间线对话流模式 */
        <div className="space-y-4">
          {data.turns.map((t) => (
            <div key={t.id} className="space-y-2">
              <div className="max-w-[92%] rounded-2xl rounded-tl-sm border border-line bg-surface/50 p-4 shadow-2xs">
                <div className="flex items-center justify-between gap-3 border-b border-line/60 pb-2">
                  <p className="font-mono text-xs font-bold text-primary">
                    面试官 · 第 {t.idx} 题{t.kind === "followup" ? "（追问）" : ""}
                  </p>
                  <NotebookStarButton
                    source="interview"
                    sourceId={t.id}
                    question={t.question}
                    notebookId={t.notebook_id}
                    onChanged={(id) => setTurnNotebook(t.id, id)}
                  />
                </div>
                <p className="mt-2 font-serif text-[15px] font-bold text-ink leading-relaxed whitespace-pre-wrap">
                  {t.question}
                </p>
              </div>

              {t.answered_at ? (
                <>
                  <div className="ml-auto max-w-[92%] rounded-2xl rounded-tr-sm border border-primary/20 bg-primary-soft/40 p-4 shadow-2xs">
                    <p className="font-mono text-xs font-bold text-primary pb-1">我的现场作答：</p>
                    <p className="mt-1 whitespace-pre-wrap text-xs sm:text-sm leading-relaxed text-ink font-sans">
                      {t.answer}
                    </p>
                  </div>
                  {t.scores && (
                    <div className="ml-4 flex flex-wrap items-center gap-1.5 pt-1">
                      <span className="text-xs text-muted font-serif">本题评分：</span>
                      {DIMENSIONS.map((d) => (
                        <span key={d.key} className="rounded-md border border-line bg-card px-2 py-0.5 text-[11px]">
                          {d.label}
                          <span className={`ml-1 font-mono font-bold ${scoreTextCls(t.scores![d.key])}`}>
                            {t.scores![d.key]}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                  {t.comment && (
                    <p className="ml-4 rounded-xl border border-line/70 bg-card p-3 text-xs leading-relaxed text-muted">
                      💡 <strong>考官点评：</strong>{t.comment}
                    </p>
                  )}
                </>
              ) : null}
            </div>
          ))}
          {data.reverse_interview && (
            <div className="pt-2">
              <InterviewReverseCard
                data={data.reverse_interview}
                styleName={data.series_id ? seriesRoundOf(data.round_no)?.label : interviewStyleOf(data.style).label}
              />
            </div>
          )}
        </div>
      )}

      <InterviewAnswerPanel
        data={data}
        current={current}
        answer={answer}
        setAnswer={setAnswer}
        busy={busy}
        error={error}
        answeredCount={answeredCount}
        displayedText={answerTypewriter.displayedText}
        isTyping={answerTypewriter.isTyping}
        onFinish={finish}
        onSubmitAnswer={submitAnswer}
        onGenerateReport={generateReportDirectly}
        onOpenReverse={() => setShowReverseInputModal(true)}
      />

      <ReverseInterviewModals
        showChoiceModal={showReverseChoiceModal}
        showInputModal={showReverseInputModal}
        interviewerLabel={(data.series_id ? seriesRoundOf(data.round_no)?.label : interviewStyleOf(data.style).label) ?? "面试官"}
        busy={busy}
        reverseBusy={reverseBusy}
        reverseError={reverseError}
        onSkipChoice={handleSkipReverse}
        onStartChoice={handleStartReverse}
        onCloseInput={() => setShowReverseInputModal(false)}
        onGiveUpInput={() => {
          setShowReverseInputModal(false);
          generateReportDirectly();
        }}
        onSubmitReverse={handleSubmitReverse}
      />
    </div>
  );
}
