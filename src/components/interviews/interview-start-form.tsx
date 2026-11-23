"use client";

import Link from "next/link";
import { useId } from "react";
import { Empty, Loading, LoadError } from "@/components/common/ui-bits";
import type { ResumeBrief } from "@/hooks/use-interviews-page";
import { ResumeVersionSelect } from "@/components/resume/resume-version-select";
import { INTERVIEW_STYLES, INTERVIEW_ROUNDS_ERROR, isInterviewRounds, type InterviewStyleKey } from "@/lib/interview";
import { btnGhost, btnPrimary, inputCls, textareaCls, labelCls, textErr } from "@/lib/ui";

export type InterviewStartMode = "single" | "series";
export type InterviewPerspective = "candidate" | "interviewer";

export function InterviewStartForm({
  resumes,
  resumesError,
  onRetryResumes,
  mode,
  perspective,
  resumeId,
  resumeVersionId,
  jd,
  rounds,
  style,
  starting,
  navigating = false,
  applicationBound = false,
  error,
  creationUncertain = true,
  configurationError = "",
  displayedText,
  isTyping,
  onModeChange,
  onPerspectiveChange,
  onResumeIdChange,
  onResumeVersionIdChange,
  onJdChange,
  onRoundsChange,
  onStyleChange,
  onStart,
  onCancel,
}: {
  resumes: ResumeBrief[] | null;
  resumesError?: string;
  onRetryResumes?: () => void;
  mode: InterviewStartMode;
  perspective: InterviewPerspective;
  resumeId: number | "";
  resumeVersionId: number | "";
  jd: string;
  rounds: number | "";
  style: InterviewStyleKey;
  starting: boolean;
  navigating?: boolean;
  applicationBound?: boolean;
  error: string;
  creationUncertain?: boolean;
  configurationError?: string;
  displayedText: string;
  isTyping: boolean;
  onModeChange: (mode: InterviewStartMode) => void;
  onPerspectiveChange: (perspective: InterviewPerspective) => void;
  onResumeIdChange: (id: number) => void;
  onResumeVersionIdChange: (id: number) => void;
  onJdChange: (jd: string) => void;
  onRoundsChange: (rounds: number | "") => void;
  onStyleChange: (style: InterviewStyleKey) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const roundsId = useId();
  const roundsErrorId = `${roundsId}-error`;
  const validRounds = isInterviewRounds(rounds);
  return (
    <>
      {configurationError && <div role="alert" className="space-y-2 text-sm text-danger"><p>{configurationError}</p><button type="button" className={btnGhost} disabled={starting} onClick={onRetryResumes}>重新读取简历列表</button></div>}
      {resumesError && <LoadError message={`简历列表加载失败：${resumesError}`} onRetry={onRetryResumes} />}
      {resumes === null ? (
        !resumesError && <Loading label="加载面试数据中…" />
      ) : resumes.length === 0 ? (
        !applicationBound && <Empty action={<Link href="/resumes" className={btnPrimary}>创建或导入简历</Link>}>
          还没有简历。请先到「简历」创建或导入一份。
        </Empty>
      ) : (
        /* 双栏响应式考场配置台 */
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* 左侧主控制台（占 2 列） */}
          <div className="space-y-5 rounded-2xl border border-line bg-card p-6 shadow-card-subtle lg:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3.5">
              <div className="flex items-center gap-2">
                <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
                <span className="font-serif text-base font-bold text-ink">{perspective === "candidate" ? "配置实战考场" : "配置面试题目图谱"}</span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-lg border border-line bg-surface p-1 text-xs" role="group" aria-label="面试视角">
                  <button type="button" className={`rounded-md px-3 py-1.5 font-medium transition-colors ${perspective === "candidate" ? "bg-card font-bold text-ink shadow-xs" : "text-muted hover:text-ink"}`} onClick={() => onPerspectiveChange("candidate")} aria-pressed={perspective === "candidate"} disabled={starting}>候选人视角</button>
                  <button type="button" className={`rounded-md px-3 py-1.5 font-medium transition-colors ${perspective === "interviewer" ? "bg-card font-bold text-ink shadow-xs" : "text-muted hover:text-ink"}`} onClick={() => onPerspectiveChange("interviewer")} aria-pressed={perspective === "interviewer"} disabled={starting}>面试官视角</button>
                </div>
                {perspective === "candidate" && <div className="inline-flex rounded-lg border border-line bg-surface p-1 text-xs" role="group" aria-label="面试模式">
                  <button type="button" className={`rounded-md px-3 py-1.5 font-medium transition-colors ${mode === "single" ? "bg-card font-bold text-ink shadow-xs" : "text-muted hover:text-ink"}`} onClick={() => onModeChange("single")} aria-pressed={mode === "single"} disabled={starting}>单轮模考</button>
                  <button type="button" className={`rounded-md px-3 py-1.5 font-medium transition-colors ${mode === "series" ? "bg-card font-bold text-ink shadow-xs" : "text-muted hover:text-ink"}`} onClick={() => onModeChange("series")} aria-pressed={mode === "series"} disabled={starting}>进阶三轮连打</button>
                </div>}
              </div>
            </div>

            {perspective === "candidate" && mode === "series" && (
              <div className="rounded-xl border border-accent/25 bg-accent-wash p-3.5 text-xs leading-relaxed text-ink">
                <span className="font-bold text-accent">三轮模拟安排：</span>
                一面 · 技术面（深度攻坚）→ 二面 · 主管面（架构权衡与系统设计）→ 三面 · HR 面（动机与团队协作）。
                前几轮表现与薄弱点会带入后轮，结束后生成跨轮综合总评。
              </div>
            )}

            <div className={`grid grid-cols-1 gap-4 ${perspective === "candidate" ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
              <label className="block">
                <span className={labelCls}>关联简历</span>
                <select
                  className={`${inputCls} mt-1`}
                  value={resumeId}
                  disabled={applicationBound || starting}
                  onChange={(event) => onResumeIdChange(Number(event.target.value))}
                >
                  {resumeId === "" && <option value="" disabled>请选择可用简历</option>}
                  {resumes.map((resume) => (
                    <option key={resume.id} value={resume.id}>
                      {resume.title}
                    </option>
                  ))}
                </select>
              </label>
              {perspective === "candidate" && <div className="block">
                <label htmlFor={roundsId} className={labelCls}>{mode === "series" ? "每轮题数" : "总题数"}</label>
                <input
                  id={roundsId}
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  className={`${inputCls} mt-1 font-mono`}
                  value={rounds}
                  disabled={starting}
                  aria-invalid={!validRounds}
                  aria-describedby={!validRounds ? roundsErrorId : undefined}
                  onChange={(event) => onRoundsChange(event.target.value === "" ? "" : Number(event.target.value))}
                />
                {!validRounds && <span id={roundsErrorId} className="mt-1 block text-xs text-danger">{INTERVIEW_ROUNDS_ERROR}</span>}
              </div>}
              {(perspective === "interviewer" || mode === "single") && (
                <label className="block">
                  <span className={labelCls}>考官风格</span>
                  <select
                    className={`${inputCls} mt-1`}
                    value={style}
                    disabled={starting}
                    onChange={(event) => onStyleChange(event.target.value as InterviewStyleKey)}
                  >
                    {INTERVIEW_STYLES.map((interviewStyle) => (
                      <option key={interviewStyle.key} value={interviewStyle.key}>
                        {interviewStyle.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <ResumeVersionSelect resume={resumes.find((resume) => resume.id === resumeId)} value={resumeVersionId} onChange={onResumeVersionIdChange} disabled={applicationBound || starting} />

            <label className="block">
              <span className={labelCls}>目标岗位要求（JD / 职位描述）</span>
              <textarea
                className={`${textareaCls} mt-1 font-sans`}
                value={jd}
                readOnly={applicationBound}
                disabled={starting}
                onChange={(event) => onJdChange(event.target.value)}
                placeholder="直接粘贴目标岗位的任职要求、技术栈或核心职责..."
              />
            </label>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-line/60">
              <span className="text-xs text-faint">
                {perspective === "interviewer"
                  ? "按面试官风格逐轮生成预测回答与追问分支"
                  : style === "mining" && mode === "single"
                  ? "提示：访谈官将引导你梳理实际任务、行动、分工与已知结果"
                  : "提示：AI 将结合选定简历与 JD 针对性出题"}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {starting && !navigating && (
                  <button type="button" className={btnGhost} onClick={onCancel}>
                    取消
                  </button>
                )}
                {perspective === "candidate" && <button
                  type="button"
                  className={btnPrimary}
                  onClick={onStart}
                  disabled={starting || Boolean(configurationError) || !validRounds || !jd.trim() || resumeId === "" || resumeVersionId === ""}
                >
                  {navigating ? "首题已保存，正在进入面试…" : starting
                    ? "准备考场中…（正在命制首题）"
                    : mode === "series"
                    ? "开启进阶三轮连打"
                    : style === "mining"
                    ? "立即开启经历挖掘"
                    : "立即开启模拟实战"}
                </button>}
              </div>
            </div>

            {starting && (
              <div role="status" className="mt-4 rounded-xl border border-primary/20 bg-primary-soft/50 p-4 animate-in fade-in duration-200">
                <div className="flex items-center gap-2 text-xs font-bold text-primary">
                  <span className="inline-block h-2 w-2 animate-ping rounded-full bg-primary" />
                  {navigating ? "首题已保存，正在进入面试…" : "面试官思考中，首题拟定中…"}
                </div>
                <div className="mt-2 text-sm text-ink leading-relaxed font-sans whitespace-pre-wrap">
                  {displayedText || "正在分析简历经历与岗位契合点，拟定最针对性的首发考题…"}
                  {isTyping && (
                    <span className="inline-block w-1.5 h-4 ml-0.5 bg-primary animate-pulse align-middle" />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 右侧备考战术与机制看板（占 1 列） */}
          <div className="flex flex-col justify-between space-y-4 rounded-2xl border border-line bg-card p-6 shadow-card-subtle">
            <div className="space-y-3.5">
              <div className="flex items-center justify-between border-b border-line pb-2.5">
                <h3 className="font-serif text-sm font-bold text-ink">{perspective === "candidate" ? "考场战术与机制" : "图谱生成规则"}</h3>
                <span className="rounded bg-accent-wash px-2 py-0.5 text-[10px] font-bold text-accent">
                  实战指引
                </span>
              </div>
              {perspective === "candidate" ? <ul className="space-y-3 text-xs leading-relaxed text-muted">
                <li className="flex items-start gap-2.5">
                  <span className="shrink-0 whitespace-nowrap font-mono font-bold text-primary">01.</span>
                  <span><strong>逐题动态追问：</strong>面试官不仅就题论题，还会根据你的回答针对性追问技术底层与方案取舍。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="shrink-0 whitespace-nowrap font-mono font-bold text-primary">02.</span>
                  <span><strong>四维模拟反馈：</strong>按题型评价深度、结构、材料一致性与完整度；“真实性”分数不能核验事实真伪。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="shrink-0 whitespace-nowrap font-mono font-bold text-primary">03.</span>
                  <span><strong>三轮模拟练习：</strong>技术面 → 主管面 → HR 面，练习不同视角的问答，模拟反馈不代表真实招聘中的晋级结果。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="shrink-0 whitespace-nowrap font-mono font-bold text-accent">04.</span>
                  <span><strong>经历挖掘专线：</strong>只记得做过但说不清细节？选「经历挖掘」由访谈官逐层启发背景、行动、取舍与结果，产出待核实材料与简历草稿。</span>
                </li>
              </ul> : <ul className="space-y-3 text-xs leading-relaxed text-muted">
                <li><strong className="text-ink">逐轮补全：</strong>先生成主问题，再逐条扩展尚未完善的追问分支。</li>
                <li><strong className="text-ink">回答分支：</strong>每道问题最多展示两种预测回答及对应追问。</li>
                <li><strong className="text-ink">深度上限：</strong>追问最多延伸到第 3 层，整张图最多 7 道问题。</li>
                <li><strong className="text-ink">事实边界：</strong>预测回答仅供演练，简历未确认的职责和结果会标为待确认或假设。</li>
              </ul>}
            </div>

            <div className="rounded-xl border border-primary/20 bg-primary-soft/50 p-3.5 text-xs text-primary leading-relaxed">
              {perspective === "candidate"
                ? <>💡 <strong>作答建议：</strong>先回应题目要点，再按需要说明依据与取舍；经历题写清实际分工和验证状态。STAR 可选，无需为凑结构或字数补写经历。</>
                : <>💡 <strong>生成说明：</strong>图谱会保存在独立工作台的历史记录中，可随时载入并继续扩展；修改简历、JD 或风格后可重新生成。</>}
            </div>
          </div>
        </div>
      )}

      {error && <div role="alert" className={`mt-3 space-y-1 text-sm ${textErr}`}><p>{error}</p><p className="text-xs">{creationUncertain
        ? "响应异常或取消等待时仍可能已保存，请先核对历史记录再重新开始；历史读取失败可单独重试。"
        : "请根据错误原因核对材料或配置后重试；历史记录也会重新读取。"}</p></div>}
    </>
  );
}
