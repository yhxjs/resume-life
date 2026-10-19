"use client";

import { useEffect, useRef, useState } from "react";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { REVIEW_GRADE_LABELS, type ReviewAttempt, type ReviewDetail } from "@/lib/spaced-repetition-card-types";
import { badgeCls, btnGhost } from "@/lib/ui";

export function ReviewHistory({ cardId, initialAttempts, initialCursor }: { cardId: number; initialAttempts: ReviewAttempt[]; initialCursor: string | null }) {
  const [attempts, setAttempts] = useState(initialAttempts);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);

  async function loadMore() {
    if (!cursor || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError("");
    try {
      const data = await jsonFetch<ReviewDetail>(`/api/reviews/${cardId}?limit=20&cursor=${encodeURIComponent(cursor)}&time_zone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setAttempts((previous) => [...previous, ...data.attempts.filter((attempt) => !previous.some((item) => item.id === attempt.id))]);
      setCursor(data.nextCursor);
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return <section aria-label="复习历史记录" className="space-y-3 border-t border-line pt-4">
    <h3 className="font-serif text-base font-bold">复习历史</h3>
    {attempts.length === 0 ? <p className="text-sm text-muted">还没有复习记录，保存本次回答后会出现在这里。</p> :
      <ol className="divide-y divide-line">{attempts.map((attempt) => <li key={attempt.id} className="space-y-2 py-4 first:pt-0">
        <div className="flex flex-wrap items-center gap-2"><span className={badgeCls}>{REVIEW_GRADE_LABELS[attempt.grade]}</span><time dateTime={attempt.reviewed_at} className="text-xs text-muted">{new Date(attempt.reviewed_at).toLocaleString("zh-CN")}</time></div>
        <p className="max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed">{attempt.answer}</p>
        <p className="text-xs text-muted">当次间隔 {attempt.interval_days} 天 · 安排至 <time>{attempt.next_review_date}</time></p>
      </li>)}</ol>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {cursor && <button type="button" className={btnGhost} disabled={loading} onClick={loadMore}>{loading ? "正在加载历史…" : error ? "重试加载历史" : "加载更多历史"}</button>}
  </section>;
}
