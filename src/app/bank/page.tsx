"use client";

import { useEffect, useState } from "react";
import { ToolHistoryDeletionFeedback } from "@/components/common/tool-history-deletion-feedback";
import { Combobox } from "@/components/common/combobox";
import { InlineError } from "@/components/common/inline-error";
import { Empty, Loading } from "@/components/common/ui-bits";
import { BANK_KINDS, MAX_BANK_IMPORT, readBankDirections, readBankListPage, type BankEntry } from "@/lib/bank";
import { jsonFetch } from "@/lib/fetcher";
import { btnDanger, btnPrimary, inputCls, textareaCls, labelCls } from "@/lib/ui";
import { useCursorList } from "@/hooks/use-cursor-list";
import { useCompositionInput } from "@/hooks/use-composition-input";
import { useBankImport } from "@/hooks/use-bank-import";
import { useBankDeletion } from "@/hooks/use-bank-deletion";
import { errorMessage } from "@/lib/error-message";

type DirectionStat = { direction: string; count: number };
function kindLabel(kind: string): string {
  return BANK_KINDS.find((k) => k.key === kind)?.label ?? kind;
}

const SAMPLE_TECH_QUESTIONS = `讲讲浏览器从输入 URL 到页面渲染的完整过程与优化关键链路
深入解析 Vue3/React 的响应式原理与虚拟 DOM Diff 算法差异
TCP 三次握手与四次挥手全流程，TIME_WAIT 状态的作用是什么？
谈谈前端工程化：Webpack / Vite 构建打包性能调优实战经验`;

const SAMPLE_BEHAVIOR_QUESTIONS = `请介绍一次你在团队中与产品经理或同事发生严重技术分歧的解决经历
谈谈你在过往项目中遇到过最棘手的生产环境线上故障，你是如何定位并复盘的？
当业务需求排期非常紧张，技术债务严重时，你如何做权衡与向上沟通？`;

export default function BankPage() {
  const [directions, setDirections] = useState<DirectionStat[]>([]);

  // 列表筛选（防抖刷新）
  const [filterDirection, setFilterDirection] = useState("");
  const [directionsError, setDirectionsError] = useState("");
  const [directionsReloadVersion, setDirectionsReloadVersion] = useState(0);
  const [filterKind, setFilterKind] = useState("");
  const [keyword, setKeyword] = useState("");
  const { bind: keywordInputBind } = useCompositionInput("", setKeyword);

  const {
    items,
    nextCursor,
    loadingMore,
    listError: loadError,
    failedCursor,
    loadMore: loadItems,
    reload: reloadList,
  } = useCursorList<BankEntry>({
    queryKey: JSON.stringify(["bank", filterDirection, filterKind, keyword.trim()]),
    delay: 250,
    validatePage: (page, cursor) => { readBankListPage(page, { direction: filterDirection, kind: filterKind, keyword, cursor }); },
    buildUrl: (cursor) => {
      const params = new URLSearchParams();
      if (filterDirection) params.set("direction", filterDirection);
      if (filterKind) params.set("kind", filterKind);
      if (keyword.trim()) params.set("q", keyword.trim());
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      return `/api/bank${qs ? `?${qs}` : ""}`;
    },
  });

  function refreshBank() { reloadList(); setDirectionsReloadVersion(version => version + 1); }
  const deletion = useBankDeletion(refreshBank);
  const { draft, change, count: draftCount, locked: importLocked, phase, notice: importNotice, recovery, submit: importQuestions, reread, allowRetry, canStart: canImport } = useBankImport(refreshBank, deletion.canStart);
  const locked = importLocked || deletion.busy;
  const visibleItems = items?.filter(item => !deletion.deletedIds.has(item.id)) ?? null;
  const { direction: importDirection, kind: importKind, text: importText } = draft;
  const importing = phase === "submitting";

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    jsonFetch<unknown>("/api/bank/directions", { signal: controller.signal, cache: "no-store" })
      .then((value) => {
        if (cancelled) return;
        setDirections(readBankDirections(value));
        setDirectionsError("");
      })
      .catch((reason) => {
        if (cancelled) return;
        setDirectionsError(errorMessage(reason));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [directionsReloadVersion]);

  function remove(entry: BankEntry) {
    if (canImport()) void deletion.remove(entry);
  }

  return (
    <div className="mx-auto min-w-0 max-w-7xl space-y-8 [overflow-wrap:anywhere]">
      {/* 顶部标题栏 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">
            岗位通用题库
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            结构化沉淀技术八股与行为考题；在「题目练习」按 JD/方向出题时，AI 将把此题库作为底层参考题源。
          </p>
        </div>
        {visibleItems !== null && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>当前筛选显示：<strong className="font-mono text-ink font-bold text-sm">{visibleItems.length}</strong> 题</span>
          </div>
        )}
      </div>

      {/* 录入工作台 */}
      <div className="rounded-2xl border border-line bg-card p-6 shadow-card-subtle space-y-4">
        <fieldset disabled={locked} aria-label="批量录入考题" className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 pb-3">
          <div className="flex items-center gap-2">
            <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
            <h2 className="text-sm font-serif font-bold text-ink">批量录入考题</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">快速填入示例：</span>
            <button
              type="button"
              onClick={() => {
                change({ direction: "前端开发", kind: "tech", text: SAMPLE_TECH_QUESTIONS });
              }}
              className="text-primary hover:underline font-medium"
            >
              技术八股
            </button>
            <span className="text-faint">·</span>
            <button
              type="button"
              onClick={() => {
                change({ direction: "通用行为", kind: "behavior", text: SAMPLE_BEHAVIOR_QUESTIONS });
              }}
              className="text-primary hover:underline font-medium"
            >
              综合行为
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <label className="block w-60">
            <span className={labelCls}>归属技术方向（可自由新建或选已有）</span>
            <div className="mt-1">
              <Combobox
                value={importDirection}
                onChange={direction => change({ direction })}
                options={directions.map((d) => d.direction)}
                placeholder="如：前端 / Java 后端 / Go"
                ariaLabel="导入方向"
              />
            </div>
          </label>
          <div>
            <span className={labelCls}>考题题型</span>
            <div className="mt-1 flex gap-1.5">
              {BANK_KINDS.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  onClick={() => change({ kind: k.key })}
                  aria-pressed={importKind === k.key}
                  className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
                    importKind === k.key
                      ? "bg-primary text-on-primary font-bold shadow-xs"
                      : "border border-line text-muted hover:bg-surface hover:text-ink"
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className="block" htmlFor="bank-import-questions">
          <span className={labelCls}>导入考题</span>
          <textarea
            id="bank-import-questions"
            className={`${textareaCls} mt-1 font-sans text-xs sm:text-sm`}
            value={importText}
            onChange={(e) => {
              change({ text: e.target.value });
            }}
            placeholder={"粘贴考题文本，每行一题，自动识别分割，例如：\n讲讲浏览器从输入 URL 到页面渲染的完整过程\n谈谈你在团队冲突中的一次处理经历"}
          />
        </label>

        <p className="text-xs text-muted">每次最多导入 {MAX_BANK_IMPORT} 道题，同一批次内重复题目自动合并；不同批次再次导入仍会新增题目，超过上限请分批导入。</p>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <span className="text-xs text-muted font-mono">
            {draftCount > 0 ? `已识别 ${draftCount} 道有效题目` : "每行识别为独立一道考题"}
          </span>
          <button type="button" className={btnPrimary} onClick={importQuestions} disabled={locked || draftCount === 0}>
            {importing ? "正在存入题库…" : `导入 ${draftCount > 0 ? `${draftCount} 道考题` : "题目"}`}
          </button>
        </div>
        </fieldset>

        {importNotice && (
          <div role={importNotice.kind === "ok" ? "status" : "alert"} className={`rounded-xl border p-3 text-xs ${
            importNotice.kind === "ok"
              ? "border-primary/30 bg-primary-soft text-primary"
              : "border-danger/30 bg-danger-wash text-danger"
          }`}>
            {importNotice.text}
          </div>
        )}
        {phase === "checking" && <p role="status" className="text-xs text-muted">正在只读读取题库，导入原稿已锁定…</p>}
        {(phase === "unknown" || phase === "checking" || phase === "confirming") && (
          <div className="flex flex-wrap gap-3">
            <button type="button" className={btnPrimary} onClick={reread} disabled={phase !== "unknown"}>重新读取题库</button>
            {recovery && <button type="button" className={btnDanger} onClick={allowRetry} disabled={phase !== "unknown" && phase !== "confirming"}>保留原稿并允许再次导入</button>}
          </div>
        )}
        {recovery && (
          <section aria-label="导入结果核对快照" className="space-y-3 rounded-xl border border-line bg-surface p-4 text-xs">
            <h3 className="font-semibold text-ink">当前题库只读快照</h3>
            <p className="text-muted">题型：{kindLabel(importKind)}；{importDirection.trim() ? `方向：${importDirection.trim()}` : "未指定方向，读取此题型的全部方向"}。仅展示最近一页、最多 50 道题；这不是本批次的写入回执。{recovery.nextCursor ? "仍有更早题目，请到下方目录继续筛选核对。" : ""}</p>
            {recovery.items.length === 0 ? <p>当前筛选暂未读到题目；上次请求仍可能稍后完成。</p> : (
              <ul className="max-h-72 space-y-3 overflow-y-auto">
                {recovery.items.map(item => <li key={item.id} className="space-y-1 border-t border-line pt-2"><p className="text-muted">#{item.id} · {item.direction || "未指定方向"} · {kindLabel(item.kind)}</p><p className="whitespace-pre-wrap text-ink">{item.question}</p></li>)}
              </ul>
            )}
          </section>
        )}
      </div>

      {/* 题库检索与卡片列表 */}
      <div className="space-y-4">
        <ToolHistoryDeletionFeedback deletion={deletion} deletingLabel="正在删除题目…" />
        {/* 快捷方向筛选药丸组 */}
        {(directions.length > 0 || filterDirection) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-xs text-faint mr-1">方向速选:</span>
            <button
              type="button"
              aria-pressed={filterDirection === ""}
              onClick={() => setFilterDirection("")}
              className={`rounded-full px-3 py-1 text-xs transition-all ${
                filterDirection === ""
                  ? "bg-ink text-bg font-bold shadow-xs"
                  : "border border-line bg-card text-muted hover:text-ink hover:border-line-strong"
              }`}
            >
              全部方向
            </button>
            {directions.map((d) => (
              <button
                key={d.direction}
                type="button"
                aria-pressed={filterDirection === d.direction}
                onClick={() => setFilterDirection(filterDirection === d.direction ? "" : d.direction)}
                className={`rounded-full px-3 py-1 text-xs transition-all ${
                  filterDirection === d.direction
                    ? "bg-primary text-on-primary font-bold shadow-xs"
                    : "border border-line bg-card text-muted hover:text-ink hover:border-primary/40"
                }`}
              >
                {d.direction} ({d.count})
              </button>
            ))}
            {filterDirection && !directions.some(item => item.direction === filterDirection) && (
              <span className="text-xs text-muted">当前方向：{filterDirection}</span>
            )}
          </div>
        )}

        {directionsError && (
          <InlineError
            message={`方向列表加载失败：${directionsError}`}
            onRetry={() => setDirectionsReloadVersion((version) => version + 1)}
          />
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="flex items-center gap-2">
            <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
            <h2 className="font-serif text-base font-bold text-ink">题库目录与检索</h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="w-36">
              <select
                aria-label="按题型过滤"
                className={inputCls}
                value={filterKind}
                onChange={(e) => setFilterKind(e.target.value)}
              >
                <option value="">全部题型</option>
                {BANK_KINDS.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-64">
              <input
                type="search"
                aria-label="搜索题库"
                placeholder="搜索考题关键词…"
                className={inputCls}
                {...keywordInputBind}
              />
            </div>
          </div>
        </div>

        {loadError && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger-wash p-4 text-xs text-danger">
            <span>{loadError}</span>
            {failedCursor === null && (
              <button
                type="button"
                className={btnPrimary}
                onClick={reloadList}
              >
                重试加载
              </button>
            )}
          </div>
        )}
        {visibleItems === null ? !loadError && (
          <Loading label="正在检索题库数据…" />
        ) : visibleItems.length === 0 ? (
          <Empty>
            {nextCursor
              ? "当前已加载的题目均已删除，可继续加载更早题目。"
              : filterDirection || filterKind || keyword.trim()
              ? "没有匹配的考题，试试切换或清除筛选条件。"
              : "题库还是空的。在上方粘贴题目文本导入第一批，再到「题目练习」按方向出题！"}
          </Empty>
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-card shadow-card-subtle overflow-hidden">
            {visibleItems.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-4 p-4 sm:p-5 transition-colors hover:bg-surface/40">
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-mono font-medium ${
                      item.kind === "tech"
                        ? "border border-primary/25 bg-primary-soft text-primary"
                        : "border border-accent/25 bg-accent-wash text-accent"
                    }`}>
                      {kindLabel(item.kind)}
                    </span>
                    {item.direction && (
                      <span className="inline-flex rounded-full border border-line bg-surface px-2.5 py-0.5 text-[10px] font-medium text-muted">
                        {item.direction}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm sm:text-[15px] leading-relaxed text-ink font-serif font-bold">
                    {item.question}
                  </p>
                  <p className="text-[11px] text-faint font-mono">
                    录入时间：{new Date(item.created_at).toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => remove(item)}
                  disabled={locked}
                  className={`${btnDanger} shrink-0 text-xs`}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
        {visibleItems !== null && nextCursor && (
          <div className="flex justify-center pt-2">
            <button
              type="button"
              className={btnPrimary}
              onClick={loadItems}
              disabled={loadingMore}
            >
              {loadingMore
                ? "正在加载"
                : failedCursor === nextCursor
                  ? "重试加载更多"
                  : "加载更多"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
