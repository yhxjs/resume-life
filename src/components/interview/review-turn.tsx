"use client";

import { useState } from "react";
import { DIMENSIONS, type ScoreMap } from "@/lib/scores";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { badgeCls, btnGhost, btnPrimary, cardCls, textareaCls, scoreTextCls, textErr } from "@/lib/ui";
import { NotebookStarButton } from "@/components/notebook";
import { errorMessage } from "@/lib/error-message";
import { jsonFetch } from "@/lib/fetcher";
import { LoadingOverlay } from "@/components/common/loading-overlay";

export type TurnRetry = {
  id: string;
  answer: string;
  scores: ScoreMap | null;
  comment: string;
  reference?: string;
  created_at: string;
};

export type ReviewTurnData = {
  id: number;
  idx: number;
  kind: string;
  question: string;
  answer: string;
  comment: string;
  scores: ScoreMap | null;
  reference: string;
  retries: TurnRetry[];
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

export function InterviewReviewTurn({
  interviewId,
  turn,
  onTurnUpdated,
  onNotebookChanged,
}: InterviewReviewTurnProps) {
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
  const { copiedText, copy: copyToClipboard } = useCopyFeedback();

  // 当前左侧展示的作答内容
  const isOrigin = selectedVersion === "origin";
  const currentRetry = !isOrigin && typeof selectedVersion === "number" ? turn.retries[selectedVersion] : null;

  const currentAnswer = isOrigin ? turn.answer : currentRetry?.answer ?? "";
  const currentScores = isOrigin ? turn.scores : currentRetry?.scores ?? null;
  const currentComment = isOrigin ? turn.comment : currentRetry?.comment ?? "";

  const originOverall = calcOverall(turn.scores);
  const currentOverall = calcOverall(currentScores);
  const scoreDiff =
    !isOrigin && originOverall !== null && currentOverall !== null
      ? Math.round((currentOverall - originOverall) * 10) / 10
      : null;

  // 生成参考答案
  async function handleGenerateReference() {
    setRefBusy(true);
    setRefError("");
    try {
      const data = await jsonFetch<{ reference?: string }>(
        `/api/interviews/${interviewId}/turns/${turn.id}/reference`,
        { method: "POST" }
      );
      if (data.reference) {
        onTurnUpdated({ reference: data.reference });
      }
    } catch (err) {
      setRefError(errorMessage(err));
    } finally {
      setRefBusy(false);
    }
  }

  // 提交重答
  async function handleSubmitRetry() {
    if (!retryAnswer.trim()) {
      setRetryError("请输入回答内容");
      return;
    }
    setRetryBusy(true);
    setRetryError("");
    try {
      const data = await jsonFetch<{
        retry?: TurnRetry;
        retries?: TurnRetry[];
        reference?: string;
      }>(`/api/interviews/${interviewId}/turns/${turn.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: retryAnswer.trim() }),
      });
      if (data.retries) {
        onTurnUpdated({
          retries: data.retries,
          reference: data.reference || turn.reference,
        });
        setSelectedVersion(data.retries.length - 1);
        setIsRetrying(false);
        setRetryAnswer("");
      }
    } catch (err) {
      setRetryError(errorMessage(err));
    } finally {
      setRetryBusy(false);
    }
  }

  async function handleCopyReference() {
    if (!turn.reference) return;
    setRefError("");
    if (!(await copyToClipboard(turn.reference))) setRefError("复制失败，请检查浏览器剪贴板权限");
  }

  function openRetryPanel() {
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
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold text-primary">
              Q{turn.idx}
            </span>
            <span className={badgeCls}>
              {turn.kind === "followup" ? "深入追问" : "核心主问"}
            </span>
            {originOverall !== null && (
              <span className="text-xs text-muted">
                原答评分：
                <span className={`font-mono font-semibold ${scoreTextCls(originOverall)}`}>
                  {originOverall}
                </span>
              </span>
            )}
            {turn.retries.length > 0 && (
              <span className="inline-flex items-center rounded-md bg-accent/15 px-1.5 py-0.5 text-xs font-medium text-accent">
                已重答 {turn.retries.length} 次
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <NotebookStarButton
              source="interview"
              sourceId={turn.id}
              question={turn.question}
              notebookId={turn.notebook_id}
              onChanged={onNotebookChanged}
            />
          </div>
        </div>
        <h3 className="mt-2 text-base font-semibold leading-relaxed text-ink">
          {turn.question}
        </h3>
      </div>

      {/* 并排对比区：我的回答 vs 改进版参考答案 */}
      <div className="grid grid-cols-1 divide-y divide-line lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        {/* 左侧：我的作答 */}
        <div className="flex flex-col p-5">
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
              <div className="flex items-center rounded-lg border border-line bg-bg p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setSelectedVersion("origin")}
                  className={`rounded-md px-2 py-1 transition-colors ${
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
                      onClick={() => setSelectedVersion(i)}
                      className={`rounded-md px-2 py-1 transition-colors ${
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
            {currentAnswer || <span className="text-faint italic">（未作答）</span>}
          </div>

          {/* 维度小评分 */}
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
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-ink">改进版参考答案</span>
              <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                高分示范
              </span>
            </div>
            {turn.reference && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopyReference()}
                  className="text-xs text-muted hover:text-primary transition-colors cursor-pointer"
                >
                  {copiedText !== null ? "已复制 ✓" : "复制参考答案"}
                </button>
                <button
                  type="button"
                  onClick={handleGenerateReference}
                  disabled={refBusy}
                  className="text-xs text-muted hover:text-primary transition-colors cursor-pointer disabled:opacity-50"
                  title="重新生成改进示范"
                >
                  {refBusy ? "生成中…" : "重新生成"}
                </button>
              </div>
            )}
          </div>

          {/* 参考答案内容区 */}
          <div className="relative mt-3 grow">
            <LoadingOverlay
              show={refBusy}
              message="AI 正在命制满分参考答案…"
              description="正在融入岗位痛点、架构权衡与 STAR 结构化表达，请稍候…"
            />
            {turn.reference ? (
              <div className="rounded-lg border border-accent/20 bg-card p-4 text-sm leading-relaxed text-ink whitespace-pre-wrap select-text shadow-2xs">
                {turn.reference}
              </div>
            ) : (
              <div className="flex min-h-[160px] flex-col items-center justify-center rounded-lg border border-dashed border-line bg-card/60 p-6 text-center">
                <p className="text-xs text-muted">
                  当前尚未生成此题的改进版参考答案
                </p>
                <p className="mt-1 text-xs text-faint">
                  AI 可根据你的简历与岗位要求，生成结构化的满分标杆回答
                </p>
                <button
                  type="button"
                  onClick={handleGenerateReference}
                  disabled={refBusy}
                  className={`${btnGhost} mt-4 text-xs`}
                >
                  {refBusy ? "正在生成示范答案…" : "✨ 生成参考答案"}
                </button>
                {refError && <p className={`mt-2 text-xs ${textErr}`}>{refError}</p>}
              </div>
            )}
          </div>

          <p className="mt-3 text-[11px] leading-normal text-faint">
            💡 提示：参考答案融入了岗位核心要求与 STAR 结构化表达，可参考其切入点与要点权衡。
          </p>
        </div>
      </div>

      {/* 底部重答触发栏 */}
      <div className="flex items-center justify-between border-t border-line bg-surface/40 px-5 py-3">
        <span className="text-xs text-muted">
          对照参考答案觉得可以表现更好？随时可以发起重答检验提升。
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
            <span className="text-sm font-semibold text-primary">
              重新作答此题（第 {turn.retries.length + 1} 次尝试）
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRetryAnswer(currentAnswer)}
                className="text-xs text-muted hover:text-ink cursor-pointer"
                title="将当前回答填入输入框"
              >
                导入当前作答做修改
              </button>
              <span className="text-line">|</span>
              <button
                type="button"
                onClick={() => setRetryAnswer("")}
                className="text-xs text-muted hover:text-ink cursor-pointer"
              >
                清空重新写
              </button>
            </div>
          </div>

          <textarea
            className={`${textareaCls} mt-2.5 bg-card`}
            value={retryAnswer}
            onChange={(e) => setRetryAnswer(e.target.value)}
            placeholder="根据参考答案与面试官点评，输入你更满意的完整回答…"
            disabled={retryBusy}
          />

          {retryError && <p className={`mt-2 text-xs ${textErr}`}>{retryError}</p>}

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
              disabled={retryBusy || !retryAnswer.trim()}
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
