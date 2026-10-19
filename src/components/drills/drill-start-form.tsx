"use client";

import Link from "next/link";
import { Combobox } from "@/components/common/combobox";
import { InlineError } from "@/components/common/inline-error";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import type { DirectionStat, ProjectBrief } from "@/hooks/use-drills-page";
import { btnPrimary, inputCls, textareaCls, labelCls, textErr } from "@/lib/ui";

export type DrillMode = "project" | "bank";

export function DrillStartForm({
  mode,
  projects,
  projectsError,
  onRetryProjects,
  directions,
  directionsError,
  projectId,
  bankDirection,
  bankJd,
  count,
  starting,
  error,
  onModeChange,
  onProjectIdChange,
  onBankDirectionChange,
  onBankJdChange,
  onCountChange,
  onStart,
  onRetryDirections,
}: {
  mode: DrillMode;
  projects: ProjectBrief[] | null;
  projectsError?: string;
  onRetryProjects?: () => void;
  directions: DirectionStat[] | null;
  directionsError: string;
  projectId: number | "";
  bankDirection: string;
  bankJd: string;
  count: number;
  starting: boolean;
  error: string;
  onModeChange: (mode: DrillMode) => void;
  onProjectIdChange: (id: number) => void;
  onBankDirectionChange: (direction: string) => void;
  onBankJdChange: (jd: string) => void;
  onCountChange: (count: number) => void;
  onStart: () => void;
  onRetryDirections: () => void;
}) {
  const bankEmpty = directions !== null && directions.length === 0;
  const canStartBank = bankDirection.trim() !== "" || bankJd.trim() !== "";
  const canStart = mode === "project" ? projectId !== "" : canStartBank;

  return (
    <>
        {/* 双栏响应式开练控制台 */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* 左侧主要出题配置（占 2 栏） */}
          <div className="relative space-y-5 rounded-2xl border border-line bg-card p-6 shadow-card-subtle lg:col-span-2">
            <LoadingOverlay
              show={starting}
              message={mode === "project" ? "AI 考官正在深挖项目核心考点…" : "AI 考官正在针对目标岗位命制精练考题…"}
              description="正在梳理架构细节、技术决策与关键考核维度，请稍候…"
            />
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3.5">
              <div className="flex items-center gap-2">
                <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
                <span className="font-serif text-base font-bold text-ink">出题精练配置</span>
              </div>
              <div
                className="inline-flex rounded-xl border border-line bg-surface p-1 shadow-xs text-xs"
                role="tablist"
                aria-label="出题方式"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "project"}
                  onClick={() => onModeChange("project")}
                  className={`rounded-lg px-3.5 py-1.5 font-medium transition-all ${
                    mode === "project"
                      ? "bg-card text-ink font-bold shadow-xs"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  真实项目深挖
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "bank"}
                  onClick={() => onModeChange("bank")}
                  className={`rounded-lg px-3.5 py-1.5 font-medium transition-all ${
                    mode === "bank"
                      ? "bg-card text-ink font-bold shadow-xs"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  岗位通用题库
                </button>
              </div>
            </div>

            {mode === "project" ? (
              projects === null ? (
                projectsError ? <LoadError message={`项目列表加载失败：${projectsError}`} onRetry={onRetryProjects} /> : <Loading label="正在加载项目列表…" />
              ) : projects.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line-strong bg-surface/30 p-6 text-center text-xs text-muted">
                  还没有沉淀任何项目经历。请先前往「
                  <Link href="/knowledge" className="text-primary font-medium hover:underline">
                    技术知识库
                  </Link>
                  」创建项目并导入设计材料，即可一键深挖考题。
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <label className="block sm:col-span-2">
                      <span className={labelCls}>选择目标项目经历</span>
                      <select
                        className={`${inputCls} mt-1`}
                        value={projectId}
                        onChange={(event) => onProjectIdChange(Number(event.target.value))}
                      >
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className={labelCls}>本次生成题数</span>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        className={`${inputCls} mt-1 font-mono`}
                        value={count}
                        onChange={(event) => onCountChange(Number(event.target.value))}
                      />
                    </label>
                  </div>
                  <div className="flex items-center justify-between pt-3 border-t border-line/60">
                    <span className="text-xs text-faint">AI 将挖掘项目的架构选型、深层瓶颈与容灾死锁点</span>
                    <button
                      className={btnPrimary}
                      onClick={onStart}
                      disabled={starting || !canStart}
                    >
                      {starting ? "出题拟定中…（约需十秒）" : "开始专项精练"}
                    </button>
                  </div>
                </div>
              )
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="block sm:col-span-2">
                    <span className={labelCls}>技术方向（可留空）</span>
                    <div className="mt-1">
                      <Combobox
                        value={bankDirection}
                        onChange={onBankDirectionChange}
                        options={(directions ?? []).map((direction) => direction.direction)}
                        placeholder="选择或直接输入，如：前端 / 分布式后端"
                        ariaLabel="岗位方向"
                      />
                    </div>
                    {directionsError && (
                      <div className="mt-1">
                        <InlineError message={`方向列表加载失败：${directionsError}`} onRetry={onRetryDirections} />
                      </div>
                    )}
                  </div>
                  <label className="block">
                    <span className={labelCls}>题数</span>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      className={`${inputCls} mt-1 font-mono`}
                      value={count}
                      onChange={(event) => onCountChange(Number(event.target.value))}
                    />
                  </label>
                </div>

                <label className="block">
                  <span className={labelCls}>岗位任职要求（JD，可留空）</span>
                  <textarea
                    className={`${textareaCls} mt-1 font-sans`}
                    value={bankJd}
                    onChange={(event) => onBankJdChange(event.target.value)}
                    placeholder="粘贴岗位要求（JD），与方向至少填一项。AI 结合 JD/方向动态出题，题库作为底层考源。"
                  />
                </label>

                <div className="flex items-center justify-between pt-3 border-t border-line/60">
                  <span className="text-xs text-faint">
                    {bankEmpty ? (
                      <span>题库暂无题目，AI 将基于方向/JD 生成考题</span>
                    ) : (
                      <span>
                        题库已有 {directions?.reduce((acc, direction) => acc + direction.count, 0)} 道题沉淀作为参考
                      </span>
                    )}
                  </span>
                  <button
                    className={btnPrimary}
                    onClick={onStart}
                    disabled={starting || !canStart}
                  >
                    {starting ? "出题拟定中…" : "开始通用练习"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 右侧机制说明与攻略（占 1 栏） */}
          <div className="flex flex-col justify-between space-y-4 rounded-2xl border border-line bg-card p-6 shadow-card-subtle">
            <div className="space-y-3.5">
              <div className="flex items-center justify-between border-b border-line pb-2.5">
                <h3 className="font-serif text-sm font-bold text-ink">练习机制与技巧</h3>
                <span className="rounded bg-primary-soft px-2 py-0.5 text-[10px] font-bold text-primary">
                  四维批阅
                </span>
              </div>
              <ul className="space-y-3 text-xs leading-relaxed text-muted">
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-primary">01.</span>
                  <span><strong>即时小分批改：</strong>每作答一题，AI 即刻给出技术深度、结构表达、真实性、完整度四项得分。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-primary">02.</span>
                  <span><strong>一键移入错题：</strong>作答有盲区或解答不顺的题目，随时一键收纳进「错题本」进行二刷。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-primary">03.</span>
                  <span><strong>沉淀面试追练：</strong>模考后自动提炼的薄弱点也会生成追练套题，回到这里进行专项查缺补漏。</span>
                </li>
              </ul>
            </div>

            <div className="rounded-xl border border-primary/20 bg-primary-soft/50 p-3.5 text-xs text-primary leading-relaxed">
              💡 <strong>建议：</strong>针对真实项目中的关键指标提升（如耗时降低 50%、吞吐翻倍），提前准备具体的排查与调优故事。
            </div>
          </div>
        </div>
      {error && <p className={`mt-3 text-sm ${textErr}`}>{error}</p>}
    </>
  );
}
