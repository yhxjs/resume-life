"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { Loading, LoadError, SectionTitle } from "@/components/common/ui-bits";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { readCareerGapRemedyDetail, type CareerGapRemedyDetail } from "@/lib/career-gap-remedy-detail";
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  cardCls,
  textErr,
  wellCls,
  badgePrimary,
} from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";

const SCRIPT_TABS = ["concise", "detailed", "pivoting"] as const;
type ScriptTab = (typeof SCRIPT_TABS)[number];
type DeletionCommand = { controller: AbortController; checking: boolean; completed: boolean };

export default function CareerGapRemedyDetailPage() {
  const params = useParams<{ id: string }>();
  return <RemedyDetail key={params.id} remedyId={params.id} />;
}

function RemedyDetail({ remedyId }: { remedyId: string }) {
  const router = useRouter();
  const [data, setData] = useState<CareerGapRemedyDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const { copiedText, copy, copyError, copying } = useCopyFeedback();
  const [selectedScript, setSelectedScript] = useState<{ reportId: number; tab: ScriptTab } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [actionError, setActionError] = useState("");
  const [phase, setPhase] = useState<"idle" | "confirming" | "deleting" | "checking" | "unknown" | "deleted">("idle");
  const active = useRef(false);
  const command = useRef<DeletionCommand | null>(null);

  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; command.current?.controller.abort(); command.current = null; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    jsonFetch<unknown>(`/api/tools/career-gap-remedies/${remedyId}`, { signal: controller.signal, cache: "no-store" })
      .then((value) => {
        if (cancelled) return;
        setData(readCareerGapRemedyDetail(value, Number(remedyId)));
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [remedyId, loadAttempt]);

  function isCurrent(current: DeletionCommand) {
    return active.current && command.current === current && !current.controller.signal.aborted && !current.completed;
  }

  function deleted(current: DeletionCommand) {
    if (!isCurrent(current)) return;
    current.completed = true;
    setPhase("deleted");
    router.push("/tools/gap");
  }

  async function checkDeletion(current: DeletionCommand, cause: string) {
    if (!isCurrent(current) || current.checking) return;
    current.checking = true;
    setPhase("checking"); setActionError("");
    try {
      const value = await jsonFetch<unknown>(`/api/tools/career-gap-remedies/${remedyId}`, { signal: current.controller.signal, cache: "no-store" });
      if (!isCurrent(current)) return;
      setData(readCareerGapRemedyDetail(value, Number(remedyId)));
      setActionError(`${cause}；已重新读取，记录目前仍存在，请核对后再决定是否删除。`);
      command.current = null; setPhase("idle");
    } catch (reason) {
      if (!isCurrent(current)) return;
      if (reason instanceof HttpError && reason.status === 404) { deleted(current); return; }
      setActionError(`删除结果尚未确认：${errorMessage(reason)}。请先重新读取删除状态。`);
      setPhase("unknown");
    } finally { current.checking = false; }
  }

  async function remove() {
    if (!data || !active.current || command.current) return;
    const current: DeletionCommand = { controller: new AbortController(), checking: false, completed: false };
    command.current = current; setPhase("confirming"); setActionError("");
    const confirmed = await confirmDialog({ title: "删除报告", message: `空窗沟通报告 #${data.id}「${data.result?.title || "离职与空窗经历沟通方案"}」，保存于 ${data.created_at}。将删除本份原始经历及沟通报告（含话术、追问参考与建议），其他报告保留。确定删除？`, danger: true, signal: current.controller.signal });
    if (!isCurrent(current)) return;
    if (!confirmed) { command.current = null; setPhase("idle"); return; }
    setPhase("deleting");
    try {
      const result = await jsonFetch<{ ok?: unknown }>(`/api/tools/career-gap-remedies/${remedyId}`, { method: "DELETE", signal: current.controller.signal });
      if (!isCurrent(current)) return;
      if (!result || result.ok !== true) throw new Error("删除响应不完整");
    } catch (err) {
      if (!isCurrent(current)) return;
      if (err instanceof HttpError && err.status === 404) deleted(current);
      else if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408) {
        setActionError(errorMessage(err)); command.current = null; setPhase("idle");
      } else await checkDeletion(current, errorMessage(err));
      return;
    }
    deleted(current);
  }

  if (loadError && !data) return <LoadError message={loadError} onRetry={() => { setLoadError(""); setLoadAttempt((attempt) => attempt + 1); }} />;
  if (!data) return <Loading />;

  const result = data.result;
  const availableScriptTabs = result ? SCRIPT_TABS.filter((tab) => result.scripts[tab].script.trim()) : [];
  const activeScriptTab = selectedScript?.reportId === data.id
    ? selectedScript.tab
    : availableScriptTabs[0] ?? "concise";

  return (
    <div className="mx-auto min-w-0 max-w-5xl space-y-8 [overflow-wrap:anywhere]">
      {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}
      {phase === "unknown" && <button type="button" className={btnPrimary} onClick={() => { const current = command.current; if (current) void checkDeletion(current, "上次删除响应异常"); }}>重新读取删除状态</button>}
      {(phase === "checking" || phase === "deleting" || phase === "deleted") && <p role="status" className="text-sm text-muted">{phase === "checking" ? "正在核对删除状态…" : phase === "deleted" ? "记录已不存在，正在返回列表…" : "正在删除报告…"}</p>}
      {/* 头部导航与操作栏 */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link
              href="/tools/gap"
              className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
            >
              ← 返回沟通准备
            </Link>
            <span className="text-xs text-faint">/</span>
            <span className="text-xs text-muted font-mono">报告 #{data.id}</span>
          </div>
          <h1 className="mt-1 font-serif text-2xl sm:text-3xl font-bold text-ink flex flex-wrap items-center gap-2">
            <span>{result?.title || "离职与空窗经历沟通方案"}</span>
            <span className="rounded-full border border-primary/25 bg-primary-soft px-3 py-0.5 text-xs font-mono font-medium text-primary">
              沟通参考
            </span>
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-faint">
          <span>{new Date(data.created_at).toLocaleString()}</span>
          <button
            type="button"
            onClick={remove}
            disabled={phase !== "idle" && phase !== "confirming"}
            className="text-danger hover:underline ml-2"
          >
            删除报告
          </button>
        </div>
      </div>

      {/* 原始经历回顾 */}
      <details className="group">
        <summary className="cursor-pointer text-xs text-muted transition-colors hover:text-ink flex items-center gap-1">
          <span className="group-open:rotate-90 transition-transform text-faint">▶</span>
          <span>查看您输入的原始经历与痛点</span>
        </summary>
        <div role="region" aria-label="原始经历" className={`mt-2 p-4 font-mono text-xs text-muted leading-relaxed whitespace-pre-wrap ${wellCls}`}>
          {data.raw_story}
        </div>
      </details>

      {result === null ? (
        <div className={`p-6 text-center ${cardCls}`}>
          <p className={`text-sm ${textErr}`}>数据解析异常：该报告内容无法解析。原始经历与记录已保留，可返回方案页重新生成。</p>
          <div className="mt-4">
            <Link href="/tools/gap" className={btnGhost}>
              返回重试
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {/* 核心金句与定调看板 */}
          <div className={`p-5 sm:p-6 space-y-4 border-l-4 border-primary ${cardCls}`}>
            <div className="text-xs font-semibold text-primary uppercase tracking-wider">
              💡 本次表达思路
            </div>
            <p className="font-serif text-lg sm:text-xl font-bold text-ink leading-relaxed">
              “{result.punchline}”
            </p>
            <p className="text-xs text-muted leading-relaxed">
              以下是基于已提供材料的练习参考。使用前请核对事实，填写或删除“待补充”部分，保留尚未确认的条件；无需披露与岗位安排无关的健康或家庭细节。
            </p>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted border-t border-line/60 pt-3">
              <span className="inline-flex min-w-0 max-w-full items-start gap-1">
                <span className="shrink-0">🎯 场景归属：</span>
                <span className="min-w-0 font-semibold text-ink">
                  {data.scenario_type === "resignation"
                    ? "离职原因"
                    : data.scenario_type === "gap"
                    ? "职业空窗期"
                    : data.scenario_type === "both" ? "离职原因与空窗期结合" : data.scenario_type || "未记录"}
                </span>
              </span>
              {data.target_role && (
                <span className="inline-flex min-w-0 max-w-full items-start gap-1">
                  <span className="shrink-0">📌 目标岗位：</span>
                  <span className="min-w-0 font-semibold text-ink">{data.target_role}</span>
                </span>
              )}
              <span className="inline-flex min-w-0 max-w-full items-start gap-1">
                <span className="shrink-0">🎭 表达风格：</span>
                <span className="min-w-0 font-semibold text-primary">
                  {data.persona_style === "driven"
                    ? "自驱进取型"
                    : data.persona_style === "composed"
                    ? "从容睿智型"
                    : data.persona_style === "pragmatic" ? "务实稳健型" : data.persona_style || "未记录"}
                </span>
              </span>
            </div>
          </div>

          {/* 材料支持的可能关注点与表达条件 */}
          <section className="space-y-3">
            <SectionTitle>招聘方可能核实的信息</SectionTitle>
            <div className={`p-5 space-y-4 ${cardCls}`}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div className="rounded-xl border border-line bg-surface p-4 space-y-2">
                  <div className="font-semibold text-ink flex items-center gap-1.5">
                    <span>可能关注的具体问题</span>
                  </div>
                  <ul className="space-y-1.5">
                    {result.hrMindsetAnalysis.coreConcerns.map((c, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-muted leading-relaxed">
                        <span className="text-danger shrink-0">•</span>
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                  {result.hrMindsetAnalysis.coreConcerns.length === 0 && (
                    <p className="text-muted leading-relaxed">当前材料未支持明确关注点，不代表已经确认招聘方没有疑问。</p>
                  )}
                </div>

                <div className={`rounded-xl border p-4 space-y-2 ${result.hrMindsetAnalysis.riskPoints.length > 0 ? "border-danger/25 bg-danger-wash" : "border-line bg-surface"}`}>
                  <div className={`font-semibold flex items-center gap-1.5 ${result.hrMindsetAnalysis.riskPoints.length > 0 ? "text-danger" : "text-ink"}`}>
                    <span>需要澄清的表达与条件</span>
                  </div>
                  <ul className="space-y-1.5">
                    {result.hrMindsetAnalysis.riskPoints.map((r, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-ink leading-relaxed">
                        <span className="text-danger shrink-0">✕</span>
                        <span>{r}</span>
                      </li>
                    ))}
                  </ul>
                  {result.hrMindsetAnalysis.riskPoints.length === 0 && (
                    <p className="text-muted leading-relaxed">本次未识别具体表述风险，仍需核对事实与未确认事项。</p>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-primary/20 bg-primary-soft/40 p-4 text-xs space-y-1">
                <div className="font-semibold text-primary flex items-center gap-1.5">
                  <span>沟通依据与待补充信息</span>
                </div>
                <p className="text-ink leading-relaxed font-medium">
                  {result.hrMindsetAnalysis.whatHrWantsToHear}
                </p>
              </div>
            </div>
          </section>

          {/* 经历说明的四个要点 */}
          <section className="space-y-3">
            <SectionTitle>经历说明的四个要点</SectionTitle>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className={`p-4 space-y-1.5 rounded-xl border border-line bg-card text-xs flex flex-col justify-between`}>
                <div className="space-y-1">
                  <div className="font-mono text-primary font-bold">STEP 01</div>
                  <div className="font-semibold text-ink">说明事实</div>
                  <p className="text-muted leading-relaxed pt-1">
                    {result.reframeFormula.factAcknowledgment}
                  </p>
                </div>
                <div className="text-[11px] text-faint border-t border-line/50 pt-2">保留实际时间、范围与条件</div>
              </div>

              <div className={`p-4 space-y-1.5 rounded-xl border border-line bg-card text-xs flex flex-col justify-between`}>
                <div className="space-y-1">
                  <div className="font-mono text-primary font-bold">STEP 02</div>
                  <div className="font-semibold text-ink">客观解释</div>
                  <p className="text-muted leading-relaxed pt-1">
                    {result.reframeFormula.positiveAttribution}
                  </p>
                </div>
                <div className="text-[11px] text-faint border-t border-line/50 pt-2">只解释已经提供的原因</div>
              </div>

              <div className={`p-4 space-y-1.5 rounded-xl border border-line bg-card text-xs flex flex-col justify-between`}>
                <div className="space-y-1">
                  <div className="font-mono text-primary font-bold">STEP 03</div>
                  <div className="font-semibold text-ink">已知行动</div>
                  <p className="text-muted leading-relaxed pt-1">
                    {result.reframeFormula.growthAndValue}
                  </p>
                </div>
                <div className="text-[11px] text-faint border-t border-line/50 pt-2">未提供行动时保留未知</div>
              </div>

              <div className={`p-4 space-y-1.5 rounded-xl border border-line bg-card text-xs flex flex-col justify-between`}>
                <div className="space-y-1">
                  <div className="font-mono text-primary font-bold">STEP 04</div>
                  <div className="font-semibold text-ink">岗位衔接</div>
                  <p className="text-muted leading-relaxed pt-1">
                    {result.reframeFormula.motivationAlignment}
                  </p>
                </div>
                <div className="text-[11px] text-faint border-t border-line/50 pt-2">核对真实目标与岗位安排</div>
              </div>
            </div>
          </section>

          {/* 三套沟通表达参考 */}
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle>🗣️ 三套定制实战口述话术</SectionTitle>
              <div role="group" aria-label="话术版本" className="flex flex-wrap items-center gap-1 bg-surface-2 p-1 rounded-lg border border-line text-xs">
                <button
                  type="button"
                  onClick={() => setSelectedScript({ reportId: data.id, tab: "concise" })}
                  aria-pressed={activeScriptTab === "concise"}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    activeScriptTab === "concise"
                      ? "bg-card text-primary font-semibold shadow-xs"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  精炼说明版
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedScript({ reportId: data.id, tab: "detailed" })}
                  aria-pressed={activeScriptTab === "detailed"}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    activeScriptTab === "detailed"
                      ? "bg-card text-primary font-semibold shadow-xs"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  详细说明版
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedScript({ reportId: data.id, tab: "pivoting" })}
                  aria-pressed={activeScriptTab === "pivoting"}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    activeScriptTab === "pivoting"
                      ? "bg-card text-primary font-semibold shadow-xs"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  岗位衔接版
                </button>
              </div>
            </div>

            {availableScriptTabs.length < SCRIPT_TABS.length && (
              <p className="text-xs text-muted">这份历史报告仅保存了部分版本的话术正文；空白版本不会自动补写。</p>
            )}

            {/* 当前选中话术卡片 */}
            {(() => {
              const cur = result.scripts[activeScriptTab];
              const hasScript = cur.script.trim().length > 0;
              return (
                <div className={`p-6 space-y-4 border-2 border-primary/40 ${cardCls}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 pb-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-serif text-base font-bold text-ink">{cur.label}</span>
                        <span className={badgePrimary}>核对后练习表达</span>
                      </div>
                      <p className="text-xs text-muted">{cur.applicableScene}</p>
                    </div>

                    <button
                      type="button"
                      onClick={() => copy(cur.script)}
                      disabled={!hasScript || copying}
                      className="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-medium hover:bg-primary/90 transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span>{!copyError && copiedText === cur.script ? "✓ 已复制整段话术" : "📋 一键复制此话术"}</span>
                    </button>
                  </div>

                  {copyError?.text === cur.script && <p role="alert" className="text-xs text-danger">{copyError.message}</p>}

                  {/* 话术主体文本框 */}
                  <div role="region" aria-label="当前话术原文" className="rounded-xl border border-line bg-surface p-4 sm:p-5 text-sm sm:text-base text-ink leading-relaxed font-sans shadow-inner whitespace-pre-wrap">
                    {hasScript ? `“${cur.script}”` : "此版本未保存话术正文，请切换到已有内容的版本；原始经历仍可核对。"}
                  </div>

                  {/* 核心拆解要点 */}
                  {cur.keyPoints.length > 0 && (
                    <div className="space-y-2 pt-2">
                      <div className="text-xs font-semibold text-ink flex items-center gap-1">
                        <span>表达要点与事实限定</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                        {cur.keyPoints.map((kp, idx) => (
                          <div
                            key={idx}
                            className="rounded-lg border border-line/60 bg-card p-2.5 text-muted flex items-start gap-2"
                          >
                            <span className="text-primary font-bold shrink-0">✓</span>
                            <span>{kp}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </section>

          {/* 可能的招聘追问与回答参考 */}
          {result.drills.length > 0 && (
            <section className="space-y-3">
              <SectionTitle>可能的追问与回答练习</SectionTitle>
              <div className="space-y-3">
                {result.drills.map((drill, idx) => (
                  <div key={idx} className={`p-4 sm:p-5 space-y-3 ${cardCls}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-bold bg-danger/15 text-danger px-2 py-0.5 rounded">
                          追问 #{idx + 1}
                        </span>
                        <span className="font-semibold text-sm text-ink">{drill.question}</span>
                      </div>
                      <span className="text-[11px] text-faint">可能核实的信息：{drill.hrConcern}</span>
                    </div>

                    <div className="rounded-lg border border-primary/20 bg-primary-soft/30 p-3 text-xs space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-primary">回答参考（需核对事实）：</span>
                        <button
                          type="button"
                          onClick={() => { if (drill.bestResponse.trim()) void copy(drill.bestResponse); }}
                          disabled={copying || !drill.bestResponse.trim()}
                          className="text-primary hover:underline font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {!copyError && copiedText === drill.bestResponse ? "已复制 ✓" : "复制"}
                        </button>
                      </div>
                      {copyError?.text === drill.bestResponse && <p role="alert" className="text-danger">{copyError.message}</p>}
                      <p className="text-ink leading-relaxed font-sans whitespace-pre-wrap">{drill.bestResponse.trim() ? drill.bestResponse : "此追问未保存回答参考，请核对原始经历后自行补充。"}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 禁忌红线与临场小贴士 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 禁忌红线 */}
            <div className={`p-5 space-y-3 border-l-4 border-danger ${cardCls}`}>
              <div className="font-semibold text-danger text-sm flex items-center gap-1.5">
                <span>表达注意：避免失实与无依据承诺</span>
              </div>
              <ul className="space-y-2 text-xs">
                {result.forbiddenList.length > 0 ? result.forbiddenList.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-ink">
                    <span className="text-danger shrink-0 font-bold">✕</span>
                    <span className="leading-relaxed">{item}</span>
                  </li>
                )) : <li className="text-muted">本次输出未列出需特别避免的表达。</li>}
              </ul>
            </div>

            {/* 临场小建议 */}
            <div className={`p-5 space-y-3 border-l-4 border-primary ${cardCls}`}>
              <div className="font-semibold text-primary text-sm flex items-center gap-1.5">
                <span>沟通与核实建议</span>
              </div>
              <ul className="space-y-2 text-xs">
                {result.closingTips.map((tip, i) => (
                  <li key={i} className="flex items-start gap-2 text-ink">
                    <span className="text-primary shrink-0 font-bold">✓</span>
                    <span className="leading-relaxed">{tip}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* 底部导航 */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-line">
            <Link href="/tools/gap" className={btnGhost}>
              ← 返回沟通准备
            </Link>
            <button type="button" onClick={remove} disabled={phase !== "idle" && phase !== "confirming"} className={btnDanger}>
              删除本份报告
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
