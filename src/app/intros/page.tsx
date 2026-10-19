"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { confirmDialog, alertDialog } from "@/components/common/confirm-dialog";
import { Empty, Loading, LoadError } from "@/components/common/ui-bits";
import { useRouter } from "next/navigation";
import { jsonFetch } from "@/lib/fetcher";
import { fetchSse } from "@/lib/fetch-sse";
import { useTypewriter } from "@/hooks/use-typewriter";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { useResumeOptions } from "@/hooks/use-resume-options";
import { useResumeVersionSelection } from "@/hooks/use-resume-version-selection";
import { ResumeVersionSelect } from "@/components/resume/resume-version-select";
import { ResumeVersionBadge, type ResumeVersionBinding } from "@/components/resume/resume-version-badge";
import { useCursorList } from "@/hooks/use-cursor-list";
import { btnDanger, btnPrimary, inputCls, textareaCls, labelCls, textErr } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";

type IntroItem = ResumeVersionBinding & {
  id: number;
  jd: string;
  created_at: string;
  resume_title: string;
};

export default function IntrosPage() {
  const router = useRouter();
  const { items, total, nextCursor, loadingMore, listError: loadError, failedCursor, loadMore, reload } = useCursorList<IntroItem>({
    queryKey: "intros",
    buildUrl: (cursor) => `/api/intros?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    delay: 0,
  });
  const [resumeId, setResumeId] = useState<number | "">("");
  const [jd, setJd] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const typewriter = useTypewriter();
  const { containerRef: introScrollRef, handleScroll: handleIntroScroll } = useAutoScroll(typewriter.displayedText);
  const generation = useRef<AbortController | null>(null);

  const { resumes, resumesError, reloadResumes } = useResumeOptions();

  useEffect(() => () => {
    generation.current?.abort();
    generation.current = null;
  }, []);

  // 简历列表就绪后默认选中第一份，否则下拉为空、生成按钮无从选择。
  // 这是「外部数据就绪 → 本地默认值」的一次性同步；规则针对的是渲染期级联重渲染，
  // 而此处只在 resumes 变化时触发一次，故显式豁免该规则。
  useEffect(() => {
    if (!resumes || resumes.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResumeId(resumes[0]!.id);
  }, [resumes]);

  const selectedResume = resumes?.find((resume) => resume.id === resumeId);
  const { resumeVersionId, setResumeVersionId } = useResumeVersionSelection(selectedResume);

  async function generate() {
    if (resumeId === "" || resumeVersionId === "" || !jd.trim()) return;
    generation.current?.abort();
    const controller = new AbortController();
    generation.current = controller;
    const isCurrent = () => generation.current === controller && !controller.signal.aborted;
    setGenerating(true);
    setError("");
    typewriter.reset();
    try {
      await fetchSse<{ id: number }>("/api/intros", {
        body: { resume_id: resumeId, resume_version_id: resumeVersionId, jd: jd.trim() },
        signal: controller.signal,
        onDelta: (delta) => {
          if (!isCurrent()) return;
          typewriter.appendDelta(delta);
        },
        onDone: (data) => {
          if (!isCurrent()) return;
          typewriter.flush();
          router.push(`/intros/${data.id}`);
        },
        onError: (err) => {
          if (!isCurrent()) return;
          setError(err.message);
          setGenerating(false);
          typewriter.reset();
        },
      });
    } catch (err) {
      if (!isCurrent()) return;
      setError(errorMessage(err));
      setGenerating(false);
      typewriter.reset();
    }
  }

  async function remove(id: number) {
    if (!(await confirmDialog({ title: "删除记录", message: "确定删除这份自我介绍及其两版内容？", danger: true }))) return;
    try {
      await jsonFetch(`/api/intros/${id}`, { method: "DELETE" });
    } catch (err) {
      await alertDialog({ title: "删除失败", message: errorMessage(err) });
      return;
    }
    reload();
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">自我介绍工坊</h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            按选定简历与目标岗位一键定制 30 秒黄金电梯版与 2 分钟详述版；逐句点评打磨表达，配合背诵遮罩脱稿演练。
          </p>
        </div>
      </div>

      {resumesError && <LoadError message={`简历列表加载失败：${resumesError}`} onRetry={reloadResumes} />}
      {resumes === null ? (
        !resumesError && <Loading label="加载自我介绍工坊中…" />
      ) : resumes.length === 0 ? (
        <Empty action={<Link href="/resumes" className={btnPrimary}>创建或导入简历</Link>}>
          还没有简历。请先到「简历」创建或导入一份。
        </Empty>
      ) : (
        /* 双栏响应式生成台 */
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* 左侧输入配置区（占 2 栏） */}
          <div className="space-y-5 rounded-2xl border border-line bg-card p-6 shadow-card-subtle lg:col-span-2">
            <div className="flex items-center justify-between border-b border-line pb-3.5">
              <div className="flex items-center gap-2">
                <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
                <span className="font-serif text-base font-bold text-ink">生成定制自我介绍</span>
              </div>
              <span className="font-mono text-xs text-faint">双版本同步生成</span>
            </div>

            <label className="block">
              <span className={labelCls}>选择参考简历</span>
              <select
                className={`${inputCls} mt-1`}
                value={resumeId}
                onChange={(e) => setResumeId(Number(e.target.value))}
                disabled={generating}
              >
                {resumes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </label>

            <ResumeVersionSelect resume={selectedResume} value={resumeVersionId} onChange={setResumeVersionId} disabled={generating} />

            <label className="block">
              <span className={labelCls}>目标岗位要求（JD / 职位描述）</span>
              <textarea
                className={`${textareaCls} mt-1 font-sans`}
                value={jd}
                onChange={(e) => setJd(e.target.value)}
                placeholder="粘贴目标岗位的职责与任职要求，AI 将挑选最契合的经历亮点，提炼成黄金话术…"
                disabled={generating}
              />
            </label>

            <div className="flex items-center justify-between pt-2 border-t border-line/60">
              <span className="text-xs text-faint">同时输出 30 秒紧凑版与 2 分钟详述版</span>
              <button
                type="button"
                className={btnPrimary}
                onClick={generate}
                disabled={generating || !jd.trim() || resumeId === "" || resumeVersionId === ""}
              >
                {generating ? "AI 正在构思双版自我介绍…（约需半分钟）" : "立即生成两版自我介绍"}
              </button>
            </div>

            {generating && (
              <div className="mt-3 rounded-xl border border-primary/20 bg-primary-soft/50 p-4 animate-in fade-in duration-200">
                <div className="flex items-center gap-2 text-xs font-bold text-primary">
                  <span className="inline-block h-2 w-2 animate-ping rounded-full bg-primary" />
                  AI 面试教练正在打磨 30 秒与 2 分钟双版自我介绍…
                </div>
                <div
                  ref={introScrollRef}
                  onScroll={handleIntroScroll}
                  className="mt-2 text-sm text-ink leading-relaxed font-sans whitespace-pre-wrap max-h-48 overflow-y-auto"
                >
                  {typewriter.displayedText || "正在分析岗位亮点契合点，规划开篇钩子与核心证据链…"}
                  {typewriter.isTyping && (
                    <span className="inline-block w-1.5 h-4 ml-0.5 bg-primary animate-pulse align-middle" />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 右侧破局心法与背诵指南（占 1 栏） */}
          <div className="flex flex-col justify-between space-y-4 rounded-2xl border border-line bg-card p-6 shadow-card-subtle">
            <div className="space-y-3.5">
              <div className="flex items-center justify-between border-b border-line pb-2.5">
                <h3 className="font-serif text-sm font-bold text-ink">黄金开场三原则</h3>
                <span className="rounded bg-accent-wash px-2 py-0.5 text-[10px] font-bold text-accent">
                  表达心法
                </span>
              </div>
              <ul className="space-y-3 text-xs leading-relaxed text-muted">
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-primary">01.</span>
                  <span><strong>拒绝报菜名：</strong>切忌平铺直叙复述学校与年限，开篇第一句亮出最核心的专业技术标签。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-primary">02.</span>
                  <span><strong>对标 JD 痛点：</strong>前 30 秒务必点出与目标岗位最匹配的 1-2 项战果，证明“我能解决你们的问题”。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-primary">03.</span>
                  <span><strong>预埋诱饵钩子：</strong>在结尾留出 1 个最具含金量的架构亮点，主动引导面试官顺势提问。</span>
                </li>
              </ul>
            </div>

            <div className="rounded-xl border border-accent/20 bg-accent-wash/60 p-3.5 text-xs text-accent leading-relaxed">
              💡 <strong>记忆技巧：</strong>生成后进入详情页开启「脱稿背诵遮罩」，逐词遮挡训练肌肉记忆！
            </div>
          </div>
        </div>
      )}

      {error && <p className={`mt-3 text-sm ${textErr}`}>{error}</p>}
      {loadError && <LoadError message={`自我介绍历史加载失败：${loadError}`} onRetry={failedCursor === null ? reload : loadMore} />}
      {items === null && !loadError && <Loading label="加载自我介绍历史中…" />}

      {/* 历史生成记录（双列卡片化） */}
      {items !== null && items.length > 0 && (
        <div className="mt-10 space-y-4">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
              <h2 className="font-serif text-base font-bold text-ink">自我介绍沉淀档案 (已载入 {items.length}{total !== null ? ` / 共 ${total}` : ""})</h2>
            </div>
            <span className="text-xs text-faint">按生成时间倒序</span>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {items.map((it) => (
              <div
                key={it.id}
                className="group flex flex-col justify-between rounded-xl border border-line bg-card p-4 shadow-card-subtle transition-all duration-150 hover:border-primary/40 hover:bg-surface/30"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        href={`/intros/${it.id}`}
                        className="font-serif text-base font-bold text-ink hover:text-primary transition-colors line-clamp-1"
                      >
                        {(it.jd.split("\n")[0] ?? "").slice(0, 45) || "（无职位描述）"}
                      </Link>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-primary-soft px-2 py-0.5 text-[10px] font-bold text-primary">
                          30s / 2min 双版
                        </span>
                        <span className="rounded border border-line bg-surface px-2 py-0.5 font-mono text-[10px] text-muted">
                          {it.resume_title}
                          <ResumeVersionBadge {...it} />
                        </span>
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-muted line-clamp-2 leading-relaxed">
                    {it.jd || "无职位描述记录"}
                  </p>
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-line/60 pt-3 text-xs">
                  <span className="font-mono text-[11px] text-faint">
                    {new Date(it.created_at).toLocaleDateString()}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => remove(it.id)}
                      className={btnDanger}
                    >
                      删除
                    </button>
                    <Link href={`/intros/${it.id}`} className={btnPrimary}>
                      查看演练
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {nextCursor && (
            <div className="flex justify-center pt-2">
              <button type="button" className={btnPrimary} onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "加载中…" : failedCursor === nextCursor ? "重试加载更多" : "加载更多"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
