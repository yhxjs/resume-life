"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ModalCore } from "@/components/common/modal-core";
import { confirmDialog } from "@/components/common/confirm-dialog";
import type { Application, ApplicationInterview } from "@/lib/applications-types";
import type { InterviewRecap, InterviewReviewQuestion, ReviewExportAction } from "@/lib/application-interview-review";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { btnGhost, btnPrimary, inputCls, labelCls } from "@/lib/ui";

type ReviewResponse = {
  questions: InterviewReviewQuestion[];
  input_hash: string;
  latest: InterviewRecap | null;
  selected: InterviewRecap | null;
  history: { id: number; created_at: string; input_hash: string }[];
};

type QuestionDraft = InterviewReviewQuestion & { clientId: number };
const emptyQuestion = (): InterviewReviewQuestion => ({ question: "", answer: "", stuck: "", feedback: "" });

function ResultList<T extends { question_index: number }>({ title, entries, recap, action, renderEntry }: {
  title: string;
  entries: T[];
  recap: InterviewRecap;
  action?: ReactNode;
  renderEntry: (entry: T) => ReactNode;
}) {
  return <div className="mt-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-xs font-semibold text-muted">{title} <span className="font-mono">{entries.length}</span></h4>
      {entries.length > 0 && action}
    </div>
    {entries.length === 0 ? <p className="mt-2 text-sm text-muted">暂无{title}</p> : <ol className="mt-2 divide-y divide-line border-t border-line text-sm leading-relaxed">
      {entries.map((entry, index) => <li key={index} className="py-3">
        <p className="text-xs text-primary">第 {entry.question_index} 题 · {recap.questions[entry.question_index - 1]?.question}</p>
        {renderEntry(entry)}
      </li>)}
    </ol>}
  </div>;
}

export function ApplicationInterviewReviewDialog({ application, interview, onClose }: {
  application: Application;
  interview: ApplicationInterview;
  onClose: () => void;
}) {
  const router = useRouter();
  const base = `/api/applications/${application.id}/interviews/${interview.id}/review`;
  const formId = useId();
  const nextClientId = useRef(0);
  const [data, setData] = useState<ReviewResponse | null>(null);
  const [draft, setDraft] = useState<QuestionDraft[]>([]);
  const [busy, setBusy] = useState<"saving" | "generating" | ReviewExportAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    jsonFetch<ReviewResponse>(base, { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setData(value);
      setDraft(value.questions.map((item) => ({ ...item, clientId: ++nextClientId.current })));
      setLoading(false);
    }).catch((reason) => {
      if (!controller.signal.aborted) { setError(errorMessage(reason)); setLoading(false); }
    });
    return () => controller.abort();
  }, [base]);

  const questions = draft.map(({ question, answer, stuck, feedback }) => ({ question, answer, stuck, feedback }));
  const dirty = data !== null && JSON.stringify(questions) !== JSON.stringify(data.questions);
  const canConfirm = data !== null && !dirty && data.questions.length > 0 && data.latest?.input_hash !== data.input_hash;
  const recap = data?.selected ?? data?.latest;

  async function close() {
    if (busy) return;
    if (dirty && !await confirmDialog({ title: "放弃未保存的逐题记录？", message: "本次编辑尚未保存。", confirmText: "放弃编辑" })) return;
    onClose();
  }

  function updateQuestion(clientId: number, key: keyof InterviewReviewQuestion, value: string) {
    setDraft((current) => current.map((item) => item.clientId === clientId ? { ...item, [key]: value } : item));
    setError("");
    setNotice("");
  }

  async function save() {
    if (!data || busy || !dirty) return;
    if (questions.some((item) => !item.question.trim())) { setError("请填写每题的提问，或删除空白题目"); return; }
    setBusy("saving"); setError(""); setNotice("");
    try {
      const saved = await jsonFetch<ReviewResponse>(base, { method: "PUT", body: JSON.stringify({ expected_hash: data.input_hash, questions }) });
      setData(saved);
      setDraft(saved.questions.map((item) => ({ ...item, clientId: ++nextClientId.current })));
      setNotice("逐题记录已保存");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(null); }
  }

  async function confirm() {
    if (!data || !canConfirm || busy) return;
    setBusy("generating"); setError(""); setNotice("");
    try {
      const saved = await jsonFetch<ReviewResponse>(base, { method: "POST", body: JSON.stringify({ expected_hash: data.input_hash }) });
      setData(saved);
      setNotice("复盘结果已保存");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(null); }
  }

  async function exportResult(action: ReviewExportAction) {
    if (!recap || busy) return;
    const labels = {
      mistakes: { title: "加入错题本？", message: `将当前复盘的 ${recap.result.mistakes.length} 道错题加入错题本，并安排复习。`, confirmText: "确认加入" },
      drills: { title: "开始追练？", message: `将当前复盘的 ${recap.result.drills.length} 道追练题创建为一套练习并打开。`, confirmText: "创建并开始" },
      resume_suggestions: { title: "创建修改待办？", message: `将当前复盘的 ${recap.result.resume_suggestions.length} 条简历建议加入此投递的准备待办。`, confirmText: "确认创建" },
    };
    setBusy(action); setError(""); setNotice("");
    try {
      if (!await confirmDialog(labels[action])) return;
      const saved = await jsonFetch<ReviewResponse & { drill_id: number | null }>(`${base}/export`, {
        method: "POST", body: JSON.stringify({ recap_id: recap.id, action }),
      });
      setData(saved);
      if (action === "drills" && saved.drill_id) router.push(`/drills/${saved.drill_id}`);
      else setNotice(action === "mistakes" ? "错题已加入错题本" : "简历修改待办已创建");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(null); }
  }

  async function selectRecap(id: number) {
    if (!data || busy) return;
    if (id === data.latest?.id) { setData({ ...data, selected: null }); return; }
    setError("");
    try {
      const loaded = await jsonFetch<ReviewResponse>(`${base}?recap_id=${id}`);
      setData(loaded);
    } catch (reason) { setError(errorMessage(reason)); }
  }

  return <ModalCore
    open
    onClose={() => void close()}
    title={`逐题复盘 · ${interview.round_name}`}
    surface="drawer"
    closeOnBackdrop={!busy}
    escapeDisabled={Boolean(busy)}
    loading={busy === "generating" || busy === "saving"}
    loadingText={busy === "generating" ? "AI 正在深度复盘面试全过程…" : "正在保存逐题记录…"}
    loadingDescription={busy === "generating" ? "正在分析逐题作答情况、卡壳深层原因与改进突破口，生成错题与追练建议，请稍候…" : undefined}
  >
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-4 sm:px-6">
        <div className="min-w-0">
          <h2 className="font-serif text-lg font-bold text-ink">{interview.round_name} · 逐题复盘</h2>
          <p className="mt-1 break-words text-xs text-muted">{application.company} · {application.role}</p>
        </div>
        <button type="button" aria-label="关闭逐题复盘" className="rounded p-1 text-muted hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-primary" onClick={() => void close()} disabled={Boolean(busy)}>×</button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        {loading && <p role="status" className="text-sm text-muted">正在加载逐题记录…</p>}
        {error && <div role="alert" className="mb-4 rounded border border-danger/30 bg-danger-wash p-3 text-sm text-danger">{error}</div>}
        {notice && <p role="status" className="mb-4 text-sm text-primary">{notice}</p>}
        {!loading && !data && <button type="button" className={btnGhost} onClick={() => { setLoading(true); setError(""); jsonFetch<ReviewResponse>(base).then((value) => { setData(value); setDraft(value.questions.map((item) => ({ ...item, clientId: ++nextClientId.current }))); }).catch((reason) => setError(errorMessage(reason))).finally(() => setLoading(false)); }}>重试加载</button>}
        {data && <>
          <section aria-label="逐题记录">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink">逐题记录 <span className="font-mono text-xs text-muted">{draft.length}</span></h3>
              <button type="button" className={btnGhost} disabled={Boolean(busy) || draft.length >= 20} onClick={() => setDraft((current) => [...current, { ...emptyQuestion(), clientId: ++nextClientId.current }])}>添加题目</button>
            </div>
            {draft.length === 0 && <p className="mt-5 text-sm text-muted">还没有逐题记录</p>}
            <div className="mt-4 space-y-5">
              {draft.map((item, index) => <div key={item.clientId} className="border-t border-line pt-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold text-ink">第 {index + 1} 题</h4>
                  <button type="button" className="rounded px-2 py-1 text-xs text-danger hover:bg-danger-wash focus-visible:outline-2 focus-visible:outline-danger" disabled={Boolean(busy)} onClick={() => setDraft((current) => current.filter((entry) => entry.clientId !== item.clientId))}>删除本题</button>
                </div>
                {([ ["question", "问了什么"], ["answer", "怎么回答"], ["stuck", "卡在哪里"], ["feedback", "对方反馈"] ] as const).map(([key, label]) => <div key={key} className="mt-3">
                  <label htmlFor={`${formId}-${item.clientId}-${key}`} className={labelCls}>{label}{key === "question" && <span className="text-danger"> *</span>}</label>
                  <textarea id={`${formId}-${item.clientId}-${key}`} aria-label={label} className={`${inputCls} mt-1 min-h-20 resize-y leading-relaxed`} rows={key === "question" ? 2 : 3} maxLength={2000} value={item[key]} onChange={(event) => updateQuestion(item.clientId, key, event.target.value)} disabled={Boolean(busy)} />
                </div>)}
              </div>)}
            </div>
          </section>

          {recap && <section aria-label="复盘结果" className="mt-8 border-t border-line pt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink">复盘结果</h3>
              {data.history.length > 1 && <select aria-label="复盘版本" className={`${inputCls} w-auto max-w-full text-xs`} value={recap.id} onChange={(event) => void selectRecap(Number(event.target.value))}>
                {data.history.map((entry) => <option key={entry.id} value={entry.id}>{new Date(entry.created_at).toLocaleString()} · #{entry.id}</option>)}
              </select>}
            </div>
            <p className="mt-2 text-xs text-muted">{new Date(recap.created_at).toLocaleString()} · {recap.questions.length} 题</p>
            <ResultList title="错题" entries={recap.result.mistakes} recap={recap} action={<button type="button" className={btnGhost} disabled={Boolean(busy) || recap.exports.mistakes} onClick={() => void exportResult("mistakes")}>{recap.exports.mistakes ? "已加入错题本" : busy === "mistakes" ? "处理中…" : "加入错题本"}</button>} renderEntry={(entry) => <><p className="mt-1 text-muted">{entry.gap}</p><p className="mt-2 whitespace-pre-wrap">{entry.improved_answer}</p></>} />
            <ResultList title="追练题" entries={recap.result.drills} recap={recap} action={<button type="button" className={btnGhost} disabled={Boolean(busy)} onClick={() => recap.exports.drills ? router.push(`/drills/${recap.exports.drills}`) : void exportResult("drills")}>{recap.exports.drills ? "继续追练" : busy === "drills" ? "创建中…" : "开始追练"}</button>} renderEntry={(entry) => <p className="mt-1 whitespace-pre-wrap">{entry.question}</p>} />
            <ResultList title="简历修改建议" entries={recap.result.resume_suggestions} recap={recap} action={<button type="button" className={btnGhost} disabled={Boolean(busy) || recap.exports.resume_suggestions} onClick={() => void exportResult("resume_suggestions")}>{recap.exports.resume_suggestions ? "已创建待办" : busy === "resume_suggestions" ? "创建中…" : "创建修改待办"}</button>} renderEntry={(entry) => <p className="mt-1 whitespace-pre-wrap">{entry.suggestion}</p>} />
          </section>}
        </>}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-card px-4 py-3 sm:px-6">
        <button type="button" className={btnGhost} disabled={Boolean(busy)} onClick={() => void close()}>关闭</button>
        <button type="button" className={btnGhost} disabled={!dirty || Boolean(busy)} onClick={() => void save()}>{busy === "saving" ? "保存中…" : "保存逐题记录"}</button>
        <button type="button" className={btnPrimary} disabled={!canConfirm || Boolean(busy)} onClick={() => void confirm()}>{busy === "generating" ? "生成中…" : "确认并生成复盘"}</button>
      </footer>
    </div>
  </ModalCore>;
}
