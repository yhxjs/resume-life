"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { jsonFetch } from "@/lib/fetcher";
import { motionSafeScrollBehavior } from "@/lib/reduced-motion";
import {
  COMPANY_TIER_OPTIONS,
  HR_STYLE_OPTIONS,
  type SuggestedReply,
} from "@/lib/salary-negotiation";
import { readSalaryNegotiationHistory, type SalaryNegotiationHistory } from "@/lib/salary-negotiation-history";
import { btnDanger, btnPrimary, textErr } from "@/lib/ui";
import { SalaryPlaygroundReport } from "@/components/salary/playground-report";
import { SalaryPlaygroundMentor } from "@/components/salary/playground-mentor";
import { SalaryPlaygroundChat } from "@/components/salary/playground-chat";
import { SalaryFinalizeDialog } from "@/components/salary/finalize-dialog";
import { errorMessage } from "@/lib/error-message";
import { useSalaryNegotiationActions } from "@/hooks/use-salary-negotiation-actions";

export default function SalaryNegotiationPlaygroundPage() {
  const params = useParams<{ id: string }>();
  return <SalaryNegotiationSession key={params.id} id={params.id} />;
}

function SalaryNegotiationSession({ id }: { id: string }) {
  const router = useRouter();

  const [data, setData] = useState<SalaryNegotiationHistory | null>(null);
  const [loadError, setLoadError] = useState("");

  // 对话输入与操作
  const [userInput, setUserInput] = useState("");

  // 终局结算
  const [showFinalizeDialog, setShowFinalizeDialog] = useState(false);
  const [finalWords, setFinalWords] = useState("");

  // 军师查看的回合（默认为最新回合）
  const [activeTurnNo, setActiveTurnNo] = useState<number>(1);

  const chatHistoryRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const actions = useSalaryNegotiationActions({
    data, userInput, finalWords,
    onHistory: (history) => {
      setData(history);
      setActiveTurnNo(history.turns.at(-1)?.turn_no ?? 1);
    },
    onTurnSaved: (draft) => setUserInput((current) => current === draft ? "" : current),
    onFinished: () => setShowFinalizeDialog(false),
    onRecovery: () => setShowFinalizeDialog(false),
    onDeleted: () => router.push("/tools/salary"),
  });

  const refetch = useCallback(async (signal: AbortSignal) => {
    return readSalaryNegotiationHistory(await jsonFetch<unknown>(
      `/api/tools/salary-negotiations/${id}`, { signal, cache: "no-store" }
    ), Number(id));
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    refetch(controller.signal)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        if (d.turns.length > 0) {
          setActiveTurnNo(d.turns[d.turns.length - 1]!.turn_no);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [refetch, loadAttempt]);

  // 只滚动对话容器，不因历史回读把整页拉离记录标题；遵循减少动效设置。
  useEffect(() => {
    if (chatHistoryRef.current) {
      chatHistoryRef.current.scrollTo({ top: chatHistoryRef.current.scrollHeight, behavior: motionSafeScrollBehavior() });
    }
  }, [data?.turns.length]);

  function handleSendTurn(e?: React.FormEvent) {
    if (e) e.preventDefault();
    void actions.sendTurn();
  }

  // 点击一键填入建议话术
  function handleApplySuggestion(s: SuggestedReply) {
    if (!actions.canStart() || data?.status !== "ongoing") return;
    setUserInput(s.content);
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }

  if (loadError) return <div className="space-y-4">
    <Link href="/tools/salary" className="text-sm text-primary hover:underline">← 返回博弈列表</Link>
    <LoadError message={loadError} onRetry={() => { setLoadError(""); setLoadAttempt((attempt) => attempt + 1); }} />
  </div>;
  if (!data) return <Loading />;

  const isFinished = data.status === "finished";
  const tierMatch = COMPANY_TIER_OPTIONS.find((t) => t.key === data.target_company_tier);
  const companyTierLabel = tierMatch ? tierMatch.label : data.target_company_tier;

  const hrStyleMatch =
    HR_STYLE_OPTIONS.find((s) => s.key === data.hr_style) ?? { label: data.hr_style || "未记录" };

  // 最新的 HR 心理指标（以最新一轮为准）
  const latestMindset = data.turns[data.turns.length - 1]?.hr_mindset;

  return (
    <div className="mx-auto max-w-[1440px] space-y-6 wrap-anywhere">
      {/* 顶部导航与状态条 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-line pb-5">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Link
              href="/tools/salary"
              className="text-xs font-medium text-primary hover:underline transition-colors flex items-center gap-1"
            >
              ← 返回博弈列表
            </Link>
            <span className="text-xs text-faint">/</span>
            <span className="text-xs text-muted font-mono">博弈对战室 #{data.id}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <h1 className="font-serif text-2xl sm:text-3xl font-bold text-ink">
              {data.target_role}
            </h1>
            <span className="rounded-md border border-line bg-surface px-2 py-0.5 text-xs font-medium text-muted">
              {companyTierLabel}
            </span>
            <span className="rounded-md border border-primary/20 bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary">
              HR风格: {hrStyleMatch.label}
            </span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                isFinished
                  ? "bg-accent/15 text-accent border border-accent/25"
                  : "bg-emerald-500/10 text-emerald-600 border border-emerald-500/30 dark:text-emerald-400"
              }`}
            >
              {isFinished ? "● 模拟已结束 / 已复盘" : "● 交锋对决中"}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted pt-0.5">
            <span>期望目标：<strong className="text-ink font-mono">{data.expected_salary}</strong></span>
            {data.current_or_competing_offer && (
              <span className="min-w-0 whitespace-pre-wrap">底牌筹码：{data.current_or_competing_offer}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isFinished && (
            <button
              type="button"
              onClick={() => { if (actions.canStart()) setShowFinalizeDialog(true); }}
              disabled={actions.busy}
              className={`${btnPrimary} text-xs font-medium`}
            >
              结束模拟 / 生成复盘
            </button>
          )}
          <button type="button" onClick={() => void actions.remove()} disabled={actions.busy && actions.phase !== "confirm-delete"} className={btnDanger}>
            删除
          </button>
        </div>
      </div>

      {actions.notice && <p role="status" className="rounded-lg border border-line bg-surface p-3 text-sm text-muted">{actions.notice}</p>}
      {!showFinalizeDialog && actions.error && <div role="alert" aria-label="谈薪操作状态" className={`space-y-2 rounded-lg border border-line bg-surface p-3 text-sm ${textErr}`}>
        <p>{actions.error}</p>
        {actions.phase === "unknown" && <button type="button" onClick={actions.retryCheck} className={btnPrimary}>重新读取操作状态</button>}
      </div>}
      {actions.phase === "checking" && <p role="status" className="text-sm text-muted">正在读取操作状态，不会重复提交…</p>}

      {/* 终局复盘报告呈现（谈判结束时置顶呈现大图景） */}
      {isFinished && data.report && (
        <SalaryPlaygroundReport
          report={data.report}
          finalPackage={data.final_package}
          hasCandidateResponses={data.turns.some((turn) => turn.user_message.trim())}
        />
      )}

      {/* 双重视角主战场（左侧：HR对决区，右侧：谈判军师区） */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* ================= 左侧：HR 对战区 (7/12) ================= */}
        <div className="lg:col-span-7 min-w-0 space-y-4">
          <SalaryPlaygroundChat
            turns={data.turns}
            hrStyleLabel={hrStyleMatch.label}
            latestMindset={latestMindset}
            isFinished={isFinished}
            userInput={userInput}
            setUserInput={setUserInput}
            submittingTurn={actions.phase === "turn"}
            actionsDisabled={actions.busy}
            turnError=""
            onSendTurn={handleSendTurn}
            onSelectTurn={setActiveTurnNo}
            chatHistoryRef={chatHistoryRef}
            inputRef={inputRef}
          />
        </div>

        {/* ================= 右侧：首席谈判军师/实时拆解区 (5/12) ================= */}
        <div className="lg:col-span-5 min-w-0 space-y-4">
          <SalaryPlaygroundMentor
            turns={data.turns}
            activeTurnNo={activeTurnNo}
            onSelectTurn={setActiveTurnNo}
            onApplySuggestion={handleApplySuggestion}
            isFinished={isFinished}
            suggestionsDisabled={actions.busy}
          />
        </div>
      </div>

      {/* 结束模拟与补充说明弹窗 */}
      <SalaryFinalizeDialog
        open={showFinalizeDialog}
        onClose={() => { if (actions.canStart()) setShowFinalizeDialog(false); }}
        onConfirm={() => void actions.finalize()}
        finalWords={finalWords}
        setFinalWords={setFinalWords}
        finalizing={actions.phase === "finalize"}
        actionsDisabled={actions.busy}
        finalizeError={actions.error}
      />
    </div>
  );
}
