"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ModalCore } from "@/components/common/modal-core";
import { confirmDialog } from "@/components/common/confirm-dialog";
import type { Application, ApplicationInterview } from "@/lib/applications-types";
import type { InterviewRecap, InterviewReviewQuestion, InterviewReviewResponse as ReviewResponse, ReviewExportAction } from "@/lib/application-interview-review";
import { readInterviewRecap, readInterviewReviewResponse, reviewQuestionsMatch, reviewSourceContextMatches } from "@/lib/application-interview-review-response";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { btnGhost, btnPrimary, inputCls, labelCls } from "@/lib/ui";

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

type ReviewDialogProps = {
  application: Application;
  interview: ApplicationInterview;
  onClose: () => void;
};

export function ApplicationInterviewReviewDialog(props: ReviewDialogProps) {
  return <InterviewReviewContent key={JSON.stringify([props.application.id, props.interview.id])} {...props} />;
}

function InterviewReviewContent({ application, interview, onClose }: ReviewDialogProps) {
  const router = useRouter();
  const base = `/api/applications/${application.id}/interviews/${interview.id}/review`;
  const formId = useId();
  const nextClientId = useRef(0);
  const mounted = useRef(true);
  const mutationRequest = useRef<AbortController | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const [data, setData] = useState<ReviewResponse | null>(null);
  const [draft, setDraft] = useState<QuestionDraft[]>([]);
  const [busy, setBusy] = useState<"saving" | "generating" | "reloading" | "discarding" | ReviewExportAction | null>(null);
  const [confirming, setConfirming] = useState<"discarding" | ReviewExportAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [historyLoadingId, setHistoryLoadingId] = useState<number | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      mutationRequest.current?.abort();
      mutationRequest.current = null;
      historyRequest.current?.abort();
      historyRequest.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    jsonFetch<unknown>(base, { signal: controller.signal }).then((response) => {
      if (controller.signal.aborted) return;
      const value = readInterviewReviewResponse(response, { applicationId: application.id, interviewId: interview.id });
      setData(value);
      setDraft(value.questions.map((item) => ({ ...item, clientId: ++nextClientId.current })));
      setLoading(false);
    }).catch((reason) => {
      if (!controller.signal.aborted) { setError(errorMessage(reason)); setLoading(false); }
    });
    return () => controller.abort();
  }, [base, attempt, application.id, interview.id]);

  function cancelHistory() {
    historyRequest.current?.abort();
    historyRequest.current = null;
    setHistoryLoadingId(null);
  }

  function beginMutation(action: NonNullable<typeof busy>) {
    if (mutationRequest.current || !mounted.current) return null;
    cancelHistory();
    const controller = new AbortController();
    mutationRequest.current = controller;
    setBusy(action); setError(""); setNotice("");
    return controller;
  }

  function isCurrentMutation(controller: AbortController) {
    return mutationRequest.current === controller && !controller.signal.aborted;
  }

  function finishMutation(controller: AbortController) {
    if (mutationRequest.current !== controller) return;
    mutationRequest.current = null;
    setBusy(null);
    setConfirming(null);
  }

  const questions = draft.map(({ question, answer, stuck, feedback }) => ({ question, answer, stuck, feedback }));
  const dirty = data !== null && JSON.stringify(questions) !== JSON.stringify(data.questions);
  const canEdit = Boolean(data?.input_hash) && !data?.material_error;
  const canConfirm = data !== null && canEdit && !dirty && data.questions.length > 0 && data.latest?.input_hash !== data.input_hash;
  const recap = data?.selected ?? data?.latest;
  const identity = `投递 #${application.id} · ${application.company} · ${application.role}；轮次 #${interview.id} · ${interview.round_name}。`;

  async function close() {
    if (!mounted.current || mutationRequest.current) return;
    if (!dirty) { onClose(); return; }
    const controller = beginMutation("discarding");
    if (!controller) return;
    setConfirming("discarding");
    try {
      if (await confirmDialog({ title: "放弃未保存的逐题记录？", message: `${identity} 本次逐题编辑尚未保存，放弃后将丢失这些修改。`, confirmText: "放弃编辑", signal: controller.signal }) && isCurrentMutation(controller)) onClose();
    } finally { finishMutation(controller); }
  }

  function updateQuestion(clientId: number, key: keyof InterviewReviewQuestion, value: string) {
    if (!canEdit || !mounted.current || mutationRequest.current) return;
    setDraft((current) => current.map((item) => item.clientId === clientId ? { ...item, [key]: value } : item));
    setError("");
    setNotice("");
  }

  async function reloadMaterial() {
    if (!data?.material_error || dirty || busy) return;
    const controller = beginMutation("reloading");
    if (!controller) return;
    try {
      const response = await jsonFetch<unknown>(base, { signal: controller.signal });
      if (!isCurrentMutation(controller)) return;
      const loaded = readInterviewReviewResponse(response, { applicationId: application.id, interviewId: interview.id });
      setData(loaded);
      setDraft(loaded.questions.map((item) => ({ ...item, clientId: ++nextClientId.current })));
    } catch (reason) { if (isCurrentMutation(controller)) setError(errorMessage(reason)); }
    finally { finishMutation(controller); }
  }

  async function save() {
    if (!data || !canEdit || busy || !dirty) return;
    if (questions.some((item) => !item.question.trim())) { setError("请填写每题的提问，或删除空白题目"); return; }
    const controller = beginMutation("saving");
    if (!controller) return;
    try {
      const response = await jsonFetch<unknown>(base, { method: "PUT", body: JSON.stringify({ expected_hash: data.input_hash, questions }), signal: controller.signal });
      if (!isCurrentMutation(controller)) return;
      const saved = readInterviewReviewResponse(response, { applicationId: application.id, interviewId: interview.id });
      if (saved.input_hash === null || !reviewQuestionsMatch(saved.questions, questions, true)) throw new Error("未确认本次逐题记录的保存结果，请保留原编辑重试");
      setData(saved);
      setDraft(saved.questions.map((item) => ({ ...item, clientId: ++nextClientId.current })));
      setNotice("逐题记录已保存");
    } catch (reason) { if (isCurrentMutation(controller)) setError(errorMessage(reason)); }
    finally { finishMutation(controller); }
  }

  async function confirm() {
    if (!data || !canConfirm || busy) return;
    const controller = beginMutation("generating");
    if (!controller) return;
    try {
      const response = await jsonFetch<unknown>(base, { method: "POST", body: JSON.stringify({ expected_hash: data.input_hash }), signal: controller.signal });
      if (!isCurrentMutation(controller)) return;
      const saved = readInterviewReviewResponse(response, { applicationId: application.id, interviewId: interview.id });
      if (saved.input_hash !== data.input_hash || !saved.latest || saved.latest.input_hash !== data.input_hash
        || !reviewQuestionsMatch(saved.questions, data.questions) || !reviewQuestionsMatch(saved.latest.questions, data.questions)) {
        throw new Error("未确认本次复盘的生成结果，请保留原记录重试");
      }
      setData(saved);
      setNotice("复盘结果已保存");
    } catch (reason) { if (isCurrentMutation(controller)) setError(errorMessage(reason)); }
    finally { finishMutation(controller); }
  }

  async function exportResult(action: ReviewExportAction) {
    if (!recap || busy || historyRequest.current) return;
    const source = recap.source_context;
    const sourceIdentity = source ? `生成时：${source.company} · ${source.role} · ${source.round_name}。` : "生成时岗位资料未保存。";
    const drillContext = source ? (source.jd ? "追练采用生成时的 JD。" : "生成时未提供 JD，追练将不附岗位背景。") : "生成时岗位资料未保存，追练将不附岗位背景。";
    const labels = {
      mistakes: { title: "加入错题本？", message: `将此复盘的 ${recap.result.mistakes.length} 道错题加入错题本，并安排复习。${source ? "错题来源采用生成时的公司与轮次。" : "错题来源将标注岗位资料未保存。"}`, confirmText: "确认加入" },
      drills: { title: "开始追练？", message: `将此复盘的 ${recap.result.drills.length} 道追练题创建为一套练习并打开。${drillContext}`, confirmText: "创建并开始" },
      resume_suggestions: { title: "创建修改待办？", message: `将此复盘的 ${recap.result.resume_suggestions.length} 条简历建议加入此投递的准备待办。`, confirmText: "确认创建" },
    };
    const controller = beginMutation(action);
    if (!controller) return;
    setConfirming(action);
    try {
      if (!await confirmDialog({ ...labels[action], message: `${identity} 复盘 #${recap.id} · ${recap.created_at}。${sourceIdentity}${labels[action].message}`, signal: controller.signal }) || !isCurrentMutation(controller)) return;
      setConfirming(null);
      const saved = await jsonFetch<ReviewResponse & { drill_id: number | null }>(`${base}/export`, {
        method: "POST", body: JSON.stringify({ recap_id: recap.id, action }), signal: controller.signal,
      });
      if (!isCurrentMutation(controller)) return;
      const confirmed = saved.selected?.id === recap.id ? saved.selected : saved.latest?.id === recap.id ? saved.latest : null;
      const markers = confirmed?.exports;
      const validDrillId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
      if (!confirmed || confirmed.application_id !== application.id || confirmed.interview_id !== interview.id || confirmed.input_hash !== recap.input_hash
        || !reviewSourceContextMatches(confirmed.source_context, recap.source_context)
        || !markers || typeof markers.mistakes !== "boolean" || typeof markers.resume_suggestions !== "boolean" || (markers.drills !== null && !validDrillId(markers.drills))
        || (action === "drills" ? !validDrillId(saved.drill_id) || saved.drill_id !== markers.drills : markers[action] !== true)) {
        throw new Error("未读取到当前复盘的导出结果或结果不完整，请重试并核对");
      }
      // 导出只更新对应版本的标记，不用后台返回的当前草稿推进本地保存基线。
      setData((current) => current && ({ ...current,
        latest: current.latest?.id === confirmed.id ? { ...current.latest, exports: confirmed.exports } : current.latest,
        selected: current.selected?.id === confirmed.id ? { ...current.selected, exports: confirmed.exports } : current.selected,
      }));
      if (action === "drills" && saved.drill_id) router.push(`/drills/${saved.drill_id}`);
      else setNotice(action === "mistakes" ? "错题已加入错题本" : "简历修改待办已创建");
    } catch (reason) { if (isCurrentMutation(controller)) setError(errorMessage(reason)); }
    finally { finishMutation(controller); }
  }

  async function selectRecap(id: number) {
    if (!mounted.current || !data || busy || mutationRequest.current) return;
    cancelHistory();
    setError(""); setNotice("");
    if (id === data.latest?.id) { setData((current) => current && ({ ...current, selected: null })); return; }
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistoryLoadingId(id);
    try {
      const loaded = await jsonFetch<ReviewResponse>(`${base}?recap_id=${id}`, { signal: controller.signal });
      if (historyRequest.current !== controller || controller.signal.aborted) return;
      if (loaded.selected?.id !== id) throw new Error("未读取到所选复盘，请重试");
      const selected = readInterviewRecap(loaded.selected, { applicationId: application.id, interviewId: interview.id });
      const entry = data.history.find(item => item.id === id);
      if (!entry || selected.input_hash !== entry.input_hash || selected.created_at !== entry.created_at) throw new Error("所选复盘与历史记录不符，请重新读取");
      setData((current) => current && ({ ...current, selected }));
    } catch (reason) {
      if (historyRequest.current === controller && !controller.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (historyRequest.current === controller) {
        historyRequest.current = null;
        setHistoryLoadingId(null);
      }
    }
  }

  return <ModalCore
    open
    onClose={() => void close()}
    title={`逐题复盘 · ${interview.round_name}`}
    surface="drawer"
    closeOnBackdrop={!busy}
    escapeDisabled={Boolean(busy)}
    loading={busy === "generating" || busy === "saving"}
    loadingText={busy === "generating" ? "AI 正在整理已记录的面试内容…" : "正在保存逐题记录…"}
    loadingDescription={busy === "generating" ? "依据已记录的题目、回答与反馈整理复盘，区分可确认内容和待核实信息，请稍候…" : undefined}
  >
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-4 sm:px-6">
        <div className="min-w-0">
          <h2 className="break-words font-serif text-lg font-bold text-ink">{interview.round_name} · 逐题复盘</h2>
          <p className="mt-1 break-words text-xs text-muted">{application.company} · {application.role}</p>
        </div>
        <button type="button" aria-label="关闭逐题复盘" className="rounded p-1 text-muted hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-primary" onClick={() => void close()} disabled={Boolean(busy) && confirming !== "discarding"}>×</button>
      </header>

      {error && <div role="alert" className="mx-4 mt-4 shrink-0 rounded border border-danger/30 bg-danger-wash p-3 text-sm text-danger sm:mx-6">{error}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        {loading && <p role="status" className="text-sm text-muted">正在加载逐题记录…</p>}
        {notice && <p role="status" className="mb-4 text-sm text-primary">{notice}</p>}
        {!loading && !data && <button type="button" className={btnGhost} onClick={() => { setLoading(true); setError(""); setAttempt((current) => current + 1); }}>重试加载</button>}
        {data && <>
          {data.material_error && <div role="status" className="mb-5 rounded border border-danger/30 bg-danger-wash p-3 text-sm">
            <p className="text-danger">{data.material_error}</p>
            <p className="mt-2 text-muted">暂不能编辑逐题记录或生成新复盘。已有记录和复盘仍可查看、导出。</p>
            <button type="button" className={`${btnGhost} mt-3`} disabled={Boolean(busy)} onClick={() => void reloadMaterial()}>{busy === "reloading" ? "正在重新加载…" : "修复后重新加载"}</button>
          </div>}
          <section aria-label="逐题记录">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink">逐题记录 <span className="font-mono text-xs text-muted">{draft.length}</span></h3>
              <button type="button" className={btnGhost} disabled={!canEdit || Boolean(busy) || draft.length >= 20} onClick={() => { if (canEdit && mounted.current && !mutationRequest.current) setDraft((current) => [...current, { ...emptyQuestion(), clientId: ++nextClientId.current }]); }}>添加题目</button>
            </div>
            {draft.length === 0 && <p className="mt-5 text-sm text-muted">还没有逐题记录</p>}
            <div className="mt-4 space-y-5">
              {draft.map((item, index) => <div key={item.clientId} className="border-t border-line pt-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold text-ink">第 {index + 1} 题</h4>
                  <button type="button" className="rounded px-2 py-1 text-xs text-danger hover:bg-danger-wash focus-visible:outline-2 focus-visible:outline-danger" disabled={!canEdit || Boolean(busy)} onClick={() => { if (canEdit && mounted.current && !mutationRequest.current) setDraft((current) => current.filter((entry) => entry.clientId !== item.clientId)); }}>删除本题</button>
                </div>
                {([ ["question", "问了什么"], ["answer", "怎么回答"], ["stuck", "卡在哪里"], ["feedback", "对方反馈"] ] as const).map(([key, label]) => <div key={key} className="mt-3">
                  <label htmlFor={`${formId}-${item.clientId}-${key}`} className={labelCls}>{label}{key === "question" && <span className="text-danger"> *</span>}</label>
                  <textarea id={`${formId}-${item.clientId}-${key}`} aria-label={label} className={`${inputCls} mt-1 min-h-20 resize-y leading-relaxed`} rows={key === "question" ? 2 : 3} maxLength={2000} value={item[key]} onChange={(event) => updateQuestion(item.clientId, key, event.target.value)} readOnly={!canEdit} disabled={Boolean(busy)} />
                </div>)}
              </div>)}
            </div>
          </section>

          {recap && <section aria-label="复盘结果" aria-busy={historyLoadingId !== null} className="mt-8 border-t border-line pt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink">复盘结果</h3>
              {data.history.length > 1 && <select aria-label="复盘版本" className={`${inputCls} w-auto max-w-full text-xs`} value={historyLoadingId ?? recap.id} disabled={Boolean(busy)} onChange={(event) => void selectRecap(Number(event.target.value))}>
                {data.history.map((entry) => <option key={entry.id} value={entry.id}>{new Date(entry.created_at).toLocaleString()} · #{entry.id}</option>)}
              </select>}
            </div>
            {historyLoadingId !== null ? <p role="status" className="mt-3 text-sm text-muted">正在读取所选复盘…</p> : <>
            <p className="mt-2 text-xs text-muted">{new Date(recap.created_at).toLocaleString()} · {recap.questions.length} 题</p>
            <section aria-label="生成时的岗位资料" className="mt-3 rounded border border-line bg-surface p-3 text-sm [overflow-wrap:anywhere]">
              <h4 className="text-xs font-semibold text-muted">生成时的岗位资料</h4>
              {recap.source_context ? <>
                <p className="mt-2 whitespace-pre-wrap">{recap.source_context.company} · {recap.source_context.role} · {recap.source_context.round_name}</p>
                {recap.source_context.jd ? <details key={recap.id} className="mt-2">
                  <summary className="cursor-pointer rounded text-xs text-primary focus-visible:outline-2 focus-visible:outline-primary">查看生成时的 JD</summary>
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed">{recap.source_context.jd}</p>
                </details> : <p className="mt-2 text-xs text-muted">生成时未提供 JD</p>}
              </> : <p className="mt-2 text-xs text-muted">生成时岗位资料未保存</p>}
            </section>
            <ResultList title="错题" entries={recap.result.mistakes} recap={recap} action={<button type="button" className={btnGhost} disabled={(Boolean(busy) && confirming !== "mistakes") || recap.exports.mistakes} onClick={() => void exportResult("mistakes")}>{recap.exports.mistakes ? "已加入错题本" : busy === "mistakes" && !confirming ? "处理中…" : "加入错题本"}</button>} renderEntry={(entry) => <><p className="mt-1 text-muted">{entry.gap}</p><p className="mt-2 whitespace-pre-wrap">{entry.improved_answer}</p></>} />
            <ResultList title="追练题" entries={recap.result.drills} recap={recap} action={<button type="button" className={btnGhost} disabled={Boolean(busy) && confirming !== "drills"} onClick={() => { if (!mounted.current || mutationRequest.current) return; if (recap.exports.drills) router.push(`/drills/${recap.exports.drills}`); else void exportResult("drills"); }}>{recap.exports.drills ? "继续追练" : busy === "drills" && !confirming ? "创建中…" : "开始追练"}</button>} renderEntry={(entry) => <p className="mt-1 whitespace-pre-wrap">{entry.question}</p>} />
            <ResultList title="简历修改建议" entries={recap.result.resume_suggestions} recap={recap} action={<button type="button" className={btnGhost} disabled={(Boolean(busy) && confirming !== "resume_suggestions") || recap.exports.resume_suggestions} onClick={() => void exportResult("resume_suggestions")}>{recap.exports.resume_suggestions ? "已创建待办" : busy === "resume_suggestions" && !confirming ? "创建中…" : "创建修改待办"}</button>} renderEntry={(entry) => <p className="mt-1 whitespace-pre-wrap">{entry.suggestion}</p>} />
            </>}
          </section>}
        </>}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-card px-4 py-3 sm:px-6">
        <button type="button" className={btnGhost} disabled={Boolean(busy) && confirming !== "discarding"} onClick={() => void close()}>关闭</button>
        <button type="button" className={btnGhost} disabled={!canEdit || !dirty || Boolean(busy)} onClick={() => void save()}>{busy === "saving" ? "保存中…" : "保存逐题记录"}</button>
        <button type="button" className={btnPrimary} disabled={!canConfirm || Boolean(busy)} onClick={() => void confirm()}>{busy === "generating" ? "生成中…" : "确认并生成复盘"}</button>
      </footer>
    </div>
  </ModalCore>;
}
