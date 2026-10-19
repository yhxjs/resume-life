"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { Loading, LoadError, SectionTitle } from "@/components/common/ui-bits";
import { jsonFetch } from "@/lib/fetcher";
import type {
  ResignationGapRemedyResult,
  ScenarioType,
  PersonaStyle,
} from "@/lib/career-gap-remedy";
import {
  btnDanger,
  btnGhost,
  cardCls,
  textErr,
  wellCls,
  badgePrimary,
} from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";

type RemedyDetail = {
  id: number;
  scenario_type: ScenarioType;
  raw_story: string;
  target_role: string;
  persona_style: PersonaStyle;
  result: ResignationGapRemedyResult | null;
  created_at: string;
};

export default function CareerGapRemedyDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<RemedyDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const { copiedText, copy: copyToClipboard } = useCopyFeedback();
  const [activeScriptTab, setActiveScriptTab] = useState<"concise" | "detailed" | "pivoting">("concise");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    let cancelled = false;
    jsonFetch<RemedyDetail>(`/api/tools/career-gap-remedies/${params.id}`)
      .then((data) => {
        if (cancelled) return;
        setData(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [params.id, loadAttempt]);

  async function remove() {
    if (!data) return;
    if (
      !(await confirmDialog({
        title: "删除报告",
        message: "确定删除这份高情商重塑对策报告？",
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await jsonFetch(`/api/tools/career-gap-remedies/${data.id}`, { method: "DELETE" });
    } catch (err) {
      setActionError(errorMessage(err));
      return;
    }
    router.push("/tools/gap");
  }

  function copy(text: string) {
    void copyToClipboard(text);
  }

  if (loadError && !data) return <LoadError message={loadError} onRetry={() => { setLoadError(""); setLoadAttempt((attempt) => attempt + 1); }} />;
  if (!data) return <Loading />;

  const result = data.result;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}
      {/* 头部导航与操作栏 */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/tools/gap"
              className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
            >
              ← 返回对策库列表
            </Link>
            <span className="text-xs text-faint">/</span>
            <span className="text-xs text-muted font-mono">报告 #{data.id}</span>
          </div>
          <h1 className="mt-1 font-serif text-2xl sm:text-3xl font-bold text-ink flex items-center gap-2">
            <span>{result?.title || "离职原因与空窗期高情商重塑对策"}</span>
            <span className="rounded-full border border-primary/25 bg-primary-soft px-3 py-0.5 text-xs font-mono font-medium text-primary">
              话术对策
            </span>
          </h1>
        </div>

        <div className="flex items-center gap-3 text-xs text-faint">
          <span>{new Date(data.created_at).toLocaleString()}</span>
          <button
            type="button"
            onClick={remove}
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
        <div className={`mt-2 p-4 font-mono text-xs text-muted leading-relaxed whitespace-pre-wrap ${wellCls}`}>
          {data.raw_story}
        </div>
      </details>

      {result === null ? (
        <div className={`p-6 text-center ${cardCls}`}>
          <p className={`text-sm ${textErr}`}>数据解析异常：该报告内容无法解析，可删除后重新生成。</p>
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
              💡 高情商重塑定调
            </div>
            <p className="font-serif text-lg sm:text-xl font-bold text-ink leading-relaxed">
              “{result.punchline}”
            </p>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted border-t border-line/60 pt-3">
              <span className="inline-flex items-center gap-1">
                <span>🎯 场景归属：</span>
                <span className="font-semibold text-ink">
                  {data.scenario_type === "resignation"
                    ? "离职原因"
                    : data.scenario_type === "gap"
                    ? "职业空窗期"
                    : "离职原因与空窗期结合"}
                </span>
              </span>
              {data.target_role && (
                <span className="inline-flex items-center gap-1">
                  <span>📌 目标岗位：</span>
                  <span className="font-semibold text-ink">{data.target_role}</span>
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <span>🎭 人设风格：</span>
                <span className="font-semibold text-primary">
                  {data.persona_style === "driven"
                    ? "自驱进取型"
                    : data.persona_style === "composed"
                    ? "从容睿智型"
                    : "务实稳健型"}
                </span>
              </span>
            </div>
          </div>

          {/* HR 心理测谎仪：深剖 HR 心理 */}
          <section className="space-y-3">
            <SectionTitle>🕵️ HR 心理测谎仪：HR 到底在担心什么？</SectionTitle>
            <div className={`p-5 space-y-4 ${cardCls}`}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div className="rounded-xl border border-line bg-surface p-4 space-y-2">
                  <div className="font-semibold text-ink flex items-center gap-1.5">
                    <span>⚠️ HR 听后的潜意识隐忧</span>
                  </div>
                  <ul className="space-y-1.5">
                    {result.hrMindsetAnalysis.coreConcerns.map((c, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-muted leading-relaxed">
                        <span className="text-danger shrink-0">•</span>
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="rounded-xl border border-danger/25 bg-danger-wash p-4 space-y-2">
                  <div className="font-semibold text-danger flex items-center gap-1.5">
                    <span>⚡ 直白表达最容易踩的雷区</span>
                  </div>
                  <ul className="space-y-1.5">
                    {result.hrMindsetAnalysis.riskPoints.map((r, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-ink leading-relaxed">
                        <span className="text-danger shrink-0">✕</span>
                        <span>{r}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="rounded-xl border border-primary/20 bg-primary-soft/40 p-4 text-xs space-y-1">
                <div className="font-semibold text-primary flex items-center gap-1.5">
                  <span>🎯 HR 最想听到的加分回答特质</span>
                </div>
                <p className="text-ink leading-relaxed font-medium">
                  {result.hrMindsetAnalysis.whatHrWantsToHear}
                </p>
              </div>
            </div>
          </section>

          {/* 底层重塑四步公式 */}
          <section className="space-y-3">
            <SectionTitle>🪜 高情商破局四步拆解模型</SectionTitle>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className={`p-4 space-y-1.5 rounded-xl border border-line bg-card text-xs flex flex-col justify-between`}>
                <div className="space-y-1">
                  <div className="font-mono text-primary font-bold">STEP 01</div>
                  <div className="font-semibold text-ink">客观认同事实</div>
                  <p className="text-muted leading-relaxed pt-1">
                    {result.reframeFormula.factAcknowledgment}
                  </p>
                </div>
                <div className="text-[11px] text-faint border-t border-line/50 pt-2">不回避、不矫情</div>
              </div>

              <div className={`p-4 space-y-1.5 rounded-xl border border-line bg-card text-xs flex flex-col justify-between`}>
                <div className="space-y-1">
                  <div className="font-mono text-primary font-bold">STEP 02</div>
                  <div className="font-semibold text-ink">正向理性归因</div>
                  <p className="text-muted leading-relaxed pt-1">
                    {result.reframeFormula.positiveAttribution}
                  </p>
                </div>
                <div className="text-[11px] text-faint border-t border-line/50 pt-2">归因于战略与阶段</div>
              </div>

              <div className={`p-4 space-y-1.5 rounded-xl border border-line bg-card text-xs flex flex-col justify-between`}>
                <div className="space-y-1">
                  <div className="font-mono text-primary font-bold">STEP 03</div>
                  <div className="font-semibold text-ink">沉淀积累赋能</div>
                  <p className="text-muted leading-relaxed pt-1">
                    {result.reframeFormula.growthAndValue}
                  </p>
                </div>
                <div className="text-[11px] text-faint border-t border-line/50 pt-2">把空白变成资产</div>
              </div>

              <div className={`p-4 space-y-1.5 rounded-xl border border-line bg-card text-xs flex flex-col justify-between`}>
                <div className="space-y-1">
                  <div className="font-mono text-primary font-bold">STEP 04</div>
                  <div className="font-semibold text-ink">动机精准绑定</div>
                  <p className="text-muted leading-relaxed pt-1">
                    {result.reframeFormula.motivationAlignment}
                  </p>
                </div>
                <div className="text-[11px] text-faint border-t border-line/50 pt-2">锁死新岗位契机</div>
              </div>
            </div>
          </section>

          {/* 三套实战高情商话术方案 */}
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle>🗣️ 三套定制实战口述话术</SectionTitle>
              <div className="flex items-center gap-1 bg-surface-2 p-1 rounded-lg border border-line text-xs">
                <button
                  type="button"
                  onClick={() => setActiveScriptTab("concise")}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    activeScriptTab === "concise"
                      ? "bg-card text-primary font-semibold shadow-xs"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  ⚡ 30 秒精炼版
                </button>
                <button
                  type="button"
                  onClick={() => setActiveScriptTab("detailed")}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    activeScriptTab === "detailed"
                      ? "bg-card text-primary font-semibold shadow-xs"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  📖 1 分钟深度版
                </button>
                <button
                  type="button"
                  onClick={() => setActiveScriptTab("pivoting")}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    activeScriptTab === "pivoting"
                      ? "bg-card text-primary font-semibold shadow-xs"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  🎯 攻守兼备导流版
                </button>
              </div>
            </div>

            {/* 当前选中话术卡片 */}
            {(() => {
              const cur = result.scripts[activeScriptTab];
              return (
                <div className={`p-6 space-y-4 border-2 border-primary/40 ${cardCls}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 pb-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-serif text-base font-bold text-ink">{cur.label}</span>
                        <span className={badgePrimary}>可直接背诵口述</span>
                      </div>
                      <p className="text-xs text-muted">{cur.applicableScene}</p>
                    </div>

                    <button
                      type="button"
                      onClick={() => copy(cur.script)}
                      className="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-medium hover:bg-primary/90 transition-colors flex items-center gap-1.5"
                    >
                      <span>{copiedText === cur.script ? "✓ 已复制整段话术" : "📋 一键复制此话术"}</span>
                    </button>
                  </div>

                  {/* 话术主体文本框 */}
                  <div className="rounded-xl border border-line bg-surface p-4 sm:p-5 text-sm sm:text-base text-ink leading-relaxed font-sans shadow-inner whitespace-pre-wrap">
                    “{cur.script}”
                  </div>

                  {/* 核心拆解要点 */}
                  {cur.keyPoints.length > 0 && (
                    <div className="space-y-2 pt-2">
                      <div className="text-xs font-semibold text-ink flex items-center gap-1">
                        <span>✨ 为什么这段话术能让 HR 听着舒适？</span>
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

          {/* HR 连环追问与刁钻拆解 */}
          {result.drills.length > 0 && (
            <section className="space-y-3">
              <SectionTitle>🥊 HR 刁钻连环追杀问答预演</SectionTitle>
              <div className="space-y-3">
                {result.drills.map((drill, idx) => (
                  <div key={idx} className={`p-4 sm:p-5 space-y-3 ${cardCls}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-2.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold bg-danger/15 text-danger px-2 py-0.5 rounded">
                          追问 #{idx + 1}
                        </span>
                        <span className="font-semibold text-sm text-ink">{drill.question}</span>
                      </div>
                      <span className="text-[11px] text-faint">背后的心理：{drill.hrConcern}</span>
                    </div>

                    <div className="rounded-lg border border-primary/20 bg-primary-soft/30 p-3 text-xs space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-primary">💡 满分拆解与示范应对：</span>
                        <button
                          type="button"
                          onClick={() => copy(drill.bestResponse)}
                          className="text-primary hover:underline font-medium"
                        >
                          {copiedText === drill.bestResponse ? "已复制 ✓" : "复制"}
                        </button>
                      </div>
                      <p className="text-ink leading-relaxed font-sans">{drill.bestResponse}</p>
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
                <span>🚫 绝对禁忌红线（打死不能说漏嘴）</span>
              </div>
              <ul className="space-y-2 text-xs">
                {result.forbiddenList.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-ink">
                    <span className="text-danger shrink-0 font-bold">✕</span>
                    <span className="leading-relaxed">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* 临场小建议 */}
            <div className={`p-5 space-y-3 border-l-4 border-primary ${cardCls}`}>
              <div className="font-semibold text-primary text-sm flex items-center gap-1.5">
                <span>🎯 面试现场仪态与心理暗示</span>
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
          <div className="flex items-center justify-between pt-4 border-t border-line">
            <Link href="/tools/gap" className={btnGhost}>
              ← 返回对策库列表
            </Link>
            <button type="button" onClick={remove} className={btnDanger}>
              删除本份报告
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
