"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { confirmDialog, alertDialog } from "@/components/common/confirm-dialog";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { jsonFetch } from "@/lib/fetcher";
import { motionSafeScrollBehavior } from "@/lib/reduced-motion";
import {
  COMPANY_TIER_OPTIONS,
  HR_STYLE_OPTIONS,
  type NegotiationTurnData,
  type SalaryNegotiationDetail,
  type SuggestedReply,
} from "@/lib/salary-negotiation";
import { btnDanger, btnPrimary } from "@/lib/ui";
import { SalaryPlaygroundReport } from "@/components/salary/playground-report";
import { SalaryPlaygroundMentor } from "@/components/salary/playground-mentor";
import { SalaryPlaygroundChat } from "@/components/salary/playground-chat";
import { SalaryFinalizeDialog } from "@/components/salary/finalize-dialog";
import { errorMessage } from "@/lib/error-message";

export default function SalaryNegotiationPlaygroundPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const [data, setData] = useState<SalaryNegotiationDetail | null>(null);
  const [loadError, setLoadError] = useState("");

  // 对话输入与操作
  const [userInput, setUserInput] = useState("");
  const [submittingTurn, setSubmittingTurn] = useState(false);
  const [turnError, setTurnError] = useState("");

  // 终局结算
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState("");
  const [showFinalizeDialog, setShowFinalizeDialog] = useState(false);
  const [finalWords, setFinalWords] = useState("");

  // 军师查看的回合（默认为最新回合）
  const [activeTurnNo, setActiveTurnNo] = useState<number>(1);

  const chatBottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const refetch = useCallback(async () => {
    return jsonFetch<SalaryNegotiationDetail>(
      `/api/tools/salary-negotiations/${params.id}`
    );
  }, [params.id]);

  useEffect(() => {
    let cancelled = false;
    refetch()
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
    };
  }, [refetch, loadAttempt]);

  // 当有新消息时，滚向底部（系统要求减少动效时改为即时跳转）
  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: motionSafeScrollBehavior() });
    }
  }, [data?.turns.length]);

  // 发送说服话术
  async function handleSendTurn(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!userInput.trim() || submittingTurn || !data || data.status !== "ongoing") return;

    setSubmittingTurn(true);
    setTurnError("");

    try {
      const newTurn = await jsonFetch<NegotiationTurnData>(
        `/api/tools/salary-negotiations/${data.id}/turn`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_message: userInput.trim() }),
        }
      );

      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          turns: [...prev.turns, newTurn],
        };
      });

      setUserInput("");
      setActiveTurnNo(newTurn.turn_no);
    } catch (err) {
      setTurnError(errorMessage(err));
    } finally {
      setSubmittingTurn(false);
    }
  }

  // 点击一键填入建议话术
  function handleApplySuggestion(s: SuggestedReply) {
    setUserInput(s.content);
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }

  // 结束谈判并生成终局复盘报告
  async function handleFinalizeNegotiation() {
    if (!data) return;
    setFinalizing(true);
    setFinalizeError("");

    try {
      const res = await jsonFetch<{
        status: "finished";
        final_package: string;
        report: NonNullable<SalaryNegotiationDetail["report"]>;
      }>(`/api/tools/salary-negotiations/${data.id}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ final_words: finalWords.trim() }),
      });

      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          status: "finished",
          final_package: res.final_package,
          report: res.report,
        };
      });
      setShowFinalizeDialog(false);
    } catch (err) {
      setFinalizeError(errorMessage(err));
    } finally {
      setFinalizing(false);
    }
  }

  async function handleDelete() {
    if (!data) return;
    if (
      !(await confirmDialog({
        title: "删除博弈记录",
        message: "确定删除这场薪酬博弈演练吗？",
        danger: true,
      }))
    ) {
      return;
    }

    try {
      await jsonFetch(`/api/tools/salary-negotiations/${data.id}`, {
        method: "DELETE",
      });
      router.push("/tools/salary");
    } catch (err) {
      await alertDialog({
        title: "删除失败",
        message: errorMessage(err),
      });
    }
  }

  if (loadError) return <LoadError message={loadError} onRetry={() => { setLoadError(""); setLoadAttempt((attempt) => attempt + 1); }} />;
  if (!data) return <Loading />;

  const isFinished = data.status === "finished";
  const tierMatch = COMPANY_TIER_OPTIONS.find((t) => t.key === data.target_company_tier);
  const companyTierLabel = tierMatch ? tierMatch.label : data.target_company_tier;

  const hrStyleMatch =
    HR_STYLE_OPTIONS.find((s) => s.key === data.hr_style) ?? HR_STYLE_OPTIONS[1]!;

  // 最新的 HR 心理指标（以最新一轮为准）
  const latestMindset = data.turns[data.turns.length - 1]?.hr_mindset;

  return (
    <div className="mx-auto max-w-[1440px] space-y-6">
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
              {isFinished ? "● 谈判封板 / 已复盘" : "● 交锋对决中"}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted pt-0.5">
            <span>期望目标：<strong className="text-ink font-mono">{data.expected_salary}</strong></span>
            {data.current_or_competing_offer && (
              <span className="truncate max-w-md">底牌筹码：{data.current_or_competing_offer}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isFinished && (
            <button
              type="button"
              onClick={() => setShowFinalizeDialog(true)}
              className={`${btnPrimary} text-xs font-medium`}
            >
              达成共识 / 结束复盘
            </button>
          )}
          <button type="button" onClick={handleDelete} className={btnDanger}>
            删除
          </button>
        </div>
      </div>

      {/* 终局复盘报告呈现（谈判结束时置顶呈现大图景） */}
      {isFinished && data.report && (
        <SalaryPlaygroundReport
          report={data.report}
          finalPackage={data.final_package}
        />
      )}

      {/* 双重视角主战场（左侧：HR对决区，右侧：谈判军师区） */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* ================= 左侧：HR 对战区 (7/12) ================= */}
        <div className="lg:col-span-7 space-y-4">
          <SalaryPlaygroundChat
            turns={data.turns}
            hrStyleLabel={hrStyleMatch.label}
            latestMindset={latestMindset}
            isFinished={isFinished}
            userInput={userInput}
            setUserInput={setUserInput}
            submittingTurn={submittingTurn}
            turnError={turnError}
            onSendTurn={handleSendTurn}
            onSelectTurn={setActiveTurnNo}
            chatBottomRef={chatBottomRef}
            inputRef={inputRef}
          />
        </div>

        {/* ================= 右侧：首席谈判军师/实时拆解区 (5/12) ================= */}
        <div className="lg:col-span-5 space-y-4">
          <SalaryPlaygroundMentor
            turns={data.turns}
            activeTurnNo={activeTurnNo}
            onSelectTurn={setActiveTurnNo}
            onApplySuggestion={handleApplySuggestion}
            isFinished={isFinished}
          />
        </div>
      </div>

      {/* 达成共识/提前结算弹窗 */}
      <SalaryFinalizeDialog
        open={showFinalizeDialog}
        onClose={() => setShowFinalizeDialog(false)}
        onConfirm={handleFinalizeNegotiation}
        finalWords={finalWords}
        setFinalWords={setFinalWords}
        finalizing={finalizing}
        finalizeError={finalizeError}
      />
    </div>
  );
}
