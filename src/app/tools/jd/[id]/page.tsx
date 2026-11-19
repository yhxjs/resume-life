"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { PreparationReturnLink } from "@/components/application/preparation-return-link";
import { useParams, useRouter } from "next/navigation";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { Loading, LoadError, SectionTitle } from "@/components/common/ui-bits";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { parseJdPortraitResult, type JdPortraitResult } from "@/lib/jd-portrait";
import { btnDanger, btnPrimary, textErr } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";

type PortraitData = {
  id: number;
  jd: string;
  result: JdPortraitResult | null;
  created_at: string;
};

function readPortrait(value: unknown, id: string): PortraitData {
  if (!value || typeof value !== "object") throw new Error("画像响应不完整，请重新读取");
  const data = value as PortraitData;
  if (!Number.isSafeInteger(data.id) || data.id <= 0 || data.id !== Number(id) ||
    typeof data.jd !== "string" || typeof data.created_at !== "string" ||
    (data.result !== null && !parseJdPortraitResult(JSON.stringify(data.result)))) {
    throw new Error("画像响应不完整或记录不符，请重新读取");
  }
  return data;
}

/** 三个及以上考点时展示准备优先级雷达，稀疏结果使用下方列表。 */
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
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[360px]" role="img" aria-label="技能准备优先级雷达图">
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
  return <PortraitDetail key={params.id} portraitId={params.id} />;
}

function PortraitDetail({ portraitId }: { portraitId: string }) {
  const router = useRouter();
  const [data, setData] = useState<PortraitData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [actionError, setActionError] = useState("");
  const [phase, setPhase] = useState<"idle" | "confirming" | "deleting" | "checking" | "unknown" | "deleted">("idle");
  const active = useRef(false);
  const command = useRef(false);
  const checking = useRef(false);
  const request = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    jsonFetch<unknown>(`/api/tools/jd-portraits/${portraitId}`, { signal: controller.signal, cache: "no-store" })
      .then((value) => {
        if (cancelled) return;
        setData(readPortrait(value, portraitId));
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [portraitId, loadAttempt]);

  function deleted() {
    setPhase("deleted");
    router.push("/tools/jd");
  }

  async function checkDeletion(cause: string) {
    if (!active.current || checking.current) return;
    checking.current = true;
    setPhase("checking");
    setActionError("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const value = await jsonFetch<unknown>(`/api/tools/jd-portraits/${portraitId}`, { signal: controller.signal, cache: "no-store" });
      if (!active.current) return;
      setData(readPortrait(value, portraitId));
      setActionError(`${cause}；已重新读取，记录目前仍存在，请核对后再决定是否删除。`);
      command.current = false;
      setPhase("idle");
    } catch (err) {
      if (!active.current) return;
      if (err instanceof HttpError && err.status === 404) {
        deleted();
        return;
      }
      setActionError(`删除结果尚未确认：${errorMessage(err)}。请先重新读取删除状态。`);
      setPhase("unknown");
    } finally {
      checking.current = false;
    }
  }

  async function remove() {
    if (!data || !active.current || command.current) return;
    command.current = true;
    const controller = new AbortController();
    request.current = controller;
    setPhase("confirming");
    const confirmed = await confirmDialog({ title: "删除记录", message: `考点画像 #${data.id}「${data.result?.role || "未保存岗位名称"}」，保存于 ${data.created_at}。将删除原始 JD、画像及关联的投递备战素材引用；投递记录和已生成的模拟面试保留。确定删除？`, danger: true, signal: controller.signal });
    if (!active.current || controller.signal.aborted || request.current !== controller) return;
    if (!confirmed) {
      request.current = null;
      command.current = false;
      setPhase("idle");
      return;
    }
    setActionError("");
    setPhase("deleting");
    try {
      const result = await jsonFetch<{ ok?: unknown }>(`/api/tools/jd-portraits/${portraitId}`, { method: "DELETE", signal: controller.signal });
      if (!active.current) return;
      if (!result || result.ok !== true) throw new Error("删除响应不完整");
    } catch (err) {
      if (!active.current) return;
      if (err instanceof HttpError && err.status === 404) {
        deleted();
      } else if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408) {
        setActionError(errorMessage(err));
        command.current = false;
        setPhase("idle");
      } else {
        await checkDeletion(errorMessage(err));
      }
      return;
    }
    deleted();
  }

  if (loadError && !data) return <LoadError message={loadError} onRetry={() => { setLoadError(""); setLoadAttempt((attempt) => attempt + 1); }} />;
  if (!data) return <Loading />;

  const result = data.result;

  return (
    <div className="mx-auto min-w-0 max-w-6xl space-y-8 [overflow-wrap:anywhere]">
      <PreparationReturnLink />
      {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}
      {phase === "unknown" && <button type="button" className={btnPrimary} onClick={() => { void checkDeletion("上次删除响应异常"); }}>重新读取删除状态</button>}
      {(phase === "checking" || phase === "deleting" || phase === "deleted") && <p role="status" className="text-sm text-muted">{phase === "checking" ? "正在核对删除状态…" : phase === "deleted" ? "记录已不存在，正在返回列表…" : "正在删除画像…"}</p>}
      {/* 头部导航与操作栏 */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <div className="min-w-0">
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
          <h1 className="mt-1 font-serif text-2xl sm:text-3xl font-bold text-ink flex flex-wrap items-center gap-2">
            <span>{result?.role || "JD 考点画像拆解"}</span>
            <span className="rounded-full border border-primary/25 bg-primary-soft px-3 py-0.5 text-xs font-mono font-medium text-primary">
              AI 画像
            </span>
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-faint">
          <span>生成于 {new Date(data.created_at).toLocaleString()}</span>
          <button
            type="button"
            onClick={remove}
            disabled={phase !== "idle" && phase !== "confirming"}
            className="text-danger hover:underline ml-2 disabled:opacity-50"
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
        <div role="region" aria-label="原始 JD" className="mt-3 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-xl bg-surface/70 border border-line/60 p-4 font-mono text-xs text-muted leading-relaxed">
          {data.jd}
        </div>
      </details>

      {result === null ? (
        <div className="rounded-2xl border border-danger/30 bg-danger-wash p-6 text-center">
          <p className={`text-sm ${textErr}`}>该画像内容无法解析，原始 JD 与记录仍已保留。可返回列表重新生成，或展开原始 JD 核对内容。</p>
          <div className="mt-4">
            <Link href="/tools/jd" className={btnDanger}>
              返回列表
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {/* 准备优先级与条件式雷达 */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
              <SectionTitle>技能准备优先级</SectionTitle>
            </div>
            <p className="text-xs text-muted">依据 JD 安排准备顺序，分数不代表实际面试的必考概率。</p>
            <div className={`rounded-2xl border border-line bg-card p-6 shadow-card-subtle grid gap-8 items-center ${result.mustSkills.length >= 3 ? "lg:grid-cols-[360px_minmax(0,1fr)]" : ""}`}>
              {result.mustSkills.length >= 3 && (
                <div className="flex justify-center bg-surface/30 rounded-xl p-4 border border-line/50">
                  <SkillRadar skills={result.mustSkills} />
                </div>
              )}
              {result.mustSkills.length === 0 && (
                <p className="text-sm text-muted">当前 JD 信息不足，暂未提炼出明确考点。补充岗位职责和任职要求后可重新生成。</p>
              )}
              <ul className="divide-y divide-line/70">
                {result.mustSkills.map((s) => (
                  <li key={s.name} className="py-3.5 first:pt-0 last:pb-0 space-y-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="font-serif text-sm font-bold text-ink">{s.name}</span>
                        <span className="rounded bg-surface px-1.5 py-0.2 font-mono text-[10px] text-muted border border-line">
                          优先级
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-accent" />
                <SectionTitle>建议练习的追问方向</SectionTitle>
              </div>
              <span className="text-xs text-faint">
                {result.followups.length} 个核心考点主题
              </span>
            </div>

            {result.followups.length === 0 && (
              <p className="text-sm text-muted">暂没有足够的岗位信息生成具体练习题。</p>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {result.followups.map((f, fIdx) => (
                <div
                  key={f.topic}
                  className="rounded-2xl border border-line bg-card p-5 shadow-card-subtle space-y-3 flex flex-col justify-between"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between border-b border-line/60 pb-2.5">
                      <h3 className="font-serif text-[15px] font-bold text-ink flex items-center gap-2">
                        <span className="shrink-0 font-mono text-xs font-bold text-primary bg-primary-soft px-2 py-0.5 rounded">
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
                href={`/interviews?portraitId=${data.id}`}
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
