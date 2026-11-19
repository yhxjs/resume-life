"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { DIMENSIONS, type ScoreMap } from "@/lib/scores";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { badgeCls, btnGhost, btnPrimary, cardCls, textareaCls, scoreTextCls, textErr } from "@/lib/ui";
import { NotebookStarButton } from "@/components/notebook";
import { errorMessage } from "@/lib/error-message";
import { createRequestId } from "@/lib/client-request-id";
import { jsonFetch } from "@/lib/fetcher";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import { parseInterviewRetryResponse, type TurnRetry } from "@/lib/interview-retry-response";

export type { TurnRetry } from "@/lib/interview-retry-response";

export type ReviewTurnData = {
  id: number;
  idx: number;
  kind: string;
  question: string;
  answer: string;
  comment: string;
  scores: ScoreMap | null;
  scores_error?: string;
  reference: string;
  retries: TurnRetry[];
  retries_error?: string;
  answered_at: string;
  notebook_id: number | null;
};

interface InterviewReviewTurnProps {
  interviewId: number;
  turn: ReviewTurnData;
  onTurnUpdated: (updated: Partial<ReviewTurnData>) => void;
  onNotebookChanged: (notebookId: number | null) => void;
}

function calcOverall(scores: ScoreMap | null): number | null {
  if (!scores) return null;
  const sum = scores.depth + scores.structure + scores.authenticity + scores.completeness;
  return Math.round((sum / 4) * 10) / 10;
}

export function InterviewReviewTurn(props: InterviewReviewTurnProps) {
  return <InterviewReviewTurnSession key={`${props.interviewId}:${props.turn.id}`} {...props} />;
}

function InterviewReviewTurnSession({
  interviewId,
  turn,
  onTurnUpdated,
  onNotebookChanged,
}: InterviewReviewTurnProps) {
  const mounted = useRef(false);
  const referencePending = useRef<AbortController | null>(null);
  const retryPending = useRef<AbortController | null>(null);
  const retryRequest = useRef<{ answer: string; id: string } | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      referencePending.current?.abort();
      referencePending.current = null;
      retryPending.current?.abort();
      retryPending.current = null;
    };
  }, []);
  // 版本选择："origin" 或 重答的索引 0, 1, 2...
  const [selectedVersion, setSelectedVersion] = useState<"origin" | number>(
    turn.retries.length > 0 ? turn.retries.length - 1 : "origin"
  );
  // 是否展开重答面板
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryAnswer, setRetryAnswer] = useState("");
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState("");

  // 生成/重新生成参考答案
  const [refBusy, setRefBusy] = useState(false);
  const [refError, setRefError] = useState("");
  const { copiedText, copy, copyError, copying } = useCopyFeedback();

  // 当前左侧展示的作答内容
  const isOrigin = selectedVersion === "origin";
  const currentRetry = !isOrigin && typeof selectedVersion === "number" ? turn.retries[selectedVersion] : null;

  const currentAnswer = isOrigin ? turn.answer : currentRetry?.answer ?? "";
  const currentScores = isOrigin ? turn.scores : currentRetry?.scores ?? null;
  const currentComment = isOrigin ? turn.comment : currentRetry?.comment ?? "";
  const retryReference = currentRetry?.reference;
  const isRetryReference = Boolean(retryReference?.trim());
  const currentReference = retryReference?.trim() ? retryReference : turn.reference;

  const originOverall = calcOverall(turn.scores);
  const currentOverall = calcOverall(currentScores);
  const scoreDiff =
    !isOrigin && originOverall !== null && currentOverall !== null
      ? Math.round((currentOverall - originOverall) * 10) / 10
      : null;

  // 生成参考答案
  async function handleGenerateReference() {
    if (!mounted.current || referencePending.current) return;
    const controller = new AbortController();
    referencePending.current = controller;
    const isCurrent = () => mounted.current && referencePending.current === controller && !controller.signal.aborted;
    setRefBusy(true);
    setRefError("");
    try {
      const data = await jsonFetch<unknown>(
        `/api/interviews/${interviewId}/turns/${turn.id}/reference`,
        { method: "POST", signal: controller.signal }
      );
      if (!isCurrent()) return;
      const reference = data && typeof data === "object" && !Array.isArray(data)
        ? (data as { reference?: unknown }).reference : undefined;
      if (typeof reference !== "string" || !reference.trim()) {
        throw new Error("参考答案响应不完整，已有内容已保留，请刷新核对已保存内容");
      }
      onTurnUpdated({ reference });
    } catch (err) {
      if (isCurrent()) setRefError(errorMessage(err));
    } finally {
      if (isCurrent()) {
        referencePending.current = null;
        setRefBusy(false);
      }
    }
  }

  // 提交重答
  async function handleSubmitRetry() {
    if (!mounted.current || retryPending.current || turn.retries_error) return;
    if (!retryAnswer.trim()) {
      setRetryError("请输入回答内容");
      return;
    }
    const controller = new AbortController();
    retryPending.current = controller;
    const isCurrent = () => mounted.current && retryPending.current === controller && !controller.signal.aborted;
    setRetryBusy(true);
    setRetryError("");
    try {
      const answer = retryAnswer.trim();
      if (retryRequest.current?.answer !== answer) retryRequest.current = { answer, id: createRequestId() };
      const request = retryRequest.current;
      const data = await jsonFetch<unknown>(`/api/interviews/${interviewId}/turns/${turn.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": request.id },
        body: JSON.stringify({ answer }),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      const { retries, selected } = parseInterviewRetryResponse(data, request);
      // 重答只拥有重答历史；响应里的题目参考可能早于独立生成请求。
      onTurnUpdated({ retries });
      setSelectedVersion(selected);
      retryRequest.current = null;
      setIsRetrying(false);
      setRetryAnswer("");
    } catch (err) {
      if (isCurrent()) setRetryError(errorMessage(err));
    } finally {
      if (isCurrent()) {
        retryPending.current = null;
        setRetryBusy(false);
      }
    }
  }

  function openRetryPanel() {
    if (retryBusy || turn.retries_error) return;
    // 默认填入当前选中的回答内容方便用户在基础上修改，或者也可以留空
    setRetryAnswer(currentAnswer);
    setRetryError("");
    setIsRetrying(true);
  }

  return (
    <div id={`turn-${turn.id}`} className={`${cardCls} overflow-hidden shadow-sm transition-all`}>
      {/* 题头区域 */}
      <div className="border-b border-line bg-surface/50 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="shrink-0 font-mono text-sm font-bold text-primary">
              Q{turn.idx}
            </span>
            <span className={`${badgeCls} shrink-0`}>
              {turn.kind === "followup" ? "深入追问" : "核心主问"}
            </span>
            {originOverall !== null && (
              <span className="whitespace-nowrap text-xs text-muted">
                原答评分：
                <span className={`font-mono font-semibold ${scoreTextCls(originOverall)}`}>
                  {originOverall}
                </span>
              </span>
            )}
            {turn.retries.length > 0 && (
              <span className="inline-flex shrink-0 items-center rounded-md bg-accent/15 px-1.5 py-0.5 text-xs font-medium text-accent">
                已重答 {turn.retries.length} 次
              </span>
            )}
          </div>
          <NotebookStarButton
            source="interview"
            sourceId={turn.id}
            question={turn.question}
            notebookId={turn.notebook_id}
            onChanged={onNotebookChanged}
          />
        </div>
        <h3 className="mt-2 text-base font-semibold leading-relaxed text-ink whitespace-pre-wrap [overflow-wrap:anywhere]">
          {turn.question}
        </h3>
      </div>

      {/* 并排对比区：我的回答 vs 改进版参考答案 */}
      <div className="grid grid-cols-1 divide-y divide-line lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        {/* 左侧：我的作答 */}
        <div className="flex min-w-0 flex-col p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-ink">我的作答</span>
              {currentOverall !== null && (
                <span className={`font-mono text-sm font-bold ${scoreTextCls(currentOverall)}`}>
                  {currentOverall} 分
                </span>
              )}
              {scoreDiff !== null && (
                <span
                  className={`text-xs font-medium ${
                    scoreDiff > 0 ? "text-primary" : scoreDiff < 0 ? "text-danger" : "text-muted"
                  }`}
                >
                  ({scoreDiff > 0 ? `+${scoreDiff}` : scoreDiff} 较原答)
                </span>
              )}
            </div>

            {/* 版本切换胶囊 */}
            {turn.retries.length > 0 && (
              <div role="group" aria-label="作答版本" className="flex max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-line bg-bg p-0.5 text-xs">
                <button
                  type="button"
                  aria-pressed={isOrigin}
                  onClick={() => setSelectedVersion("origin")}
                  className={`shrink-0 whitespace-nowrap rounded-md px-2 py-1 transition-colors ${
                    isOrigin
                      ? "bg-primary text-on-primary font-medium shadow-xs"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  原答
                </button>
                {turn.retries.map((r, i) => {
                  const ov = calcOverall(r.scores);
                  const active = selectedVersion === i;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSelectedVersion(i)}
                      className={`shrink-0 whitespace-nowrap rounded-md px-2 py-1 transition-colors ${
                        active
                          ? "bg-primary text-on-primary font-medium shadow-xs"
                          : "text-muted hover:text-ink"
                      }`}
                    >
                      重答#{i + 1}
                      {ov !== null && <span className="ml-1 opacity-80">({ov})</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 回答正文 */}
          <div className="mt-3 grow rounded-lg bg-bg p-4 text-sm leading-relaxed text-ink whitespace-pre-wrap select-text border border-line/50">
            {currentAnswer || <span className="text-faint italic">{isOrigin ? "（未作答）" : "（该次重答未保存回答正文）"}</span>}
          </div>

          {/* 维度小评分 */}
          {isOrigin && turn.scores_error && <p role="alert" className={`mt-3 text-sm ${textErr}`}>{turn.scores_error}</p>}
          {currentScores && (
            <div className="mt-3 grid grid-cols-4 gap-1.5 rounded-lg bg-surface/60 p-2 text-center text-xs">
              {DIMENSIONS.map((d) => (
                <div key={d.key}>
                  <p className="text-muted">{d.label}</p>
                  <p className={`font-mono font-semibold ${scoreTextCls(currentScores[d.key])}`}>
                    {currentScores[d.key]}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* 面试官点评 */}
          {currentComment && (
            <div className="mt-3 rounded-lg border border-primary/20 bg-primary-soft/30 p-3 text-xs leading-relaxed text-muted">
              <span className="font-semibold text-primary">面试官点评：</span>
              {currentComment}
            </div>
          )}
        </div>

        {/* 右侧：改进版参考答案 */}
        <div className="flex flex-col bg-surface/25 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold text-ink">{isRetryReference ? "本次重答的回答参考" : "题目回答参考"}</span>
              <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                练习参考
              </span>
            </div>
            {currentReference && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void copy(currentReference)}
                  disabled={copying}
                  className="text-xs text-muted hover:text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {copiedText === currentReference ? "已复制 ✓" : "复制参考答案"}
                </button>
                {isRetryReference ? (
                  <button
                    type="button"
                    onClick={() => setSelectedVersion("origin")}
                    className="text-xs text-muted hover:text-primary transition-colors cursor-pointer"
                  >
                    查看题目参考
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleGenerateReference}
                    disabled={refBusy}
                    className="text-xs text-muted hover:text-primary transition-colors cursor-pointer disabled:opacity-50"
                    title="基于原题、原答与已提供背景重新生成题目参考"
                  >
                    {refBusy ? "生成中…" : "重新生成"}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 参考答案内容区 */}
          <div className="relative mt-3 grow">
            <LoadingOverlay
              show={refBusy && !isRetryReference}
              message="AI 正在生成回答参考…"
              description="正在依据题目、已提供的经历与岗位信息组织回答，请稍候…"
            />
            {currentReference ? (
              <div role="region" aria-label="当前回答参考" className="rounded-lg border border-accent/20 bg-card p-4 text-sm leading-relaxed text-ink whitespace-pre-wrap select-text shadow-2xs">
                {currentReference}
              </div>
            ) : (
              <div className="flex min-h-[160px] flex-col items-center justify-center rounded-lg border border-dashed border-line bg-card/60 p-6 text-center">
                <p className="text-xs text-muted">
                  当前尚未生成此题的改进版参考答案
                </p>
                <p className="mt-1 text-xs text-faint">
                  AI 可依据已提供的经历与岗位信息生成回答参考，未知内容仍需补充核实
                </p>
                <button
                  type="button"
                  onClick={handleGenerateReference}
                  disabled={refBusy}
                  className={`${btnGhost} mt-4 text-xs`}
                >
                  {refBusy ? "正在生成示范答案…" : "✨ 生成参考答案"}
                </button>
              </div>
            )}
            {refError && !isRetryReference && <p role="alert" className={`mt-2 text-xs ${textErr}`}>{refError}</p>}
            {copyError?.text === currentReference && <p role="alert" className={`mt-2 text-xs ${textErr}`}>{copyError.message}</p>}
          </div>

          <p className="mt-3 text-[11px] leading-normal text-faint">
            {isRetryReference
              ? "当前显示该次重答保存的参考。"
              : isOrigin
                ? "当前显示通用题目参考；重新生成时依据原题、原答与已提供背景。"
                : "该次重答未保存独立参考，当前回退到通用题目参考；重新生成时依据原题、原答与已提供背景。"}
            {" "}
            💡 提示：参考内容不代表你已具备其中的经历或能力。请核对个人分工、已验证成果与待补充信息，再用自己的真实经历练习表达。
          </p>
        </div>
      </div>

      {/* 底部重答触发栏 */}
      {turn.retries_error && <p role="alert" className={`border-t border-line px-5 py-3 text-sm ${textErr}`}>{turn.retries_error}</p>}
      <div className="flex items-center justify-between border-t border-line bg-surface/40 px-5 py-3">
        <span className="text-xs text-muted">
          {turn.retries_error
            ? "原答与题目参考仍可查看；重答暂时停用，请先核对历史记录。"
            : "对照参考答案觉得可以表现更好？随时可以发起重答检验提升。"}
        </span>
        <button
          type="button"
          onClick={() => {
            if (isRetrying) {
              setIsRetrying(false);
            } else {
              openRetryPanel();
            }
          }}
          disabled={retryBusy || Boolean(turn.retries_error)}
          className={`${btnGhost} text-xs`}
        >
          {isRetrying ? "收起重答面板" : "🔄 重答这一题"}
        </button>
      </div>

      {/* 展开的重答面板 */}
      {isRetrying && (
        <div className="relative border-t border-primary/20 bg-primary-soft/15 p-5 animate-in fade-in duration-200">
          <LoadingOverlay
            show={retryBusy}
            message="AI 正在重新打分与批阅…"
            description="正在对比原答评估技术深度与表达改进，请稍候…"
          />
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`retry-answer-${turn.id}`} className="text-sm font-semibold text-primary">
              重新作答此题（第 {turn.retries.length + 1} 次尝试）
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRetryAnswer(currentAnswer)}
                disabled={retryBusy}
                className="text-xs text-muted hover:text-ink cursor-pointer"
                title="将当前回答填入输入框"
              >
                导入当前作答做修改
              </button>
              <span className="text-line">|</span>
              <button
                type="button"
                onClick={() => setRetryAnswer("")}
                disabled={retryBusy}
                className="text-xs text-muted hover:text-ink cursor-pointer"
              >
                清空重新写
              </button>
            </div>
          </div>

          <textarea
            id={`retry-answer-${turn.id}`}
            className={`${textareaCls} mt-2.5 bg-card`}
            value={retryAnswer}
            onChange={(e) => setRetryAnswer(e.target.value)}
            placeholder="根据参考答案与面试官点评，输入你更满意的完整回答…"
            disabled={retryBusy}
          />

          {retryError && <p role="alert" className={`mt-2 text-xs ${textErr}`}>{retryError}</p>}

          <div className="mt-3 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setIsRetrying(false)}
              disabled={retryBusy}
              className={btnGhost}
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSubmitRetry}
              disabled={retryBusy || !retryAnswer.trim() || Boolean(turn.retries_error)}
              className={btnPrimary}
            >
              {retryBusy ? "面试官正在评分中…" : "提交并重新评分"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
