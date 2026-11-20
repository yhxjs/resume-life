"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoadError } from "@/components/common/ui-bits";
import {
  COMPANY_TIER_OPTIONS,
  HR_STYLE_OPTIONS,
  type CompanyTier,
  type HrStyle,
} from "@/lib/salary-negotiation";
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  cardCls,
  inputCls,
  textareaShortCls,
  labelCls,
  textErr,
} from "@/lib/ui";
import { useCursorList } from "@/hooks/use-cursor-list";
import { useSalaryNegotiationCreation } from "@/hooks/use-salary-negotiation-creation";
import { useToolHistoryDeletion } from "@/hooks/use-tool-history-deletion";
import { ToolHistoryDeletionFeedback } from "@/components/common/tool-history-deletion-feedback";

type NegotiationListItem = {
  id: number;
  target_company_tier: string;
  target_role: string;
  expected_salary: string;
  current_or_competing_offer: string;
  hr_style: string;
  status: "ongoing" | "finished";
  initial_offer: string;
  final_package: string;
  created_at: string;
  finished_at: string;
  turns_count: number;
};

export default function SalaryNegotiationListPage() {
  const router = useRouter();
  const { items, total, nextCursor, loading, loadingMore, listError: loadError, failedCursor, loadMore, reload } = useCursorList<NegotiationListItem>({
    queryKey: "salary-negotiations",
    buildUrl: (cursor) => `/api/tools/salary-negotiations?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    delay: 0,
  });

  // 新建表单状态
  const [selectedTier, setSelectedTier] = useState<CompanyTier>("top_tech");
  const [customTier, setCustomTier] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [expectedSalary, setExpectedSalary] = useState("");
  const [competingOffer, setCompetingOffer] = useState("");
  const [selectedHrStyle, setSelectedHrStyle] = useState<HrStyle>("standard");

  const deletion = useToolHistoryDeletion("salary-negotiations", reload);
  const visibleItems = items?.filter((item) => !deletion.deletedIds.has(item.id)) ?? null;
  const creation = useSalaryNegotiationCreation({
    historyReady: items !== null && !loading && !loadError,
    onUnknown: reload,
    onCreated: (id) => router.push(`/tools/salary/${id}`),
    onRestore: (input) => {
      const tier = COMPANY_TIER_OPTIONS.find((option) => option.key === input.target_company_tier);
      setSelectedTier(tier?.key ?? "custom"); setCustomTier(tier ? "" : input.target_company_tier);
      setTargetRole(input.target_role); setExpectedSalary(input.expected_salary);
      setCompetingOffer(input.current_or_competing_offer); setSelectedHrStyle(input.hr_style);
    },
  });

  function handleStart() {
    if (!deletion.canStart()) return;
    const companyTier =
      selectedTier === "custom" && customTier.trim()
        ? customTier.trim()
        : selectedTier;

    void creation.start({
      target_company_tier: companyTier, target_role: targetRole.trim(), expected_salary: expectedSalary.trim(),
      current_or_competing_offer: competingOffer.trim(), hr_style: selectedHrStyle,
    });
  }

  function getTierLabel(key: string) {
    const found = COMPANY_TIER_OPTIONS.find((t) => t.key === key);
    return found ? found.label : key;
  }

  function getStyleLabel(style: string) {
    const found = HR_STYLE_OPTIONS.find((s) => s.key === style);
    return found ? found.label : style;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8 wrap-anywhere">
      {/* 顶部标题栏 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">
            Offer 谈判与薪酬博弈模拟器
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            练习薪酬沟通、核实条件与表达诉求。HR 回应、心理状态和军师建议均为模拟，不代表真实公司的报价、预算或态度，也不保证涨薪。
          </p>
        </div>
        {items !== null && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>已载入博弈存档：<strong className="font-mono text-ink font-bold text-sm">{visibleItems?.length}</strong> 场{total !== null && ` / 共 ${total} 场`}</span>
          </div>
        )}
      </div>

      {/* 新建谈判演练工作台 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
        <p className="text-sm text-muted">已有两份实际 Offer？结合收入、时间成本和个人偏好，再决定如何谈。</p>
        <Link href="/tools/offer" className={btnGhost}>比较 Offer 实际价值 →</Link>
      </div>

      <div className={`space-y-6 p-6 sm:p-7 ${cardCls}`}>
        <div className="border-b border-line pb-4">
          <h2 className="font-serif text-lg font-bold text-ink">发起一场薪酬博弈演练</h2>
          <p className="mt-1 text-xs text-muted">
            提供本次练习的求职背景与筹码，生成模拟开场和练习建议；请保留薪酬口径、条件及尚未确认的信息。
          </p>
        </div>

        {/* 1. 目标公司梯队 */}
        <div>
          <span className={labelCls}>目标公司类型 / 等级</span>
          <div className="mt-2 grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-5">
            {COMPANY_TIER_OPTIONS.map((tier) => {
              const active = selectedTier === tier.key;
              return (
                <button
                  key={tier.key}
                  type="button"
                  onClick={() => setSelectedTier(tier.key)}
                  disabled={creation.busy}
                  aria-pressed={active}
                  className={`flex flex-col items-start rounded-xl border p-3 text-left transition-all ${
                    active
                      ? "border-primary bg-primary-soft shadow-xs"
                      : "border-line bg-surface hover:border-line-strong hover:bg-surface-2"
                  }`}
                >
                  <span className={`text-sm font-semibold ${active ? "text-primary" : "text-ink"}`}>
                    {tier.label}
                  </span>
                  <span className="mt-1 text-[11px] leading-tight text-muted">
                    {tier.desc}
                  </span>
                </button>
              );
            })}
          </div>
          {selectedTier === "custom" && (
            <input
              type="text"
              value={customTier}
              aria-label="自定义公司类型或特点"
              disabled={creation.busy}
              onChange={(e) => setCustomTier(e.target.value)}
              placeholder="请输入自定义公司类型或特点，如：某细分行业头部拟上市公司"
              className={`${inputCls} mt-2 text-sm`}
            />
          )}
        </div>

        {/* 2. 目标岗位 & 期望薪资 */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelCls}>目标岗位与职级（必填）</span>
            <input
              type="text"
              value={targetRole}
              disabled={creation.busy}
              onChange={(e) => setTargetRole(e.target.value)}
              placeholder="例如：资深前端工程师 (P7/Tech Lead)"
              className={`${inputCls} mt-1`}
            />
          </label>

          <label className="block">
            <span className={labelCls}>期望薪资目标（必填）</span>
            <input
              type="text"
              value={expectedSalary}
              disabled={creation.busy}
              onChange={(e) => setExpectedSalary(e.target.value)}
              placeholder="例如：35k * 16 薪，预期总包 55W~60W"
              className={`${inputCls} mt-1`}
            />
          </label>
        </div>

        {/* 3. 底牌筹码：现有或竞品 Offer */}
        <label className="block">
          <span id="salary-competing-label" className={labelCls}>
            已有竞品 Offer 或当前薪资（谈判底牌 / 筹码）
          </span>
          <textarea
            aria-labelledby="salary-competing-label"
            aria-describedby="salary-competing-hint"
            value={competingOffer}
            disabled={creation.busy}
            onChange={(e) => setCompetingOffer(e.target.value)}
            placeholder="例如：目前手头持有某独角兽 32k*15 + 3W 签字费的口头 Offer，要求下周一前答复；或者：当前公司 base 28k，年终稳定 3 个月"
            className={`${textareaShortCls} mt-1`}
          />
          <span id="salary-competing-hint" className="mt-1 block text-[11px] text-faint">
            提示：竞品 Offer、现有福利补贴、签字费或业务替代门槛都是拉扯的关键筹码。
          </span>
        </label>

        {/* 4. HR 风格偏好 */}
        <fieldset>
          <legend className={labelCls}>对手 HR 人设与风格</legend>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {HR_STYLE_OPTIONS.map((style) => {
              const active = selectedHrStyle === style.key;
              return (
                <label
                  key={style.key}
                  className={`block cursor-pointer rounded-xl border p-3.5 transition-all focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary ${
                    active
                      ? "border-primary bg-primary-soft/80 shadow-xs ring-1 ring-primary/40"
                      : "border-line bg-surface hover:border-line-strong hover:bg-surface-2"
                  }`}
                >
                  <input
                    type="radio"
                    name="hr-style"
                    value={style.key}
                    checked={active}
                    disabled={creation.busy}
                    onChange={() => setSelectedHrStyle(style.key)}
                    aria-labelledby={`hr-style-${style.key}`}
                    className="sr-only"
                  />
                  <span className="flex items-center justify-between">
                    <span
                      id={`hr-style-${style.key}`}
                      className={`text-sm font-bold ${
                        active ? "text-primary" : "text-ink"
                      }`}
                    >
                      {style.label}
                    </span>
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        active ? "bg-primary" : "bg-line-strong"
                      }`}
                    />
                  </span>
                  <span className="mt-2 block text-xs leading-relaxed text-muted">{style.persona}</span>
                  <span className="mt-2 block border-t border-line/60 pt-2 text-[11px] text-primary/90">
                    <span className="font-medium">练习重点：</span>
                    {style.practiceFocus}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {creation.error && <div role="alert" aria-label="谈薪创建状态" className={`space-y-2 text-sm ${textErr}`}>
          <p>{creation.error}</p>
          {creation.phase === "unknown" && <div className="flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} onClick={creation.retryCheck}>重新读取创建结果</button>
            <button type="button" className={btnGhost} onClick={creation.reviewUnresolved}>核对历史后另建演练</button>
          </div>}
          {creation.phase === "review" && <div className="flex flex-wrap gap-2">
            {creation.canCheckRequest && <button type="button" className={btnPrimary} onClick={creation.retryCheck}>按请求编号核对结果</button>}
            <button type="button" className={btnGhost} onClick={reload} disabled={loading}>刷新历史记录</button>
            <button type="button" className={btnPrimary} onClick={creation.allowRetry} disabled={loading || items === null || !!loadError}>已核对历史，允许再次创建</button>
          </div>}
        </div>}
        {creation.notice && <p role="status" className="text-sm text-muted">{creation.notice}</p>}
        {(creation.phase === "posting" || creation.phase === "checking" || creation.phase === "navigating") && <p role="status" className="text-sm text-muted">
          {creation.phase === "posting" ? "正在生成模拟开场，表单已锁定…" : creation.phase === "checking" ? "正在核对已保存的创建结果，不会重复调用模型…" : "已核对模拟记录，正在进入对战室…"}
        </p>}

        <div className="flex items-center justify-end pt-2">
          <button
            type="button"
            onClick={handleStart}
            disabled={creation.busy || deletion.busy}
            className={`${btnPrimary} px-6 py-2.5 text-sm font-medium shadow-sm`}
          >
            {creation.phase === "posting" ? "正在推演 HR 初始出招与首轮解盘…" : "开局！进入薪资博弈对决"}
          </button>
        </div>
      </div>

      {/* 历史演练记录列表 */}
      <div className="space-y-3">
        <ToolHistoryDeletionFeedback deletion={deletion} />
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-lg font-bold text-ink">历史博弈记录</h2>
          {visibleItems && visibleItems.length > 0 && (
            <span className="font-mono text-xs text-muted">已载入 {visibleItems.length} 场演练</span>
          )}
        </div>

        {loadError && <LoadError message={`谈判历史加载失败：${loadError}`} onRetry={failedCursor === null ? reload : loadMore} />}

        {items === null && !loadError && (
          <p className="mt-4 text-xs text-muted">正在加载历史记录…</p>
        )}

        {visibleItems !== null && visibleItems.length === 0 && (
          <div className={`mt-4 p-8 text-center ${cardCls}`}>
            <p className="text-sm text-muted">暂无薪酬谈判历史记录。</p>
            <p className="mt-1 text-xs text-faint">
              在上方填写你的目标岗位与期望薪资，开启第一次拟真拉扯吧！
            </p>
          </div>
        )}

        {visibleItems !== null && visibleItems.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-card shadow-card-subtle divide-y divide-line">
            {visibleItems.map((it) => {
              const isFinished = it.status === "finished";
              return (
                <div
                  key={it.id}
                  role="group"
                  aria-label={`谈薪演练 #${it.id}`}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5 transition-colors hover:bg-surface/50"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/tools/salary/${it.id}`}
                        className="font-serif text-base font-bold text-ink hover:text-primary hover:underline"
                      >
                        {it.target_role}
                      </Link>
                      <span className="inline-flex rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-muted">
                        {getTierLabel(it.target_company_tier)}
                      </span>
                      <span className="inline-flex rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-muted">
                        HR: {getStyleLabel(it.hr_style)}
                      </span>
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          isFinished
                            ? "bg-accent/15 text-accent border border-accent/25"
                            : "bg-primary-soft text-primary border border-primary/25"
                        }`}
                      >
                        {isFinished ? "模拟已结束 / 已复盘" : "交锋进行中"}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                      <span>期望: {it.expected_salary}</span>
                      <span>开盘: {it.initial_offer}</span>
                      {it.final_package && (
                        <span className="font-medium text-primary">终局: {it.final_package}</span>
                      )}
                      <span className="font-mono text-faint">
                        {it.turns_count} 轮拉扯 · {new Date(it.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Link href={`/tools/salary/${it.id}`} className={btnGhost}>
                      {isFinished ? "查看复盘" : "继续谈判"}
                    </Link>
                    <button
                      type="button"
                      onClick={() => { if (creation.canStart()) void deletion.remove(it.id, it.target_role); }}
                      disabled={deletion.busy || creation.busy}
                      className={btnDanger}
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {nextCursor && (
          <div className="flex justify-center pt-4">
            <button type="button" className={btnPrimary} onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "加载中…" : failedCursor === nextCursor ? "重试加载更多" : "加载更多"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
