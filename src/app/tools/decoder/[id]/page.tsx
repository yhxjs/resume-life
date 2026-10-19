"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { Loading, LoadError, SectionTitle } from "@/components/common/ui-bits";
import { jsonFetch } from "@/lib/fetcher";
import type { JargonDecoderResult, DecodedItem } from "@/lib/jargon-decoder";
import {
  btnDanger,
  btnGhost,
  cardCls,
  textErr,
  wellCls,
  badgePrimary,
  badgeAccent,
  badgeDanger,
} from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";

type DecodingDetail = {
  id: number;
  source_text: string;
  result: JargonDecoderResult | null;
  created_at: string;
};

function RiskLevelBadge({ level }: { level: DecodedItem["riskLevel"] }) {
  if (level === null) {
    return <span className="text-xs text-muted">风险未评估</span>;
  }
  if (level === "high") {
    return <span className={badgeDanger}>⚠️ 高危陷阱</span>;
  }
  if (level === "medium") {
    return <span className={badgeAccent}>⚡ 中度警惕</span>;
  }
  return <span className={badgePrimary}>✓ 轻微关注</span>;
}

function RiskMeter({ label, value, note }: { label: string; value: number | null; note: string }) {
  const color =
    value === null
      ? "bg-line"
      : value >= 8
      ? "bg-danger"
      : value >= 5
      ? "bg-accent"
      : "bg-primary";

  return (
    <div className="space-y-1.5 rounded-lg border border-line bg-surface/50 p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-ink">{label}</span>
        <span className="font-mono font-bold text-ink">{value === null ? "未评估" : `${value} / 10`}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-line/60">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${Math.min(100, (value ?? 0) * 10)}%` }}
        />
      </div>
      <p className="text-[11px] text-faint leading-tight">{value === null ? "模型未提供有效评分" : note}</p>
    </div>
  );
}

export default function JargonDecoderDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<DecodingDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const { copiedText, copy } = useCopyFeedback();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    let cancelled = false;
    jsonFetch<DecodingDetail>(`/api/tools/jargon-decodings/${params.id}`)
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
        title: "删除记录",
        message: "确定删除这份暗号解码报告？",
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await jsonFetch(`/api/tools/jargon-decodings/${data.id}`, { method: "DELETE" });
    } catch (err) {
      setActionError(errorMessage(err));
      return;
    }
    router.push("/tools/decoder");
  }

  function copyQuestion(text: string) {
    void copy(text);
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
              href="/tools/decoder"
              className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
            >
              ← 返回解码器列表
            </Link>
            <span className="text-xs text-faint">/</span>
            <span className="text-xs text-muted font-mono">报告 #{data.id}</span>
          </div>
          <h1 className="mt-1 font-serif text-2xl sm:text-3xl font-bold text-ink flex items-center gap-2">
            <span>{result?.targetSummary || "面试黑话与暗号解码报告"}</span>
            <span className="rounded-full border border-primary/25 bg-primary-soft px-3 py-0.5 text-xs font-mono font-medium text-primary">
              暗号穿透
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

      {/* 原始输入折叠展开 */}
      <details className="group">
        <summary className="cursor-pointer text-xs text-muted transition-colors hover:text-ink flex items-center gap-1">
          <span className="group-open:rotate-90 transition-transform text-faint">▶</span>
          <span>查看原始 JD / 输入文本</span>
        </summary>
        <div className={`mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-muted ${wellCls}`}>
          {data.source_text}
        </div>
      </details>

      {result === null ? (
        <div className={`p-6 text-center ${cardCls}`}>
          <p className={`text-sm ${textErr}`}>数据解析异常：该报告内容无法解析，可删除后重新生成。</p>
          <div className="mt-4">
            <Link href="/tools/decoder" className={btnGhost}>
              返回重试
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {/* 综合神总结与风险看板 */}
          <div className={`p-5 sm:p-6 space-y-5 border-l-4 border-primary ${cardCls}`}>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-line/70 pb-4">
              <div className="space-y-1">
                <div className="text-xs font-semibold text-primary uppercase tracking-wider">
                  🔥 穿透神总结
                </div>
                <p className="font-serif text-lg sm:text-xl font-bold text-ink leading-relaxed">
                  “{result.punchline}”
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-3 bg-surface rounded-xl border border-line p-3">
                <div className="text-right">
                  <div className="text-[11px] text-faint">综合踩坑指数</div>
                  <div className="text-xs font-medium text-muted">
                    {result.overallRiskScore === null
                      ? "未评估"
                      : result.overallRiskScore >= 75
                      ? "高危避坑"
                      : result.overallRiskScore >= 50
                      ? "留个心眼"
                      : "相对稳健"}
                  </div>
                </div>
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-lg font-mono text-xl font-extrabold ${
                    result.overallRiskScore === null
                      ? "bg-line text-muted"
                      : result.overallRiskScore >= 75
                      ? "bg-danger text-on-danger"
                      : result.overallRiskScore >= 50
                      ? "bg-accent text-bg"
                      : "bg-primary text-on-primary"
                  }`}
                >
                  {result.overallRiskScore ?? "—"}
                </div>
              </div>
            </div>

            {/* 4 维度风险小仪表 */}
            <div>
              <div className="text-xs font-medium text-muted mb-2.5">
                📊 团队生态四大风险维度评估
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <RiskMeter
                  label="加班过劳指数"
                  value={result.riskRatings.overtime}
                  note={
                    result.riskRatings.overtime === null
                      ? "模型未提供有效评分"
                      : result.riskRatings.overtime >= 8
                      ? "大概率无偿高频加班"
                      : result.riskRatings.overtime >= 5
                      ? "阶段性攻坚与排期紧张"
                      : "工作节奏相对规律"
                  }
                />
                <RiskMeter
                  label="业务动荡指数"
                  value={result.riskRatings.stability}
                  note={
                    result.riskRatings.stability === null
                      ? "模型未提供有效评分"
                      : result.riskRatings.stability >= 8
                      ? "战略朝令夕改，沉淀难留"
                      : result.riskRatings.stability >= 5
                      ? "探索性业务，方向多变"
                      : "主营业务稳固，产出明确"
                  }
                />
                <RiskMeter
                  label="资源匮乏指数"
                  value={result.riskRatings.resources}
                  note={
                    result.riskRatings.resources === null
                      ? "模型未提供有效评分"
                      : result.riskRatings.resources >= 8
                      ? "一人成军，基建全靠自己填"
                      : result.riskRatings.resources >= 5
                      ? "基建与协作资源稍显吃紧"
                      : "资源与支撑体系较健全"
                  }
                />
                <RiskMeter
                  label="管理内耗指数"
                  value={result.riskRatings.management}
                  note={
                    result.riskRatings.management === null
                      ? "模型未提供有效评分"
                      : result.riskRatings.management >= 8
                      ? "权责不清，甩锅与微操风险高"
                      : result.riskRatings.management >= 5
                      ? "协作链路略长，需主动对齐"
                      : "机制相对清晰扁平"
                  }
                />
              </div>
            </div>
          </div>

          {/* 公司与团队风格诊断 */}
          <section className="space-y-3">
            <SectionTitle>🏢 团队风格与日常生态画像</SectionTitle>
            <div className={`p-5 space-y-3.5 ${cardCls}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-ink">风格定调：</span>
                <span className="text-sm font-medium text-primary bg-primary-soft border border-primary/20 rounded-md px-2.5 py-0.5">
                  {result.companyProfile.teamStyle}
                </span>
              </div>

              {result.companyProfile.riskFlags.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-xs text-muted">隐患标签：</span>
                  {result.companyProfile.riskFlags.map((flag, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-xs text-ink"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                      {flag}
                    </span>
                  ))}
                </div>
              )}

              <p className="text-xs text-muted leading-relaxed border-t border-line/60 pt-3">
                {result.companyProfile.cultureSummary}
              </p>
            </div>
          </section>

          {/* 暗号逐条深度穿透 */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <SectionTitle>🕵️ 暗号深度拆解与面试通关攻略</SectionTitle>
              <span className="text-xs text-faint">
                识别出 {result.items.length} 个核心潜台词
              </span>
            </div>

            <div className="space-y-4">
              {result.items.map((item, idx) => (
                <div
                  key={idx}
                  className={`p-5 space-y-4 transition-all hover:shadow-card-float ${cardCls}`}
                >
                  {/* 条目标题与分类标签 */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 pb-3">
                    <div className="flex items-center gap-2.5">
                      <span className="font-serif text-base font-bold text-ink">
                        #{idx + 1} {item.keyword}
                      </span>
                      <span className="text-xs text-muted">[{item.riskCategory}]</span>
                    </div>
                    <RiskLevelBadge level={item.riskLevel} />
                  </div>

                  {/* 表面说辞 vs 真实潜台词对照 */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div className="rounded-lg border border-line bg-surface/70 p-3 space-y-1">
                      <div className="font-semibold text-muted flex items-center gap-1.5">
                        <span>📢 官方包装说辞</span>
                      </div>
                      <p className="text-ink leading-relaxed">{item.surfaceMeaning}</p>
                    </div>

                    <div className="rounded-lg border border-danger/25 bg-danger-wash p-3 space-y-1">
                      <div className="font-semibold text-danger flex items-center gap-1.5">
                        <span>💡 真实潜台词（大实话）</span>
                      </div>
                      <p className="text-ink font-medium leading-relaxed">
                        {item.hiddenMeaning}
                      </p>
                    </div>
                  </div>

                  {/* 踩坑场景警示 */}
                  {item.warning && (
                    <div className="text-xs bg-surface-2 rounded-lg p-3 text-muted flex items-start gap-2 border border-line/60">
                      <span className="text-accent shrink-0">⚠️ 真实踩坑预警：</span>
                      <span className="leading-relaxed">{item.warning}</span>
                    </div>
                  )}

                  {/* 面试应对潜规则 */}
                  <div className="rounded-lg border border-line bg-card p-3.5 space-y-1.5 text-xs">
                    <div className="font-semibold text-ink flex items-center gap-1.5">
                      <span>🛡️ 面试高分应对潜规则</span>
                      <span className="text-faint font-normal">
                        （被问及相关话题时的体面接招策略）
                      </span>
                    </div>
                    <p className="text-muted leading-relaxed font-sans">
                      {item.interviewRule}
                    </p>
                  </div>

                  {/* 反客为主的反向提问 */}
                  {item.counterQuestions.length > 0 && (
                    <div className="rounded-lg border border-primary/20 bg-primary-soft/40 p-3.5 space-y-2 text-xs">
                      <div className="font-semibold text-primary flex items-center gap-1.5">
                        <span>🗡️ 反客为主·刺探提问暗器</span>
                        <span className="text-faint font-normal">
                          （面试反问环节悄悄探底）
                        </span>
                      </div>
                      <ul className="space-y-1.5">
                        {item.counterQuestions.map((q, qIdx) => (
                          <li
                            key={qIdx}
                            className="flex items-start justify-between gap-3 text-ink bg-card/80 border border-line/60 rounded p-2"
                          >
                            <span className="leading-relaxed">👉 {q}</span>
                            <button
                              type="button"
                              onClick={() => copyQuestion(q)}
                              className="shrink-0 text-primary hover:underline font-medium"
                            >
                              {copiedText === q ? "已复制 ✓" : "复制"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* 王牌反向提问避坑锦囊（汇总精选） */}
          {result.goldenQuestions.length > 0 && (
            <section className="space-y-3">
              <SectionTitle>👑 面试反问终局·王牌避坑照妖镜提问</SectionTitle>
              <div className={`p-5 space-y-3 border-2 border-primary/40 ${cardCls}`}>
                <p className="text-xs text-muted leading-relaxed">
                  在面试尾声面试官问“你还有什么想问我的吗？”时，挑出 1-2
                  个提问。既彰显专业成熟度，又能让面试官在不经意间暴露真实团队状况：
                </p>

                <div className="space-y-2.5 pt-1">
                  {result.goldenQuestions.map((gq, i) => (
                    <div
                      key={i}
                      className="flex items-start justify-between gap-3 rounded-lg border border-line bg-surface p-3 text-xs text-ink transition-colors hover:border-primary/50"
                    >
                      <div className="flex items-start gap-2 leading-relaxed">
                        <span className="font-mono font-bold text-primary shrink-0">
                          Q{i + 1}.
                        </span>
                        <span>{gq}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyQuestion(gq)}
                        className="shrink-0 text-primary hover:underline font-medium whitespace-nowrap"
                      >
                        {copiedText === gq ? "已复制 ✓" : "复制提问"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* 底部按钮栏 */}
          <div className="flex items-center justify-between pt-4 border-t border-line">
            <Link href="/tools/decoder" className={btnGhost}>
              ← 返回解码器首页
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
