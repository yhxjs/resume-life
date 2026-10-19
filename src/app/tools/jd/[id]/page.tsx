"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PreparationReturnLink } from "@/components/application/preparation-return-link";
import { useParams, useRouter } from "next/navigation";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { Loading, LoadError, SectionTitle } from "@/components/common/ui-bits";
import { jsonFetch } from "@/lib/fetcher";
import type { JdPortraitResult } from "@/lib/jd-portrait";
import { btnDanger, btnPrimary, textErr } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";

type PortraitData = {
  id: number;
  jd: string;
  result: JdPortraitResult | null;
  created_at: string;
};

/** 必考技能雷达：N 轴（3-8），轴为考点、取值为必考程度（画法沿用复盘页的雷达） */
function SkillRadar({ skills }: { skills: { name: string; weight: number }[] }) {
  const W = 360;
  const H = 320;
  const cx = W / 2;
  const cy = 160;
  const R = 100;
  const n = skills.length;
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i: number, v: number): [number, number] => [
    cx + (Math.cos(angle(i)) * R * v) / 10,
    cy + (Math.sin(angle(i)) * R * v) / 10,
  ];
  const ring = (v: number) => skills.map((_, i) => pt(i, v).join(",")).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[360px]" role="img" aria-label="必考技能雷达图">
      {[2.5, 5, 7.5].map((v) => (
        <polygon key={v} points={ring(v)} fill="none" stroke="var(--line)" strokeWidth={1} />
      ))}
      <polygon points={ring(10)} fill="none" stroke="var(--line-strong)" strokeWidth={1} />
      {skills.map((_, i) => {
        const [sx, sy] = pt(i, 10);
        return <line key={i} x1={cx} y1={cy} x2={sx} y2={sy} stroke="var(--line)" strokeWidth={1} />;
      })}
      <text x={cx + 4} y={cy - R / 2 - 2} fontSize={9} fill="var(--faint)" className="font-mono tabular-nums">
        5
      </text>
      <text x={cx + 4} y={cy - R + 8} fontSize={9} fill="var(--faint)" className="font-mono tabular-nums">
        10
      </text>
      <polygon
        points={skills.map((s, i) => pt(i, s.weight).join(",")).join(" ")}
        fill="var(--primary)"
        fillOpacity={0.13}
        stroke="var(--primary)"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {skills.map((s, i) => {
        const [vx, vy] = pt(i, s.weight);
        return <circle key={i} cx={vx} cy={vy} r={2.2} fill="var(--primary)" />;
      })}
      {skills.map((s, i) => {
        const cos = Math.cos(angle(i));
        const sin = Math.sin(angle(i));
        const lx = cx + cos * (R + 18);
        const ly = cy + sin * (R + 18);
        const anchor = cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle";
        const dy = sin < -0.3 ? -8 : sin > 0.3 ? 16 : 4;
        const label = s.name.length > 6 ? `${s.name.slice(0, 6)}…` : s.name;
        return (
          <g key={i}>
            <text x={lx} y={ly + dy} textAnchor={anchor} fontSize={11} fill="var(--muted)">
              {label}
            </text>
            <text
              x={lx}
              y={ly + dy + 13}
              textAnchor={anchor}
              fontSize={10}
              fill="var(--primary)"
              className="font-mono tabular-nums"
            >
              {s.weight}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function JdPortraitDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<PortraitData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    let cancelled = false;
    jsonFetch<PortraitData>(`/api/tools/jd-portraits/${params.id}`)
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
    if (!(await confirmDialog({ title: "删除记录", message: "确定删除这份考点画像？", danger: true }))) return;
    setActionError("");
    try {
      await jsonFetch(`/api/tools/jd-portraits/${data.id}`, { method: "DELETE" });
    } catch (err) {
      setActionError(errorMessage(err));
      return;
    }
    router.push("/tools/jd");
  }

  if (loadError && !data) return <LoadError message={loadError} onRetry={() => { setLoadError(""); setLoadAttempt((attempt) => attempt + 1); }} />;
  if (!data) return <Loading />;

  const result = data.result;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PreparationReturnLink />
      {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}
      {/* 头部导航与操作栏 */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/tools/jd"
              className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
            >
              ← 返回考点画像列表
            </Link>
            <span className="text-xs text-faint">/</span>
            <span className="text-xs text-muted font-mono">画像 #{data.id}</span>
          </div>
          <h1 className="mt-1 font-serif text-2xl sm:text-3xl font-bold text-ink flex items-center gap-2">
            <span>{result?.role || "JD 考点画像拆解"}</span>
            <span className="rounded-full border border-primary/25 bg-primary-soft px-3 py-0.5 text-xs font-mono font-medium text-primary">
              AI 画像
            </span>
          </h1>
        </div>

        <div className="flex items-center gap-3 text-xs text-faint">
          <span>生成于 {new Date(data.created_at).toLocaleString()}</span>
          <button
            type="button"
            onClick={remove}
            className="text-danger hover:underline ml-2"
          >
            删除画像
          </button>
        </div>
      </div>

      {/* 原始岗位要求折叠 */}
      <details className="group rounded-2xl border border-line bg-card p-4 shadow-card-subtle">
        <summary className="cursor-pointer text-xs font-medium text-muted transition-colors hover:text-ink flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-primary" />
            <span>查看完整原始 JD 文本要求</span>
          </span>
          <span className="text-faint text-[11px] group-open:rotate-180 transition-transform">▼</span>
        </summary>
        <div className="mt-3 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-xl bg-surface/70 border border-line/60 p-4 font-mono text-xs text-muted leading-relaxed">
          {data.jd}
        </div>
      </details>

      {result === null ? (
        <div className="rounded-2xl border border-danger/30 bg-danger-wash p-6 text-center">
          <p className={`text-sm ${textErr}`}>数据异常：画像内容无法解析，可删除本条后重新生成。</p>
          <div className="mt-4">
            <Link href="/tools/jd" className={btnDanger}>
              返回列表
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {/* 必考技能雷达与权重视图 */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
              <SectionTitle>必考技能评估与权重雷达</SectionTitle>
            </div>
            <div className="rounded-2xl border border-line bg-card p-6 shadow-card-subtle grid gap-8 lg:grid-cols-[360px_minmax(0,1fr)] items-center">
              <div className="flex justify-center bg-surface/30 rounded-xl p-4 border border-line/50">
                <SkillRadar skills={result.mustSkills} />
              </div>
              <ul className="divide-y divide-line/70">
                {result.mustSkills.map((s) => (
                  <li key={s.name} className="py-3.5 first:pt-0 last:pb-0 space-y-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-serif text-sm font-bold text-ink">{s.name}</span>
                        <span className="rounded bg-surface px-1.5 py-0.2 font-mono text-[10px] text-muted border border-line">
                          必考度
                        </span>
                      </div>
                      <span className="font-mono text-base font-bold text-primary tabular-nums">
                        {s.weight} <span className="text-xs font-normal text-faint font-sans">/ 10</span>
                      </span>
                    </div>
                    {s.why && (
                      <p className="text-xs leading-relaxed text-muted font-sans">
                        {s.why}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {/* 深度可能追问方向 */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-accent" />
                <SectionTitle>面试官高频追问方向预测</SectionTitle>
              </div>
              <span className="text-xs text-faint">
                {result.followups.length} 个核心考点主题
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {result.followups.map((f, fIdx) => (
                <div
                  key={f.topic}
                  className="rounded-2xl border border-line bg-card p-5 shadow-card-subtle space-y-3 flex flex-col justify-between"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between border-b border-line/60 pb-2.5">
                      <h3 className="font-serif text-[15px] font-bold text-ink flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-primary bg-primary-soft px-2 py-0.5 rounded">
                          #{fIdx + 1}
                        </span>
                        <span>{f.topic}</span>
                      </h3>
                    </div>

                    {f.questions.length > 0 && (
                      <ul className="space-y-2 pt-1">
                        {f.questions.map((q, qi) => (
                          <li
                            key={qi}
                            className="flex items-start gap-2.5 rounded-lg border border-line/60 bg-surface/40 p-2.5 text-xs leading-relaxed text-muted"
                          >
                            <span aria-hidden className="shrink-0 font-mono text-[11px] font-bold text-primary mt-0.5">
                              Q{qi + 1}.
                            </span>
                            <span className="text-ink font-medium">{q}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 公司技术风格猜测 */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
              <SectionTitle>目标团队生态与风格推断</SectionTitle>
            </div>
            <div className="rounded-2xl border border-line bg-card p-6 shadow-card-subtle space-y-4">
              <div className="rounded-xl border border-primary/20 bg-primary-soft/40 p-4">
                <span className="text-xs font-bold text-primary block mb-1">风格定调</span>
                <p className="text-sm font-serif font-bold text-ink leading-relaxed">
                  {result.companyStyle.style}
                </p>
              </div>

              {result.companyStyle.signals.length > 0 && (
                <div className="space-y-2 pt-1">
                  <p className="text-xs font-semibold text-muted">推断关键依据：</p>
                  <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {result.companyStyle.signals.map((sig, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 text-xs leading-relaxed text-muted rounded-lg border border-line/60 bg-surface/30 p-2.5"
                      >
                        <span aria-hidden className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                        <span>{sig}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="text-[11px] text-faint border-t border-line/60 pt-3">
                注：以上技术风格为基于招聘文本的语义挖掘推断，实际情况建议在面试反问环节进一步核实。
              </p>
            </div>
          </section>

          {/* 底部联动行动区 */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-5">
            <Link href="/tools/jd" className="text-xs text-muted hover:text-ink">
              ← 返回画像列表
            </Link>

            <div className="flex items-center gap-3">
              <Link
                href={`/interviews?jd=${encodeURIComponent(data.jd.slice(0, 1000))}`}
                className={btnPrimary}
              >
                带着该 JD 开启模拟面试 →
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
