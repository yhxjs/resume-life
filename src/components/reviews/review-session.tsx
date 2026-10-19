"use client";

import { useEffect, useRef, useState } from "react";
import { Loading } from "@/components/common/ui-bits";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { REVIEW_GRADE_LABELS, REVIEW_MASTERY_LABELS, type ReviewAttempt, type ReviewCard, type ReviewDetail, type ReviewGrade } from "@/lib/spaced-repetition-card-types";
import { badgeCls, btnGhost, btnPrimary, textareaTallCls } from "@/lib/ui";
import { ReviewHistory } from "./review-history";

const GRADES: ReviewGrade[] = ["again", "hard", "good", "easy"];
const GRADE_HINTS: Record<ReviewGrade, string> = {
  again: "关键内容想不起来", hard: "需要提示才能答全", good: "能独立答出主要内容", easy: "完整、流畅地回答",
};

function createRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // 局域网 HTTP 下 randomUUID 不可用，getRandomValues 仍可生成 UUID v4。
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function ReviewSession({ cardId, onSaved, onClose }: { cardId: number; onSaved: () => void; onClose: () => void }) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [answer, setAnswer] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [grade, setGrade] = useState<ReviewGrade | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState<ReviewCard | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [reloading, setReloading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [originalOpen, setOriginalOpen] = useState(false);
  const mounted = useRef(false);
  const savingRef = useRef(false);
  const request = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    jsonFetch<ReviewDetail>(`/api/reviews/${cardId}?limit=20&time_zone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setDetail(data);
        setLoadError("");
        setConflict(false);
        setSaveError("");
        setReloading(false);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLoadError(errorMessage(error));
        setReloading(false);
      });
    return () => { mounted.current = false; controller.abort(); };
  }, [cardId, reloadVersion]);

  function reload() {
    setReloading(true);
    setLoadError("");
    request.current = null;
    setReloadVersion((value) => value + 1);
  }

  async function save() {
    if (!detail || !answer.trim() || !revealed || !grade || conflict || saved || reloading || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const key = JSON.stringify([answer, grade, detail.review_count]);
      if (request.current?.key !== key) request.current = { key, id: createRequestId() };
      const result = await jsonFetch<{ card: ReviewCard; attempt: ReviewAttempt }>(`/api/reviews/${cardId}`, {
        method: "POST",
        body: JSON.stringify({
          answer, grade, expected_review_count: detail.review_count, request_id: request.current.id,
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (!mounted.current) return;
      setSaved(result.card);
      setDetail({ ...detail, ...result.card, attempts: [result.attempt, ...detail.attempts] });
      window.dispatchEvent(new Event("reviews-updated"));
      onSaved();
    } catch (error) {
      if (!mounted.current) return;
      setSaveError(errorMessage(error));
      if (error instanceof HttpError && error.status === 409) setConflict(true);
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <section aria-label="独立回忆复习" className="mx-auto max-w-3xl space-y-5">
      <button type="button" className={btnGhost} onClick={onClose} disabled={saving}>← 返回复习列表</button>
      {loadError && (
        <div role="alert" className="space-y-3 rounded-xl border border-danger/30 bg-danger-wash p-4 text-sm text-danger">
          <p>{loadError}</p>
          <button type="button" className={btnGhost} onClick={reload} disabled={reloading}>重试加载</button>
        </div>
      )}
      {!detail && !loadError && <Loading label="正在加载复习题目" />}
      {detail && (
        <>
          <div className="space-y-4 rounded-xl border border-line bg-card p-4 sm:p-6">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className={badgeCls}>{detail.source === "notebook" ? "错题本" : "面试追练"}</span>
              <span>{detail.source_label}</span>
              <span>{REVIEW_MASTERY_LABELS[detail.mastery]}</span>
            </div>
            <h2 className="break-words font-serif text-xl font-bold leading-relaxed text-ink">{detail.question}</h2>
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
                  onChange={(event) => setAnswer(event.target.value)} disabled={saving || reloading} placeholder="从空白开始，写下你现在能回忆起的内容…" />
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
                  <fieldset disabled={saving || reloading || conflict}>
                    <legend className="mb-3 text-sm font-medium">自评掌握程度</legend>
                    <div role="group" aria-label="自评掌握程度" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {GRADES.map((value) => <button key={value} type="button" aria-pressed={grade === value} onClick={() => setGrade(value)}
                        className={`min-h-16 rounded-lg border px-3 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50 ${grade === value ? "border-primary bg-primary-soft text-primary" : "border-line-strong text-ink hover:bg-surface"}`}>
                        <span className="block text-sm font-medium">{REVIEW_GRADE_LABELS[value]}</span><span className="mt-1 block text-xs text-muted">{GRADE_HINTS[value]}</span>
                      </button>)}
                    </div>
                  </fieldset>
                  <p className="text-xs leading-relaxed text-muted">自评用于安排下次复习，掌握状态反映复习进度，不代表真实记忆概率。</p>
                  {saveError && <div role="alert" className="space-y-2 text-sm text-danger"><p>{saveError}，本次回答仍已保留。</p>{conflict && <button type="button" className={btnGhost} onClick={reload} disabled={reloading}>{reloading ? "正在更新进度…" : "重新加载最新进度"}</button>}</div>}
                  <button type="button" className={btnPrimary} onClick={save} disabled={!answer.trim() || !grade || saving || conflict || reloading}>{saving ? "正在保存…" : "保存本次复习"}</button>
                </div>
              )}
              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                <button type="button" className={btnGhost} aria-expanded={originalOpen} onClick={() => setOriginalOpen(!originalOpen)}>{originalOpen ? "收起原始作答" : "查看原始作答"}</button>
                <button type="button" className={btnGhost} aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>{historyOpen ? "收起复习历史" : "查看复习历史"}</button>
              </div>
              {originalOpen && <p className="max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">{detail.answer || "收藏时尚未作答。"}</p>}
              {historyOpen && <ReviewHistory key={`${cardId}:${detail.review_count}`} cardId={cardId} initialAttempts={detail.attempts} initialCursor={detail.nextCursor} />}
            </div>
          )}
        </>
      )}
    </section>
  );
}
