"use client";

import type { RefObject } from "react";
import type { HrMindset, NegotiationTurnData } from "@/lib/salary-negotiation";
import { btnPrimary, cardCls, textareaShortCls, textErr } from "@/lib/ui";

interface SalaryPlaygroundChatProps {
  turns: NegotiationTurnData[];
  hrStyleLabel: string;
  latestMindset?: HrMindset;
  isFinished: boolean;
  userInput: string;
  setUserInput: (input: string) => void;
  submittingTurn: boolean;
  turnError: string;
  onSendTurn: (e?: React.FormEvent) => void;
  onSelectTurn: (turnNo: number) => void;
  chatBottomRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

export function SalaryPlaygroundChat({
  turns,
  hrStyleLabel,
  latestMindset,
  isFinished,
  userInput,
  setUserInput,
  submittingTurn,
  turnError,
  onSendTurn,
  onSelectTurn,
  chatBottomRef,
  inputRef,
}: SalaryPlaygroundChatProps) {
  return (
    <div className="space-y-4">
      {/* HR 心理防线仪表盘 */}
      {latestMindset && (
        <div className={`p-4 ${cardCls} space-y-3 bg-card/90 backdrop-blur-xs`}>
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="font-bold text-ink">HR 心理防线透视</span>
              <span className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-[10px] text-muted">
                {latestMindset.tactics_label}
              </span>
            </div>
            <div className="flex items-center gap-1.5 font-mono text-xs">
              <span className="text-muted">底线松动度:</span>
              <span
                className={`font-bold ${
                  latestMindset.looseness >= 70
                    ? "text-emerald-600 dark:text-emerald-400"
                    : latestMindset.looseness >= 40
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-rose-600 dark:text-rose-400"
                }`}
              >
                {latestMindset.looseness}%
              </span>
            </div>
          </div>

          {/* 松动度进度条 */}
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2 border border-line">
            <div
              className={`h-full transition-all duration-500 ${
                latestMindset.looseness >= 70
                  ? "bg-emerald-500"
                  : latestMindset.looseness >= 40
                  ? "bg-amber-500"
                  : "bg-rose-500"
              }`}
              style={{ width: `${Math.max(5, latestMindset.looseness)}%` }}
            />
          </div>

          {/* 实时态势与底牌预估 */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 pt-1 text-xs">
            <div className="rounded-lg border border-line/60 bg-surface/70 p-2 space-y-0.5">
              <span className="text-[10px] text-muted block">当前交锋态势</span>
              <p className="font-medium text-ink">{latestMindset.current_attitude}</p>
            </div>
            <div className="rounded-lg border border-line/60 bg-surface/70 p-2 space-y-0.5">
              <span className="text-[10px] text-muted block">HR 权限内预估可放行上限</span>
              <p className="font-medium text-primary">{latestMindset.estimated_package}</p>
            </div>
          </div>

          {latestMindset.internal_pressure && (
            <p className="text-[11px] text-muted/90 leading-tight">
              <span className="font-medium text-ink">隐性杠杆：</span>
              {latestMindset.internal_pressure}
            </p>
          )}
        </div>
      )}

      {/* 对话气泡历史流 */}
      <div className="rounded-2xl border border-line bg-card p-4 sm:p-5 shadow-card-subtle space-y-6 max-h-[580px] overflow-y-auto">
        {turns.map((t) => (
          <div key={t.id} className="space-y-4">
            {/* 求职者发言气泡（第 1 回合求职者未发言前为空） */}
            {t.user_message && (
              <div className="flex flex-col items-end space-y-1">
                <div className="flex items-center gap-1.5 text-[11px] text-muted mr-1">
                  <span>你 (候选人)</span>
                  <span className="font-mono text-faint">第 {t.turn_no} 回合</span>
                </div>
                <div className="max-w-[85%] rounded-2xl rounded-tr-xs bg-primary px-4 py-2.5 text-sm text-on-primary leading-relaxed shadow-sm">
                  {t.user_message}
                </div>
                {/* 说服力微评分 */}
                <button
                  type="button"
                  onClick={() => onSelectTurn(t.turn_no)}
                  className="mr-1 flex items-center gap-1 text-[10px] text-muted hover:text-primary transition-colors cursor-pointer"
                >
                  <span>说服力得分:</span>
                  <span className="font-mono font-bold text-primary">
                    {t.mentor_analysis.user_argument_score} / 10
                  </span>
                  <span className="text-faint">· 查看军师拆解 →</span>
                </button>
              </div>
            )}

            {/* HR 回复气泡 */}
            <div className="flex flex-col items-start space-y-1">
              <div className="flex items-center gap-2 text-[11px] text-muted ml-1">
                <span className="font-semibold text-ink">HR ({hrStyleLabel})</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.2 text-[10px] text-muted border border-line">
                  {t.hr_tactics}
                </span>
              </div>
              <div className="max-w-[85%] rounded-2xl rounded-tl-xs border border-line bg-surface px-4 py-3 text-sm text-ink leading-relaxed shadow-xs">
                {t.hr_response}
              </div>
            </div>
          </div>
        ))}
        <div ref={chatBottomRef} />
      </div>

      {/* 候选人输入发言工作区 */}
      {!isFinished ? (
        <form
          onSubmit={onSendTurn}
          className={`p-4 ${cardCls} space-y-3 bg-card`}
        >
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-ink">你的说服回应与反制话术</span>
            <span className="text-faint">
              可点击右侧军师建议「一键填入」
            </span>
          </div>

          <textarea
            ref={inputRef}
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSendTurn();
              }
            }}
            placeholder="表明你的态度、重申业务价值、利用手头筹码进行推拉（按 Enter 直接发送，Shift+Enter 换行）…"
            className={`${textareaShortCls} text-sm`}
            disabled={submittingTurn}
          />

          {turnError && <p className={`text-xs ${textErr}`}>{turnError}</p>}

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setUserInput("")}
              className="text-xs text-muted hover:text-ink cursor-pointer"
            >
              清空
            </button>
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={submittingTurn || !userInput.trim()}
                className={`${btnPrimary} px-5 py-2 text-xs font-semibold`}
              >
                {submittingTurn ? "HR 与军师推演中…" : "发送话术 · 推进博弈"}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <div className={`p-4 text-center ${cardCls} text-xs text-muted`}>
          本次谈判已封板结算。如需继续尝试不同话术策略，可在首页发起新的对决。
        </div>
      )}
    </div>
  );
}
