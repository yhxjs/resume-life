"use client";

import { useEffect, useRef, useState } from "react";
import { Loading } from "@/components/common/ui-bits";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { useReviewSubmission } from "@/hooks/use-review-submission";
import { readReviewDetail } from "@/lib/review-records";
import { REVIEW_GRADE_LABELS, REVIEW_MASTERY_LABELS, type ReviewCard, type ReviewDetail, type ReviewGrade } from "@/lib/spaced-repetition-card-types";
import { badgeCls, btnGhost, btnPrimary, textareaTallCls } from "@/lib/ui";
import { ReviewHistory } from "./review-history";

const GRADES: ReviewGrade[] = ["again", "hard", "good", "easy"];
const GRADE_HINTS: Record<ReviewGrade, string> = {
  again: "关键内容想不起来", hard: "需要提示才能答全", good: "能独立答出主要内容", easy: "完整、流畅地回答",
};

export function ReviewSession({ cardId, onSaved, onClose }: { cardId: number; onSaved: () => void; onClose: () => void }) {
  return <ReviewSessionBody key={cardId} cardId={cardId} onSaved={onSaved} onClose={onClose} />;
}

function ReviewSessionBody({ cardId, onSaved, onClose }: { cardId: number; onSaved: () => void; onClose: () => void }) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [answer, setAnswer] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [grade, setGrade] = useState<ReviewGrade | null>(null);
  const [saved, setSaved] = useState<ReviewCard | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [reloading, setReloading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [originalOpen, setOriginalOpen] = useState(false);
  const [historyStale, setHistoryStale] = useState(false);
  const readPending = useRef(false); const confirmed = useRef(false);
  const submission = useReviewSubmission(result => {
    confirmed.current = true;
    setSaved(result.card);
    setDetail(previous => previous ? { ...previous, ...result.card } : previous);
    setHistoryStale(true);
    readPending.current = true; setReloading(true); setReloadVersion(value => value + 1);
    window.dispatchEvent(new Event("reviews-updated"));
    onSaved();
  });
  const { clearConflict } = submission;
  const { busy, conflict, error: saveError } = submission;
  const saving = submission.phase === "posting" || submission.phase === "checking";

  useEffect(() => {
    const controller = new AbortController();
    readPending.current = true;
    jsonFetch<unknown>(`/api/reviews/${cardId}?limit=20&time_zone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, { signal: controller.signal, cache: "no-store" })
      .then((data) => {
        if (controller.signal.aborted) return;
        const value = readReviewDetail(data, cardId);
        setDetail(value);
        setSaved(previous => previous ? value : previous);
        setHistoryStale(false);
        setLoadError("");
        clearConflict();
        readPending.current = false;
        setReloading(false);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLoadError(errorMessage(error));
        readPending.current = false;
        setReloading(false);
      });
    return () => { controller.abort(); };
  }, [cardId, reloadVersion, clearConflict]);

  function reload() {
    if (readPending.current || !submission.canStart()) return;
    readPending.current = true;
    setReloading(true);
    setLoadError("");
    setReloadVersion((value) => value + 1);
  }

  function save() {
    if (!detail || !answer.trim() || !revealed || !grade || conflict || confirmed.current || readPending.current || !submission.canStart()) return;
    void submission.save({ cardId, answer, grade, expectedReviewCount: detail.review_count, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  }

  return (
    <section aria-label="独立回忆复习" className="mx-auto max-w-3xl space-y-5">
      <button type="button" className={btnGhost} onClick={onClose} disabled={busy || reloading}>← 返回复习列表</button>
      {loadError && (
        <div role="alert" className="space-y-3 rounded-xl border border-danger/30 bg-danger-wash p-4 text-sm text-danger">
          <p className="[overflow-wrap:anywhere]">{loadError}</p>
          <button type="button" className={btnGhost} onClick={reload} disabled={reloading}>重试加载</button>
        </div>
      )}
      {!detail && !loadError && <Loading label="正在加载复习题目" />}
      {detail && (
        <>
          <div className="space-y-4 rounded-xl border border-line bg-card p-4 sm:p-6">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className={badgeCls}>{detail.source === "notebook" ? "错题本" : "面试追练"}</span>
              <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{detail.source_label}</span>
              <span>{REVIEW_MASTERY_LABELS[detail.mastery]}</span>
            </div>
            <h2 className="whitespace-pre-wrap font-serif text-xl font-bold leading-relaxed text-ink [overflow-wrap:anywhere]">{detail.question}</h2>
            {saved ? (
              <>
                <div role="status" className="rounded-lg bg-primary-soft p-4 text-primary">
                  <p className="font-medium">本次复习已保存</p>
                  <p className="mt-1 text-sm">下次复习：<time className="font-mono">{saved.next_review_date}</time> · {REVIEW_MASTERY_LABELS[saved.mastery]}</p>
                </div>
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">本次回答</h3>
                  <p className="max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed">{answer}</p>
                </div>
                <button type="button" className={btnPrimary} onClick={onClose}>继续复习其他题目</button>
              </>
            ) : (
              <div className="space-y-3 border-t border-line pt-4">
                <label htmlFor="review-answer" className="block text-sm font-medium">本次回答</label>
                <p id="review-answer-hint" className="max-w-prose text-sm text-muted">先不看资料，尝试凭记忆作答。实在想不起来，也请写下卡住的地方，再查看参考并自评。</p>
                <textarea id="review-answer" aria-describedby="review-answer-hint" maxLength={20000} className={textareaTallCls} value={answer}
                  onChange={(event) => { if (submission.canStart() && !readPending.current) setAnswer(event.target.value); }} disabled={busy || reloading} placeholder="从空白开始，写下你现在能回忆起的内容…" />
                {!revealed && <button type="button" className={btnPrimary} disabled={!answer.trim() || reloading} onClick={() => setRevealed(true)}>查看参考并自评</button>}
              </div>
            )}
          </div>
          {revealed && (
            <div className="space-y-5 rounded-xl border border-line bg-card p-4 sm:p-6">
              <div className="space-y-2">
                <h3 className="font-serif text-base font-bold">参考答案</h3>
                <p className="max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed">{detail.reference || "这道题暂无参考答案，可结合已学内容判断本次回忆。"}</p>
              </div>
              {detail.comment && <div className="space-y-2 border-t border-line pt-4"><h3 className="text-sm font-medium">原始点评</h3><p className="max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">{detail.comment}</p></div>}
              {!saved && (
                <div className="space-y-4 border-t border-line pt-4">
                  <fieldset disabled={busy || reloading || conflict}>
                    <legend className="mb-3 text-sm font-medium">自评掌握程度</legend>
                    <div role="group" aria-label="自评掌握程度" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {GRADES.map((value) => <button key={value} type="button" aria-pressed={grade === value} onClick={() => { if (submission.canStart() && !readPending.current) setGrade(value); }}
                        className={`min-h-16 rounded-lg border px-3 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50 ${grade === value ? "border-primary bg-primary-soft text-primary" : "border-line-strong text-ink hover:bg-surface"}`}>
                        <span className="block text-sm font-medium">{REVIEW_GRADE_LABELS[value]}</span><span className="mt-1 block text-xs text-muted">{GRADE_HINTS[value]}</span>
                      </button>)}
                    </div>
                  </fieldset>
                  <p className="text-xs leading-relaxed text-muted">自评用于安排下次复习，掌握状态反映复习进度，不代表真实记忆概率。</p>
                  {saveError && <div role="alert" className="space-y-2 text-sm text-danger"><p className="[overflow-wrap:anywhere]">{saveError} 本次回答仍已保留。</p><div className="flex flex-wrap gap-2">
                    {conflict && <button type="button" className={btnGhost} onClick={reload} disabled={reloading}>{reloading ? "正在更新进度…" : "重新加载最新进度"}</button>}
                    {(submission.phase === "unknown" || submission.phase === "missing") && <button type="button" className={btnGhost} onClick={submission.reread}>重新读取保存状态</button>}
                    {submission.phase === "missing" && <button type="button" className={btnGhost} onClick={submission.retry}>重试同一提交</button>}
                  </div></div>}
                  <button type="button" className={btnPrimary} onClick={save} disabled={!answer.trim() || !grade || busy || conflict || reloading}>{saving ? "正在保存…" : "保存本次复习"}</button>
                </div>
              )}
              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                <button type="button" className={btnGhost} aria-expanded={originalOpen} onClick={() => setOriginalOpen(!originalOpen)}>{originalOpen ? "收起原始作答" : "查看原始作答"}</button>
                <button type="button" className={btnGhost} aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>{historyOpen ? "收起复习历史" : "查看复习历史"}</button>
              </div>
              {originalOpen && <p className="max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">{detail.answer || "收藏时尚未作答。"}</p>}
              {historyOpen && (historyStale ? <p role="status" className="text-sm text-muted">{reloading ? "正在读取最新复习历史…" : "历史尚未刷新，请通过顶部重试入口重新读取。"}</p> : <ReviewHistory key={`${cardId}:${detail.review_count}`} cardId={cardId} initialAttempts={detail.attempts} initialCursor={detail.nextCursor} />)}
            </div>
          )}
        </>
      )}
    </section>
  );
}
