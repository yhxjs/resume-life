"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { Drawer } from "@/components/common/drawer";
import type { DefenseDrillRecord, ScannedDefenseItem } from "@/lib/resume-defense";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { readDefenseDetail, readDefenseDrill } from "@/lib/resume-defense-detail";
import {
  btnGhost,
  btnPrimary,
  textareaTallCls,
  textErr,
} from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { DefenseQuote } from "@/components/defense/defense-quote";
import { DefenseScoreTag } from "@/components/defense/defense-badges";

interface DefenseDrillDrawerProps {
  defenseId: number;
  item: ScannedDefenseItem | null;
  existingDrill?: DefenseDrillRecord | null;
  isOpen: boolean;
  onClose: () => void;
  onDrillSaved: (drill: DefenseDrillRecord) => void;
  onDrillsReloaded?: (drills: DefenseDrillRecord[]) => void;
}

type Submission = { controller: AbortController; question: string; userAnswer: string; cause: string };

function DefenseDrillForm({
  defenseId,
  item,
  existingDrill,
  onClose,
  onDrillSaved,
  onDrillsReloaded,
}: {
  defenseId: number;
  item: ScannedDefenseItem;
  existingDrill?: DefenseDrillRecord | null;
  onClose: () => void;
  onDrillSaved: (drill: DefenseDrillRecord) => void;
  onDrillsReloaded?: (drills: DefenseDrillRecord[]) => void;
}) {
  const initialQuestion =
    existingDrill?.question ||
    item.deadlyQuestions?.[0] ||
    "请解释这段表述的具体含义、个人职责与可确认依据。";
  const answerId = useId();
  const [selectedQuestion, setSelectedQuestion] = useState(initialQuestion);
  const [answer, setAnswer] = useState(existingDrill?.userAnswer || "");
  const [phase, setPhase] = useState<"idle" | "submitting" | "checking" | "unknown">("idle");
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const current = useRef<Submission | null>(null);
  const checking = useRef(false);
  const onSavedRef = useRef(onDrillSaved);
  const onReloadedRef = useRef(onDrillsReloaded);
  const [drillResult, setDrillResult] = useState<DefenseDrillRecord | null>(
    existingDrill || null
  );
  // 与 route 保存前的 trim 口径一致；旧点评只对应其实际评分的问题和原答。
  const resultMatchesDraft = drillResult !== null &&
    drillResult.question === selectedQuestion.trim() && drillResult.userAnswer === answer.trim();

  useLayoutEffect(() => { onSavedRef.current = onDrillSaved; onReloadedRef.current = onDrillsReloaded; });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current?.controller.abort();
      current.current = null;
    };
  }, []);

  function isCurrent(command: Submission) {
    return mounted.current && current.current === command && !command.controller.signal.aborted;
  }

  function release() {
    current.current = null;
    setPhase("idle");
  }

  async function checkSaved(command: Submission) {
    if (!isCurrent(command) || checking.current) return;
    checking.current = true;
    setPhase("checking");
    setError("");
    try {
      const value = await jsonFetch<unknown>(`/api/tools/resume-defenses/${defenseId}`, {
        signal: command.controller.signal, cache: "no-store",
      });
      if (!isCurrent(command)) return;
      const data = readDefenseDetail(value, String(defenseId));
      const storedItem = data.report.items.find((entry) => entry.id === item.id);
      if (!storedItem || storedItem.originalText !== item.originalText) throw new Error("存档条目或引用已变化，请关闭演练并重新读取报告后核对");
      const stored = data.drills.find((entry) => entry.itemId === item.id);
      if (stored?.question === command.question && stored.userAnswer === command.userAnswer) {
        const recovered = readDefenseDrill(stored, defenseId, item.id, command);
        setDrillResult(recovered);
        setError(`${command.cause}；已读取到与提交问题、原答一致的已保存评估，按其原答展示。这不能确认本次请求已完成，请先核对再决定是否重新提交。`);
      } else {
        setDrillResult(stored ?? null);
        setError(`${command.cause}；当前存档未找到与提交问题和原答一致的评估。原请求仍可能稍后保存，请先核对，再决定是否显式重新提交。`);
      }
      if (onReloadedRef.current) onReloadedRef.current(data.drills);
      else if (stored) onSavedRef.current(stored);
      release();
    } catch (err) {
      if (!isCurrent(command)) return;
      setError(`演练保存结果尚未确认：${errorMessage(err)}。请先重新读取演练存档；原请求仍可能已保存。`);
      setPhase("unknown");
    } finally {
      checking.current = false;
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!mounted.current || current.current) return;
    if (!answer.trim()) {
      setError("请先输入你的练习回答");
      return;
    }
    if (!selectedQuestion.trim()) {
      setError("请选择有效的练习问题");
      return;
    }
    const command: Submission = {
      controller: new AbortController(), question: selectedQuestion.trim(), userAnswer: answer.trim(), cause: "",
    };
    current.current = command;
    setError("");
    setPhase("submitting");

    try {
      const res = await jsonFetch<unknown>(
        `/api/tools/resume-defenses/${defenseId}/drill`,
        {
          method: "POST",
          signal: command.controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemId: item.id,
            question: command.question,
            userAnswer: command.userAnswer,
            defensePlan: item.defensePlan.standardDefense,
          }),
        }
      );
      if (!isCurrent(command)) return;
      const saved = readDefenseDrill(res, defenseId, item.id, command);
      setDrillResult(saved);
      onSavedRef.current(saved);
      release();
    } catch (err) {
      if (!isCurrent(command)) return;
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408) {
        setError(errorMessage(err));
        release();
      } else {
        command.cause = errorMessage(err);
        await checkSaved(command);
      }
    }
  }

  return (
    <>
      {/* 抽屉顶栏 */}
      <div className="flex items-center justify-between border-b border-line bg-surface/50 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="font-serif text-lg font-bold text-ink">即时防御演练场</span>
              <span className="inline-flex rounded-full bg-danger-wash text-danger border border-danger/20 px-2 py-0.5 text-[11px] font-medium">
                回答练习
              </span>
            </div>
            <p className="text-xs text-muted">围绕待核实表述练习回答，仅按本次问题与原答评估</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-surface hover:text-ink transition-colors cursor-pointer"
            aria-label="关闭"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
      </div>

      {/* 抽屉内容区 */}
      <div className="relative min-w-0 flex-1 overflow-y-auto space-y-6 p-4 sm:p-6 [overflow-wrap:anywhere]">
        {phase === "submitting" && <p role="status" className="text-xs text-muted">正在评估本次回答… 可继续修改草稿，评估只对应提交时的问题与原答。</p>}
        {phase === "checking" && <p role="status" className="text-xs text-muted">正在读取演练存档，核对提交时的问题与原答…</p>}
        {phase !== "idle" && <p className="text-xs text-muted">关闭只停止本地等待，服务端仍可能保存；再次提交前请重新读取报告核对存档。</p>}
        {/* 靶子原句 */}
          <div className="space-y-1.5 rounded-xl border border-line bg-surface/40 p-3.5 text-xs">
            <div className="flex items-center justify-between text-muted">
              <span className="font-semibold text-ink flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                <span>引用预览</span>
              </span>
              <span className="text-[11px] text-faint">{item.sectionHint}</span>
            </div>
            <div className="font-mono text-ink bg-card rounded-md p-2.5 border border-line/60 leading-relaxed break-words">
              <DefenseQuote text={item.originalText} />
            </div>
          </div>

          {/* 面试官致命发难 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-ink flex items-center gap-1.5">
                <span className="inline-block text-base">🧐</span>
                <span>练习问题（点击切换追问角度）：</span>
              </label>
            </div>
            <div className="space-y-2">
              {(item.deadlyQuestions || []).map((q, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setSelectedQuestion(q)}
                  className={`w-full text-left rounded-xl p-3 text-xs transition-all border cursor-pointer ${
                    selectedQuestion === q
                      ? "border-primary bg-primary-soft/30 font-medium text-ink shadow-xs"
                      : "border-line bg-card hover:bg-surface text-muted"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 mt-0.5 text-[10px] font-mono px-1.5 py-0.2 rounded bg-surface border border-line">
                      追问 #{idx + 1}
                    </span>
                    <span className="min-w-0 flex-1 leading-relaxed">{q}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* 防御答题区 */}
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="flex items-center justify-between">
              <label htmlFor={answerId} className="text-xs font-bold text-ink flex items-center gap-1.5">
                <span aria-hidden className="inline-block text-base">🛡️</span>
                <span>你的练习回答：</span>
              </label>
              <button
                type="button"
                onClick={() => setAnswer(item.defensePlan?.standardDefense || "")}
                className="text-[11px] text-primary hover:underline cursor-pointer"
              >
                填入练习参考
              </button>
            </div>

            <textarea
              id={answerId}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="回答当前问题，说明真实分工与可确认依据；记不清或尚未核实的信息请如实说明。"
              className={`${textareaTallCls} text-xs`}
            />

            {error && <p role="alert" className={textErr}>{error}</p>}
            {phase === "unknown" && <button type="button" className={btnPrimary} onClick={() => {
              const command = current.current;
              if (command) void checkSaved(command);
            }}>重新读取演练存档</button>}

            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[11px] text-faint">
                已输入 {answer.length} 字 · 练习参考须按真实经历调整
              </span>
              <button
                type="submit"
                disabled={phase !== "idle" || !answer.trim() || !selectedQuestion.trim()}
                className={`${btnPrimary} min-w-[120px] cursor-pointer`}
              >
                {phase === "submitting" || phase === "checking" ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-on-primary" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    <span>面试官批改中…</span>
                  </>
                ) : (
                  "提交练习回答"
                )}
              </button>
            </div>
          </form>

          {/* 演练批改结果 */}
          {drillResult && !resultMatchesDraft && (
            <p role="status" className="text-xs text-muted">问题或回答已修改，请重新提交评估。</p>
          )}
          {drillResult && resultMatchesDraft && (
            <div className="space-y-4 rounded-2xl border border-line bg-card p-4 shadow-card-subtle">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-3">
                <span className="font-serif text-sm font-bold text-ink flex items-center gap-1.5">
                  <span>已保存的回答评估</span>
                </span>
                <DefenseScoreTag score={drillResult.defenseScore} />
              </div>

              {/* 毒舌点评 */}
              <div className="space-y-1 rounded-xl bg-danger-wash/40 border border-danger/20 p-3 text-xs">
                <div className="flex items-center gap-1.5 font-bold text-danger text-[11px]">
                  <span>💬 本次回答点评：</span>
                </div>
                <p className="text-ink leading-relaxed font-sans">{drillResult.interviewerRoast}</p>
              </div>

              {/* 破绽剖析 */}
              <div className="space-y-1 rounded-xl bg-accent-wash/30 border border-accent/20 p-3 text-xs">
                <div className="flex items-center gap-1.5 font-bold text-accent text-[11px]">
                  <span>🔍 已解决与待澄清的问题：</span>
                </div>
                <p className="text-ink leading-relaxed">{drillResult.defenseCritique}</p>
              </div>

              {/* 满分示范 */}
              <div className="space-y-1 rounded-xl bg-primary-soft/30 border border-primary/20 p-3 text-xs">
                <div className="flex items-center gap-1.5 font-bold text-primary text-[11px]">
                  <span>✨ 基于已知事实的改进参考：</span>
                </div>
                <p className="text-ink leading-relaxed font-sans whitespace-pre-wrap">{drillResult.improvedAnswer}</p>
              </div>
            </div>
          )}
      </div>

      {/* 抽屉底栏 */}
      <div className="flex items-center justify-between border-t border-line bg-surface/50 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
        <span className="text-[11px] text-faint">{phase === "unknown" ? "请先核对存档，再决定是否提交" : phase !== "idle" ? "评估仅对应提交时的问题与原答" : "随时修改回答并重新提交评估"}</span>
        <button
          type="button"
          onClick={onClose}
          className={`${btnGhost} text-xs py-1.5 px-3 cursor-pointer`}
        >
          {phase === "idle" ? "完成演练" : "关闭演练"}
        </button>
      </div>
    </>
  );
}

export function DefenseDrillDrawer({
  defenseId,
  item,
  existingDrill,
  isOpen,
  onClose,
  onDrillSaved,
  onDrillsReloaded,
}: DefenseDrillDrawerProps) {
  if (!isOpen || !item) return null;

  return (
    <Drawer
      open={isOpen}
      title="即时防御演练场"
      description="围绕待核实表述练习回答，参考方案不代表真实经历"
      onClose={onClose}
      initialFocusSelector='button[aria-label="关闭"]'
    >
      <DefenseDrillForm
        key={`${defenseId}-${item.id}`}
        defenseId={defenseId}
        item={item}
        existingDrill={existingDrill}
        onClose={onClose}
        onDrillSaved={onDrillSaved}
        onDrillsReloaded={onDrillsReloaded}
      />
    </Drawer>
  );
}
