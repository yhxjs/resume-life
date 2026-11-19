"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ToolHistoryDeletionFeedback } from "@/components/common/tool-history-deletion-feedback";
import { Empty, Loading, LoadError } from "@/components/common/ui-bits";
import { useRouter } from "next/navigation";
import { fetchSse, SseServerError } from "@/lib/fetch-sse";
import { HttpError } from "@/lib/fetcher";
import { useResumeOptions } from "@/hooks/use-resume-options";
import { useResumeVersionSelection } from "@/hooks/use-resume-version-selection";
import { ResumeVersionSelect } from "@/components/resume/resume-version-select";
import { ResumeVersionBadge } from "@/components/resume/resume-version-badge";
import { useCursorList } from "@/hooks/use-cursor-list";
import { useIntroDeletion } from "@/hooks/use-intro-deletion";
import { formatIntroHistoryDate, readIntroListPage, type IntroListItem } from "@/lib/intro-history";
import { btnDanger, btnGhost, btnPrimary, inputCls, textareaCls, labelCls, textErr } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";

export default function IntrosPage() {
  const router = useRouter();
  const { items, total, nextCursor, loading, loadingMore, listError: loadError, failedCursor, loadMore, reload } = useCursorList<IntroListItem>({
    queryKey: "intros",
    buildUrl: (cursor) => `/api/intros?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    delay: 0,
    validatePage: (page, cursor) => { readIntroListPage(page, { cursor }); },
  });
  const [resumeId, setResumeId] = useState<number | "">("");
  const [jd, setJd] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<{ message: string; uncertain: boolean } | null>(null);
  const generation = useRef<AbortController | null>(null);
  const deletion = useIntroDeletion(reload);
  const visibleItems = items?.filter(item => !deletion.deletedIds.has(item.id)) ?? null;
  const busy = generating || deletion.busy;

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
    setResumeId((current) => resumes.some((resume) => resume.id === current) ? current : resumes[0]!.id);
  }, [resumes]);

  const selectedResume = resumes?.find((resume) => resume.id === resumeId);
  const { resumeVersionId, setResumeVersionId } = useResumeVersionSelection(selectedResume);

  async function generate() {
    if (generation.current || !deletion.canStart() || resumeId === "" || resumeVersionId === "" || !jd.trim()) return;
    const controller = new AbortController();
    generation.current = controller;
    const isCurrent = () => generation.current === controller && !controller.signal.aborted;
    setGenerating(true);
    setError(null);
    try {
      await fetchSse<unknown>("/api/intros", {
        body: { resume_id: resumeId, resume_version_id: resumeVersionId, jd: jd.trim() },
        signal: controller.signal,
        onDone: (data) => {
          if (!isCurrent()) return;
          const id = data && typeof data === "object" ? (data as { id?: unknown }).id : undefined;
          if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("生成完成响应不完整，请先刷新历史记录核对是否已保存");
          router.push(`/intros/${id}`);
        },
      });
    } catch (err) {
      if (!isCurrent()) return;
      const rejected = err instanceof SseServerError || (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408);
      setError({ message: errorMessage(err), uncertain: !rejected });
      setGenerating(false);
      generation.current = null;
      reload();
    }
  }

  function remove(item: IntroListItem) {
    if (!generation.current) void deletion.remove(item);
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8 wrap-anywhere">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">自我介绍工坊</h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            按选定的简历发布版本与目标岗位生成两版介绍草稿，逐句点评并配合遮罩演练。30 秒与 2 分钟是篇幅目标，实际时长以朗读为准。
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
                onChange={(e) => { if (!generation.current && deletion.canStart()) setResumeId(Number(e.target.value)); }}
                disabled={busy}
              >
                {resumes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </label>

            <ResumeVersionSelect resume={selectedResume} value={resumeVersionId} onChange={id => { if (!generation.current && deletion.canStart()) setResumeVersionId(id); }} disabled={busy} />

            <label className="block">
              <span className={labelCls}>目标岗位要求（JD / 职位描述）</span>
              <textarea
                className={`${textareaCls} mt-1 font-sans`}
                value={jd}
                onChange={(e) => { if (!generation.current && deletion.canStart()) setJd(e.target.value); }}
                placeholder="粘贴目标岗位的职责与任职要求，依据简历中已有的经历与个人分工组织表达…"
                disabled={busy}
              />
            </label>

            <p className="text-xs text-muted">生成依据选定的简历版本与 JD，不核验经历真伪。请核对个人分工、技能掌握程度及未上线、待验证等限定后再使用。</p>
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-line/60">
              <span className="text-xs text-faint">同时输出 30 秒紧凑版与 2 分钟详述版</span>
              <button
                type="button"
                className={btnPrimary}
                onClick={generate}
                disabled={busy || !jd.trim() || resumeId === "" || resumeVersionId === ""}
              >
                {generating ? "AI 正在构思双版自我介绍…" : "立即生成两版自我介绍"}
              </button>
            </div>

            {generating && (
              <div role="status" className="mt-3 rounded-xl border border-primary/20 bg-primary-soft/50 p-4 animate-in fade-in duration-200">
                <div className="flex items-center gap-2 text-xs font-bold text-primary">
                  <span className="inline-block h-2 w-2 animate-ping rounded-full bg-primary" />
                  AI 面试教练正在打磨 30 秒与 2 分钟双版自我介绍…
                </div>
                <p className="mt-2 text-sm text-ink leading-relaxed">正在依据所选简历版本与 JD 组织表达；完整校验并保存后进入演练页。</p>
              </div>
            )}
          </div>

          {/* 右侧破局心法与背诵指南（占 1 栏） */}
          <div className="flex flex-col justify-between space-y-4 rounded-2xl border border-line bg-card p-6 shadow-card-subtle">
            <div className="space-y-3.5">
              <div className="flex items-center justify-between border-b border-line pb-2.5">
                <h3 className="font-serif text-sm font-bold text-ink">开场表达三原则</h3>
                <span className="rounded bg-accent-wash px-2 py-0.5 text-[10px] font-bold text-accent">
                  表达心法
                </span>
              </div>
              <ul className="space-y-3 text-xs leading-relaxed text-muted">
                <li className="flex items-start gap-2.5">
                  <span className="shrink-0 font-mono font-bold text-primary">01.</span>
                  <span><strong>交代定位：</strong>用有依据的身份或方向自然开场，教育、参与和维护经历都可使用；年限未知时省略。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="shrink-0 font-mono font-bold text-primary">02.</span>
                  <span><strong>说明相关经历：</strong>选择与岗位相关的实际任务和个人行动。没有量化结果时保留定性描述，不把参与改成主导。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="shrink-0 font-mono font-bold text-primary">03.</span>
                  <span><strong>留下讨论方向：</strong>可用亲自参与且能解释的任务或取舍自然收尾，不要求架构亮点；未上线、待验证的状态照实交代。</span>
                </li>
              </ul>
            </div>

            <div className="rounded-xl border border-accent/20 bg-accent-wash/60 p-3.5 text-xs text-accent leading-relaxed">
              💡 <strong>演练方法：</strong>先核对草稿，再实际朗读调整篇幅。详情页遮罩会模糊整句，点击单句揭开后可再次遮蔽。
            </div>
          </div>
        </div>
      )}

      {error && <div role="alert" className={`space-y-1 text-sm ${textErr}`}>
        <p>{error.message}</p>
        <p className="text-xs">{error.uncertain
          ? "响应异常时仍可能已保存，请先核对历史再重新生成；历史读取失败时可单独重试。"
          : "请按上方提示处理后再生成。"}</p>
        {error.uncertain && <>
          <p className="text-xs">即使当前历史没有新记录，也不代表原请求不会稍后保存。</p>
          <button type="button" className={btnGhost} onClick={reload} disabled={loading || loadingMore}>
            {loading || loadingMore ? "正在读取历史…" : "重新读取历史"}
          </button>
        </>}
      </div>}
      <ToolHistoryDeletionFeedback deletion={deletion} deletingLabel="正在删除自我介绍…" />
      {loadError && <LoadError message={`自我介绍历史加载失败：${loadError}`} onRetry={failedCursor === null ? reload : loadMore} />}
      {items === null && !loadError && <Loading label="加载自我介绍历史中…" />}

      {/* 历史生成记录（双列卡片化） */}
      {visibleItems !== null && (
        <section aria-label="自我介绍历史" className="mt-10 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
              <h2 className="font-serif text-base font-bold text-ink">自我介绍沉淀档案 (已载入 {visibleItems.length}{total !== null && deletion.deletedIds.size === 0 ? ` / 共 ${total}` : ""})</h2>
            </div>
            <span className="text-xs text-faint">按记录编号倒序</span>
          </div>

          {visibleItems.length === 0 && <p className="text-sm text-muted">{nextCursor ? "本页记录已移除，可以继续加载更早的自我介绍。" : "尚无自我介绍历史，生成后会显示在这里。"}</p>}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {visibleItems.map((it) => (
              <article
                key={it.id}
                aria-label={`自我介绍 #${it.id}`}
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
                      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="rounded bg-primary-soft px-2 py-0.5 text-[10px] font-bold text-primary">
                          30s / 2min 双版
                        </span>
                        <span className="max-w-full rounded border border-line bg-surface px-2 py-0.5 font-mono text-[10px] text-muted">
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

                <div className="mt-4 flex items-start justify-between gap-3 border-t border-line/60 pt-3 text-xs">
                  <time dateTime={it.created_at} className="min-w-0 font-mono text-[11px] text-faint [overflow-wrap:anywhere]">
                    {formatIntroHistoryDate(it.created_at)}
                  </time>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => remove(it)}
                      disabled={busy}
                      className={btnDanger}
                    >
                      删除
                    </button>
                    <Link href={`/intros/${it.id}`} className={btnPrimary}>
                      查看演练
                    </Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
          {nextCursor && (
            <div className="flex justify-center pt-2">
              <button type="button" className={btnPrimary} onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "加载中…" : failedCursor === nextCursor ? "重试加载更多" : "加载更多"}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
