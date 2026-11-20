"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { DIMENSIONS, type ScoreMap } from "@/lib/scores";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { NotebookStarButton } from "@/components/notebook";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { jsonFetch } from "@/lib/fetcher";
import { btnGhost, btnPrimary, textareaTallCls, scoreTextCls, textErr } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { REVIEW_MASTERY_LABELS, type ReviewLink, type ReviewMastery } from "@/lib/spaced-repetition-card-types";

type Question = {
  id: number;
  idx: number;
  question: string;
  answer: string;
  comment: string;
  reference: string;
  scores: ScoreMap | null;
  answered_at: string;
  kind: string;
  notebook_id: number | null;
  review_card_id?: number | null;
  review_mastery?: ReviewMastery | null;
  next_review_date?: string | null;
};

type DrillData = {
  id: number;
  source: string;
  project_id: number | null;
  direction: string;
  jd: string;
  interview_id: number | null;
  focus: string;
  created_at: string;
  project_name: string | null;
  questions: Question[];
};

const KIND_LABELS: Record<string, string> = { tech: "八股", behavior: "行为", evidence: "依据与条件变化" };
type AnswerDraft = { text: string };

/** 练习标题副标：项目题显示项目名，追练题显示追练重点，题库题显示方向或 JD 摘要 */
function drillSubtitle(data: DrillData): string {
  if (data.source === "project") return data.project_name ?? "未命名项目";
  if (data.source === "interview") return data.focus ? `追练 · ${data.focus}` : "面试追练";
  return data.direction || `JD：${data.jd.slice(0, 20)}${data.jd.length > 20 ? "…" : ""}`;
}

export default function DrillPage() {
  const params = useParams<{ id: string }>();
  return <DrillSession key={params.id} drillId={params.id} />;
}

function DrillSession({ drillId }: { drillId: string }) {
  const router = useRouter();
  const [data, setData] = useState<DrillData | null>(null);
  const [currentIdx, setCurrentIdx] = useState(1);
  const [drafts, setDrafts] = useState<Record<number, AnswerDraft>>({});
  const [answerErrors, setAnswerErrors] = useState<Record<number, string>>({});
  const [savedSubmissions, setSavedSubmissions] = useState<Record<number, AnswerDraft>>({});
  const [evaluatingId, setEvaluatingId] = useState<number | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(false);
  const notebookVersions = useRef<Record<number, number>>({});
  const [error, setError] = useState("");
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState("");
  const { copiedText, copy, copyError, copying } = useCopyFeedback();
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    jsonFetch<DrillData>(`/api/drills/${drillId}`)
      .then((d) => {
        // 快速切换 drill 时旧请求可能后到，取消后直接丢弃，避免旧数据覆盖新页面
        if (cancelled) return;
        setData(d);
        const firstUnanswered = d.questions.find((q) => !q.answered_at);
        setCurrentIdx(firstUnanswered?.idx ?? d.questions[0]?.idx ?? 1);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => { cancelled = true; };
  }, [drillId, loadAttempt]);

  if (error && !data) return <LoadError message={error} onRetry={() => { setError(""); setLoadAttempt((attempt) => attempt + 1); }} />;
  if (!data) return <Loading />;
  // 练习集至少包含一道题；为 0 时下方给出空态而非让 current 悬空
  if (data.questions.length === 0) {
    return <p className={`text-sm ${textErr}`}>该练习集没有题目，请重新生成</p>;
  }

  const current = data.questions.find((q) => q.idx === currentIdx) ?? data.questions[0]!;
  const draft = drafts[current.id];
  const answer = draft?.text ?? "";
  const editing = draft !== undefined;
  const evaluating = evaluatingId !== null;
  const pendingQuestion = data.questions.find((q) => q.id === evaluatingId);
  const answeredCount = data.questions.filter((q) => q.answered_at).length;
  const allAnswered = answeredCount === data.questions.length;

  function setQuestionNotebook(questionId: number, notebookId: number | null, review?: ReviewLink | null) {
    notebookVersions.current[questionId] = (notebookVersions.current[questionId] ?? 0) + 1;
    setData((prev) =>
      prev
        ? { ...prev, questions: prev.questions.map((q) => (q.id === questionId ? {
          ...q, notebook_id: notebookId, review_card_id: review?.review_card_id ?? null,
          review_mastery: review?.review_mastery ?? null, next_review_date: review?.next_review_date ?? null,
        } : q)) }
        : prev
    );
  }

  function jumpTo(idx: number) {
    setCurrentIdx(idx);
  }

  function startReanswer() {
    setDrafts((prev) => ({ ...prev, [current.id]: { text: "" } }));
    setAnswerErrors((prev) => ({ ...prev, [current.id]: "" }));
  }

  function updateAnswer(text: string) {
    // 每次编辑创建新对象，即使改回相同文字也属于新草稿。
    setDrafts((prev) => ({ ...prev, [current.id]: { text } }));
  }

  function cancelReanswer() {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[current.id];
      return next;
    });
    setAnswerErrors((prev) => ({ ...prev, [current.id]: "" }));
  }

  async function submitAnswer() {
    if (submitting.current) return;
    const savedDraft = savedSubmissions[current.id];
    if (!answer.trim() && !savedDraft) {
      setAnswerErrors((prev) => ({ ...prev, [current.id]: "请先输入回答" }));
      return;
    }
    const questionId = current.id;
    const submittedDraft = savedDraft ?? draft!;
    let saved = savedDraft !== undefined;
    submitting.current = true;
    setAnswerErrors((prev) => ({ ...prev, [questionId]: "" }));
    setEvaluatingId(questionId);
    try {
      if (!saved) {
        await jsonFetch(`/api/drills/${drillId}/questions/${questionId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: submittedDraft.text }),
        });
        saved = true;
        if (!mounted.current) return;
        setSavedSubmissions((prev) => ({ ...prev, [questionId]: submittedDraft }));
      }
      if (!mounted.current) return;
      const versionsBeforeRead = { ...notebookVersions.current };
      const updated = await jsonFetch<DrillData>(`/api/drills/${drillId}`);
      if (!mounted.current) return;
      setData((prev) => ({ ...updated, questions: updated.questions.map((question) => {
        const local = prev?.questions.find((q) => q.id === question.id);
        if (!local || (notebookVersions.current[question.id] ?? 0) === (versionsBeforeRead[question.id] ?? 0)) return question;
        // 评分回读不能覆盖其等待期间已完成的收藏或取消收藏。
        return { ...question, notebook_id: local.notebook_id, review_card_id: local.review_card_id,
          review_mastery: local.review_mastery, next_review_date: local.next_review_date };
      }) }));
      setSavedSubmissions((prev) => {
        const next = { ...prev };
        delete next[questionId];
        return next;
      });
      setDrafts((prev) => {
        // 只移除实际提交的那份草稿；等待中键入、切题或重答产生的新稿继续保留。
        if (prev[questionId] !== submittedDraft) return prev;
        const next = { ...prev };
        delete next[questionId];
        return next;
      });
    } catch (err) {
      if (mounted.current) setAnswerErrors((prev) => ({ ...prev, [questionId]: saved
        ? `评分已保存，读取结果失败：${errorMessage(err)}。请重新读取，无需重复评分。`
        : errorMessage(err) }));
    } finally {
      submitting.current = false;
      if (mounted.current) setEvaluatingId(null);
    }
  }

  async function restart() {
    setRestarting(true);
    setRestartError("");
    try {
      const payload =
        data!.source === "bank"
          ? { source: "bank", direction: data!.direction, jd: data!.jd, count: data!.questions.length }
          : { source: "project", project_id: data!.project_id, count: data!.questions.length };
      const body = await jsonFetch<{ id: number }>("/api/drills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!mounted.current) return;
      router.push(`/drills/${body.id}`);
    } catch (err) {
      if (!mounted.current) return;
      setRestartError(errorMessage(err));
      setRestarting(false);
    }
  }

  const nextUnanswered = data.questions.find((q) => !q.answered_at);
  const completionText =
    data.source === "interview"
      ? `本套 ${data.questions.length} 题追练已完成。建议结合原面试报告回顾本次作答与待核实事项，或再开一场模拟面试检验练习效果。`
      : data.source === "bank"
        ? `本套 ${data.questions.length} 题已全部完成，可再从题库生成一套新题继续练习。`
        : `本套 ${data.questions.length} 题已全部完成，可针对「${data.project_name}」再生成一套新题继续练习。`;

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      {/* 顶部面包屑与状态头 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Link
              href="/drills"
              className="text-xs font-medium text-muted transition-colors hover:text-primary"
            >
              ← 返回精练列表
            </Link>
            <span className="text-xs text-faint">/</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary-soft px-2.5 py-0.5 text-[11px] font-medium text-primary">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
              <span>{data.source === "project" ? "真实项目深挖" : data.source === "interview" ? "面试追练" : "通用题库"}</span>
            </span>
          </div>
          <h1 className="font-serif text-[26px] sm:text-[30px] font-bold text-ink leading-tight">
            题目专项精练 <span className="font-sans text-base sm:text-lg font-normal text-muted">· {drillSubtitle(data)}</span>
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-xs text-muted">
            作答进度：
            <strong className="font-mono text-sm font-bold text-ink">
              {answeredCount} / {data.questions.length}
            </strong>{" "}
            题
          </div>
          {allAnswered && data.source !== "interview" && (
            <button
              type="button"
              className={btnGhost}
              onClick={restart}
              disabled={restarting}
            >
              {restarting ? "重新出题中…" : "再来一套新题"}
            </button>
          )}
        </div>
      </div>

      {/* 题号进度胶囊导航条 */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-card p-4 shadow-card-subtle">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 font-serif text-xs font-bold text-muted">题目跳转：</span>
          {data.questions.map((q) => {
            const isCurrent = q.idx === currentIdx;
            const isAnswered = !!q.answered_at;
            return (
              <button
                key={q.id}
                onClick={() => jumpTo(q.idx)}
                aria-label={`第 ${q.idx} 题${isAnswered ? "（已答）" : ""}`}
                className={`flex h-8 w-8 items-center justify-center rounded-lg font-mono text-xs font-bold tabular-nums transition-all ${
                  isCurrent
                    ? "bg-primary text-on-primary shadow-xs ring-2 ring-primary/25"
                    : isAnswered
                      ? "border border-primary/30 bg-surface-2 text-primary hover:bg-primary-soft"
                      : "border border-line bg-surface text-muted hover:border-primary/40 hover:text-ink"
                }`}
              >
                {String(q.idx).padStart(2, "0")}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-4 text-xs font-medium">
          <span className="flex items-center gap-1.5 text-primary">
            <span className="h-2 w-2 rounded-full bg-primary" />
            已作答 ({answeredCount})
          </span>
          <span className="flex items-center gap-1.5 text-muted">
            <span className="h-2 w-2 rounded-full bg-line-strong" />
            未作答 ({data.questions.length - answeredCount})
          </span>
        </div>
      </div>

      {pendingQuestion && (
        <p role="status" aria-live="polite" className="text-sm text-muted">
          {savedSubmissions[pendingQuestion.id] ? `正在读取第 ${pendingQuestion.idx} 题已保存评分` : `第 ${pendingQuestion.idx} 题正在评分`}，可继续编辑草稿或切题；本次只评估已提交的回答。
        </p>
      )}

      {/* 主做题双栏网格 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* 左侧主要题目与作答区（7 栏） */}
        <div className="space-y-5 lg:col-span-7">
          <div className="space-y-4 rounded-2xl border border-line bg-card p-6 shadow-card-subtle">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3.5">
              <div className="flex shrink-0 items-center gap-2">
                <span className="font-mono text-xs font-bold text-primary">
                  QUESTION {String(current.idx).padStart(2, "0")} / {String(data.questions.length).padStart(2, "0")}
                </span>
                {KIND_LABELS[current.kind] && (
                  <span className="rounded bg-accent-wash px-2 py-0.5 text-[10px] font-bold text-accent border border-accent/20">
                    {KIND_LABELS[current.kind]}
                  </span>
                )}
              </div>
              <NotebookStarButton
                source="drill"
                sourceId={current.id}
                question={current.question}
                notebookId={current.notebook_id}
                onChanged={(id, review) => setQuestionNotebook(current.id, id, review)}
              />
            </div>

            {/* 考题描述 */}
            <div className="space-y-2">
              {current.kind === "evidence" ? <>
                <h2 className="font-serif text-lg font-bold text-ink">依据与条件变化</h2>
                <p className="min-w-0 whitespace-pre-wrap break-words rounded-lg bg-surface p-3 font-mono text-sm leading-relaxed text-ink [overflow-wrap:anywhere]">{current.question}</p>
              </> : <h2 className="min-w-0 break-words font-serif text-lg sm:text-xl font-bold text-ink leading-relaxed" style={{ overflowWrap: "anywhere" }}>
                {current.question}
              </h2>}
            </div>

            {/* 作答输入区 */}
            {current.answered_at && current.review_card_id && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
                <span className="text-xs text-muted">
                  {current.review_mastery ? REVIEW_MASTERY_LABELS[current.review_mastery] : "未复习"}
                  {current.next_review_date && <> · 下次复习 <time>{current.next_review_date}</time></>}
                </span>
                <Link href={`/reviews?card=${current.review_card_id}`} className={btnGhost}>开始间隔复习</Link>
              </div>
            )}
            {(!current.answered_at || editing) ? (
              <div className="relative space-y-3 pt-3 border-t border-line/60">
                <div className="flex items-center justify-between">
                  <label htmlFor={`drill-answer-${current.id}`} className="text-xs font-bold text-ink flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                    <span>{current.answered_at ? "重新回忆并作答：" : "我的现场回答："}</span>
                  </label>
                  <span className="font-mono text-[11px] text-faint">支持分点或 STAR 结构</span>
                </div>

                <textarea
                  id={`drill-answer-${current.id}`}
                  className={`${textareaTallCls} font-sans text-xs sm:text-sm`}
                  value={answer}
                  onChange={(e) => updateAnswer(e.target.value)}
                  placeholder={
                    data.source === "bank"
                      ? "针对考点分条作答；行为与业务题建议按 STAR（背景-任务-行动-结果）组织回答…"
                      : "建议按技术细节详细拆解：架构选型考量、落地攻坚方案与关键成效指标…"
                  }
                />

                {current.answered_at && <p className="text-xs text-muted">当前草稿尚未提交，已保存回答的评分与参考暂不展示。</p>}
                {answerErrors[current.id] && <p role="alert" className={`text-sm ${textErr}`}>{answerErrors[current.id]}</p>}

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                  <span className="text-xs text-faint">提交后 AI 将针对技术深度与结构进行四维评分</span>
                  <div className="flex items-center gap-2">
                    {current.answered_at && (
                      <button
                        type="button"
                        className={btnGhost}
                        onClick={cancelReanswer}
                        disabled={evaluatingId === current.id || !!savedSubmissions[current.id]}
                      >
                        取消重答
                      </button>
                    )}
                    <button
                      type="button"
                      className={btnPrimary}
                      onClick={submitAnswer}
                      disabled={evaluating || (!answer.trim() && !savedSubmissions[current.id])}
                    >
                      {evaluatingId === current.id ? (savedSubmissions[current.id] ? "读取已保存评分中…" : "AI 考官打分批改中…") : evaluating ? "请等待当前评分完成" : savedSubmissions[current.id] ? "重新读取已保存评分" : current.answered_at ? "保存并重新打分" : "提交作答并获取批阅"}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* 已答模式下的作答展示 */
              <div className="space-y-4 pt-3 border-t border-line/60">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-muted flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                    <span>我的现场作答</span>
                  </span>
                  <button
                    type="button"
                    onClick={startReanswer}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    重答本题 ↺
                  </button>
                </div>
                <div className="rounded-xl border border-line bg-surface/40 p-4 text-xs sm:text-sm text-ink/90 leading-relaxed font-sans whitespace-pre-wrap">
                  {current.answer}
                </div>
              </div>
            )}
          </div>

          {/* 下一道未答题快速通道 */}
          {nextUnanswered && nextUnanswered.idx !== currentIdx && (
            <div className="flex justify-end">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-card px-4 py-2 text-xs font-bold text-primary shadow-card-subtle hover:border-primary/40 hover:bg-surface transition-all"
                onClick={() => jumpTo(nextUnanswered.idx)}
              >
                <span>前往下一道未答题（第 {nextUnanswered.idx} 题）</span>
                <span aria-hidden>→</span>
              </button>
            </div>
          )}
        </div>

        {/* 右侧当前/选中题目的批改反馈看板（5 栏） */}
        <div className="space-y-5 lg:col-span-5">
          {current.answered_at && !editing ? (
            <div className="space-y-5 rounded-2xl border border-line bg-card p-6 shadow-card-subtle">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <span className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
                  <h3 className="font-serif text-sm font-bold text-ink">
                    第 {String(current.idx).padStart(2, "0")} 题 · 考官批改诊断
                  </h3>
                </div>
                <span className="font-mono text-xs font-bold text-primary">已评定</span>
              </div>

              {/* 四维小分量化看板 */}
              {current.scores && (
                <div className="grid grid-cols-2 gap-2.5">
                  {DIMENSIONS.map((d) => (
                    <div
                      key={d.key}
                      className="rounded-xl border border-line/70 bg-surface/50 p-3 text-center transition-all hover:bg-surface"
                    >
                      <div className="text-[11px] text-muted">{d.label}</div>
                      <div className={`mt-1 font-mono text-2xl font-bold tabular-nums ${scoreTextCls(current.scores![d.key])}`}>
                        {current.scores![d.key]}
                      </div>
                      <div className="mt-0.5 text-[10px] text-faint line-clamp-1">{d.hint}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* 考官详细点评 */}
              {current.comment && (
                <div className="space-y-1.5 rounded-xl border border-line/80 bg-surface/40 p-3.5 text-xs leading-relaxed">
                  <div className="font-bold text-ink flex items-center gap-1.5">
                    <span>💡 考官诊断要点：</span>
                  </div>
                  <p className="whitespace-pre-wrap text-muted">
                    {current.comment}
                  </p>
                </div>
              )}

              {/* 本题的回答参考 */}
              {current.reference && (
                <div role="region" aria-label="本题回答参考" className="space-y-2 rounded-xl border border-primary/25 bg-primary-soft p-4 text-xs leading-relaxed">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-primary flex items-center gap-1.5">
                      <span>💎 回答参考思路</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => void copy(current.reference)}
                      disabled={copying}
                      className="text-[10px] text-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {copiedText === current.reference ? "已复制 ✓" : "复制参考"}
                    </button>
                  </div>
                  <p className="whitespace-pre-wrap text-ink font-sans">
                    {current.reference}
                  </p>
                  {copyError?.text === current.reference && <p role="alert" className="text-danger">{copyError.message}</p>}
                  <p className="text-muted">参考内容不代表你已具备其中的经历或能力，请核对事实、个人分工与适用条件后再练习表达。</p>
                </div>
              )}
            </div>
          ) : (
            /* 未答时的引导提示卡 */
            <div className="flex flex-col justify-between space-y-4 rounded-2xl border border-line bg-card p-6 shadow-card-subtle text-xs">
              <div className="space-y-3">
                <div className="flex items-center gap-2 border-b border-line pb-2.5">
                  <span className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
                  <h3 className="font-serif text-sm font-bold text-ink">答题要诀</h3>
                </div>
                <ul className="space-y-2.5 text-muted leading-relaxed">
                  <li><strong>拒绝假大空：</strong>多结合真实技术栈选型与指标数据；</li>
                  <li><strong>STAR 原则：</strong>遇到场景题，优先交代前因后果与个人攻坚行动；</li>
                  <li><strong>及时收录：</strong>遇答题不顺的题目随时点击右上角⭐收纳进错题本。</li>
                </ul>
              </div>
              <div className="rounded-xl border border-primary/20 bg-primary-soft/50 p-3 text-primary leading-relaxed">
                在左侧录入你的作答并提交，本栏将即刻生成技术深度、逻辑条理、真实性与完整度四维批阅评分！
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 全部完成时的通关与总结卡片 */}
      {allAnswered && (
        <div className="rounded-2xl border border-primary/30 bg-primary-soft/40 p-6 shadow-card-subtle">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-serif text-lg font-bold text-primary">🎉 本套精练已全部完成！</span>
              </div>
              <p className="text-xs text-muted max-w-2xl leading-relaxed">
                {completionText}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {data.source === "interview" ? (
                <>
                  {data.interview_id && (
                    <Link href={`/interviews/${data.interview_id}`} className={btnGhost}>
                      查看原面试报告
                    </Link>
                  )}
                  <Link href="/interviews" className={btnPrimary}>
                    开启新一场模考
                  </Link>
                </>
              ) : (
                <button
                  type="button"
                  className={btnPrimary}
                  onClick={restart}
                  disabled={restarting}
                >
                  {restarting ? "正在生成新题…" : "再开一套针对性新题"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {restartError && <p className={`mt-3 text-sm ${textErr}`}>{restartError}</p>}
    </div>
  );
}
