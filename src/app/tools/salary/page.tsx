"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { confirmDialog, alertDialog } from "@/components/common/confirm-dialog";
import { jsonFetch } from "@/lib/fetcher";
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
import { errorMessage } from "@/lib/error-message";
import { useCursorList } from "@/hooks/use-cursor-list";

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
  const { items, total, nextCursor, loadingMore, listError: loadError, failedCursor, loadMore, reload } = useCursorList<NegotiationListItem>({
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

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  async function handleStart() {
    if (!targetRole.trim() || !expectedSalary.trim()) {
      setCreateError("请填写目标岗位与期望薪资");
      return;
    }

    setCreating(true);
    setCreateError("");

    const companyTier =
      selectedTier === "custom" && customTier.trim()
        ? customTier.trim()
        : selectedTier;

    try {
      const data = await jsonFetch<{ id: number }>("/api/tools/salary-negotiations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_company_tier: companyTier,
          target_role: targetRole.trim(),
          expected_salary: expectedSalary.trim(),
          current_or_competing_offer: competingOffer.trim(),
          hr_style: selectedHrStyle,
        }),
      });
      router.push(`/tools/salary/${data.id}`);
    } catch (err) {
      setCreateError(errorMessage(err));
      setCreating(false);
    }
  }

  async function handleDelete(id: number) {
    if (
      !(await confirmDialog({
        title: "删除谈判演练",
        message: "确定要删除这场薪酬博弈演练吗？包含的所有回合记录都将被移除。",
        danger: true,
      }))
    ) {
      return;
    }

    try {
      await jsonFetch(`/api/tools/salary-negotiations/${id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      await alertDialog({
        title: "删除失败",
        message: errorMessage(err),
      });
    }
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
    <div className="mx-auto max-w-6xl space-y-8">
      {/* 顶部标题栏 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">
            Offer 谈判与薪酬博弈模拟器
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            通过人机拟真博弈，与挑刺/规范/画饼型 HR 进行多轮拉扯，右侧实时军师拆解说服逻辑漏洞并示范高情商反击话术，谈出最优 Package。
          </p>
        </div>
        {items !== null && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>已载入博弈存档：<strong className="font-mono text-ink font-bold text-sm">{items.length}</strong> 场{total !== null && ` / 共 ${total} 场`}</span>
          </div>
        )}
      </div>

      {/* 新建谈判演练工作台 */}
      <div className={`space-y-6 p-6 sm:p-7 ${cardCls}`}>
        <div className="border-b border-line pb-4">
          <h2 className="font-serif text-lg font-bold text-ink">发起一场薪酬博弈演练</h2>
          <p className="mt-1 text-xs text-muted">
            提供你的求职背景与底牌筹码，AI 将化身对手 HR 与己方军师，开启拟真双重视角推拉。
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
                  className={`flex flex-col items-start rounded-xl border p-3 text-left transition-all ${
                    active
                      ? "border-primary bg-primary-soft shadow-xs"
                      : "border-line bg-surface hover:border-line-strong hover:bg-surface-2"
                  }`}
                >
                  <span className={`text-sm font-semibold ${active ? "text-primary" : "text-ink"}`}>
                    {tier.label}
                  </span>
                  <span className="mt-1 line-clamp-2 text-[11px] leading-tight text-muted">
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
              onChange={(e) => setExpectedSalary(e.target.value)}
              placeholder="例如：35k * 16 薪，预期总包 55W~60W"
              className={`${inputCls} mt-1`}
            />
          </label>
        </div>

        {/* 3. 底牌筹码：现有或竞品 Offer */}
        <label className="block">
          <span className={labelCls}>
            已有竞品 Offer 或当前薪资（谈判底牌 / 筹码）
          </span>
          <textarea
            value={competingOffer}
            onChange={(e) => setCompetingOffer(e.target.value)}
            placeholder="例如：目前手头持有某独角兽 32k*15 + 3W 签字费的口头 Offer，要求下周一前答复；或者：当前公司 base 28k，年终稳定 3 个月"
            className={`${textareaShortCls} mt-1`}
          />
          <span className="mt-1 block text-[11px] text-faint">
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
                    <span className="font-medium">突破点：</span>
                    {style.weakness}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {createError && <p className={`text-sm ${textErr}`}>{createError}</p>}

        <div className="flex items-center justify-end pt-2">
          <button
            type="button"
            onClick={handleStart}
            disabled={creating}
            className={`${btnPrimary} px-6 py-2.5 text-sm font-medium shadow-sm`}
          >
            {creating ? "正在推演 HR 初始出招与首轮解盘…" : "开局！进入薪资博弈对决"}
          </button>
        </div>
      </div>

      {/* 历史演练记录列表 */}
      <div>
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-lg font-bold text-ink">历史博弈记录</h2>
          {items && items.length > 0 && (
            <span className="font-mono text-xs text-muted">已载入 {items.length} 场演练</span>
          )}
        </div>

        {loadError && <LoadError message={`谈判历史加载失败：${loadError}`} onRetry={failedCursor === null ? reload : loadMore} />}

        {items === null && !loadError && (
          <p className="mt-4 text-xs text-muted">正在加载历史记录…</p>
        )}

        {items !== null && items.length === 0 && (
          <div className={`mt-4 p-8 text-center ${cardCls}`}>
            <p className="text-sm text-muted">暂无薪酬谈判历史记录。</p>
            <p className="mt-1 text-xs text-faint">
              在上方填写你的目标岗位与期望薪资，开启第一次拟真拉扯吧！
            </p>
          </div>
        )}

        {items !== null && items.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-card shadow-card-subtle divide-y divide-line">
            {items.map((it) => {
              const isFinished = it.status === "finished";
              return (
                <div
                  key={it.id}
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
                        {isFinished ? "已达成 / 已复盘" : "交锋进行中"}
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
                      onClick={() => handleDelete(it.id)}
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
