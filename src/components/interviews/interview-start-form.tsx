"use client";

import Link from "next/link";
import { Empty, Loading, LoadError } from "@/components/common/ui-bits";
import type { ResumeBrief } from "@/hooks/use-interviews-page";
import { ResumeVersionSelect } from "@/components/resume/resume-version-select";
import { INTERVIEW_STYLES, type InterviewStyleKey } from "@/lib/interview";
import { btnGhost, btnPrimary, inputCls, textareaCls, labelCls, textErr } from "@/lib/ui";

export type InterviewStartMode = "single" | "series";

export function InterviewStartForm({
  resumes,
  resumesError,
  onRetryResumes,
  mode,
  resumeId,
  resumeVersionId,
  jd,
  rounds,
  style,
  starting,
  applicationBound = false,
  error,
  displayedText,
  isTyping,
  onModeChange,
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
  resumeId: number | "";
  resumeVersionId: number | "";
  jd: string;
  rounds: number;
  style: InterviewStyleKey;
  starting: boolean;
  applicationBound?: boolean;
  error: string;
  displayedText: string;
  isTyping: boolean;
  onModeChange: (mode: InterviewStartMode) => void;
  onResumeIdChange: (id: number) => void;
  onResumeVersionIdChange: (id: number) => void;
  onJdChange: (jd: string) => void;
  onRoundsChange: (rounds: number) => void;
  onStyleChange: (style: InterviewStyleKey) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      {resumesError && <LoadError message={`简历列表加载失败：${resumesError}`} onRetry={onRetryResumes} />}
      {resumes === null ? (
        !resumesError && <Loading label="加载面试数据中…" />
      ) : resumes.length === 0 ? (
        <Empty action={<Link href="/resumes" className={btnPrimary}>创建或导入简历</Link>}>
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
                <span className="font-serif text-base font-bold text-ink">配置实战考场</span>
              </div>

              <div
                className="inline-flex rounded-xl border border-line bg-surface p-1 shadow-xs text-xs"
                role="group"
                aria-label="面试模式"
              >
                <button
                  type="button"
                  className={`rounded-lg px-3.5 py-1.5 font-medium transition-all ${
                    mode === "single"
                      ? "bg-card text-ink font-bold shadow-xs"
                      : "text-muted hover:text-ink"
                  }`}
                  onClick={() => onModeChange("single")}
                  aria-pressed={mode === "single"}
                >
                  单轮模考
                </button>
                <button
                  type="button"
                  className={`rounded-lg px-3.5 py-1.5 font-medium transition-all ${
                    mode === "series"
                      ? "bg-card text-ink font-bold shadow-xs"
                      : "text-muted hover:text-ink"
                  }`}
                  onClick={() => onModeChange("series")}
                  aria-pressed={mode === "series"}
                >
                  进阶三轮连打
                </button>
              </div>
            </div>

            {mode === "series" && (
              <div className="rounded-xl border border-accent/25 bg-accent-wash p-3.5 text-xs leading-relaxed text-ink">
                <span className="font-bold text-accent">三轮晋级机制：</span>
                一面 · 技术面（深度攻坚）→ 二面 · 主管面（架构权衡与系统设计）→ 三面 · HR 面（动机与团队协作）。
                前几轮表现与薄弱点会带入后轮，结束后生成跨轮综合总评。
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <label className="block">
                <span className={labelCls}>关联简历</span>
                <select
                  className={`${inputCls} mt-1`}
                  value={resumeId}
                  disabled={applicationBound || starting}
                  onChange={(event) => onResumeIdChange(Number(event.target.value))}
                >
                  {resumes.map((resume) => (
                    <option key={resume.id} value={resume.id}>
                      {resume.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelCls}>{mode === "series" ? "每轮题数" : "总题数"}</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  className={`${inputCls} mt-1 font-mono`}
                  value={rounds}
                  onChange={(event) => onRoundsChange(Number(event.target.value))}
                />
              </label>
              {mode === "single" && (
                <label className="block">
                  <span className={labelCls}>考官风格</span>
                  <select
                    className={`${inputCls} mt-1`}
                    value={style}
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
                onChange={(event) => onJdChange(event.target.value)}
                placeholder="直接粘贴目标岗位的任职要求、技术栈或核心职责..."
              />
            </label>

            <div className="flex items-center justify-between pt-2 border-t border-line/60">
              <span className="text-xs text-faint">
                {style === "mining" && mode === "single"
                  ? "提示：经历挖掘访谈官将启发式引导你梳理难点、决策与个人贡献"
                  : "提示：AI 将结合选定简历与 JD 针对性出题"}
              </span>
              <div className="flex items-center gap-2">
                {starting && (
                  <button type="button" className={btnGhost} onClick={onCancel}>
                    取消
                  </button>
                )}
                <button
                  type="button"
                  className={btnPrimary}
                  onClick={onStart}
                  disabled={starting || !jd.trim() || resumeId === "" || resumeVersionId === ""}
                >
                  {starting
                    ? "准备考场中…（正在命制首题）"
                    : mode === "series"
                    ? "开启进阶三轮连打"
                    : style === "mining"
                    ? "立即开启经历挖掘"
                    : "立即开启模拟实战"}
                </button>
              </div>
            </div>

            {starting && (
              <div className="mt-4 rounded-xl border border-primary/20 bg-primary-soft/50 p-4 animate-in fade-in duration-200">
                <div className="flex items-center gap-2 text-xs font-bold text-primary">
                  <span className="inline-block h-2 w-2 animate-ping rounded-full bg-primary" />
                  面试官思考中，首题拟定中…
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
                <h3 className="font-serif text-sm font-bold text-ink">考场战术与机制</h3>
                <span className="rounded bg-accent-wash px-2 py-0.5 text-[10px] font-bold text-accent">
                  实战指引
                </span>
              </div>
              <ul className="space-y-3 text-xs leading-relaxed text-muted">
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-primary">01.</span>
                  <span><strong>逐题动态追问：</strong>面试官不仅就题论题，还会根据你的回答针对性追问技术底层与方案取舍。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-primary">02.</span>
                  <span><strong>四维严谨批阅：</strong>作答后即刻批阅技术深度、结构表达、真实性与完整度四项小分。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-primary">03.</span>
                  <span><strong>三轮连打晋级：</strong>技术初试 → 主管复试 → HR 终面，模拟完整的大厂应聘通关全流程。</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-accent">04.</span>
                  <span><strong>经历挖掘专线：</strong>只记得做过但说不清细节？选「经历挖掘」由访谈官逐层启发背景、行动、取舍与结果，产出待核实材料与简历草稿。</span>
                </li>
              </ul>
            </div>

            <div className="rounded-xl border border-primary/20 bg-primary-soft/50 p-3.5 text-xs text-primary leading-relaxed">
              💡 <strong>通关技巧：</strong>作答时多讲“为什么这么设计”与“遇到了什么非预期 Bug 怎么排查”，比单纯罗列八股结论更具真实感。
            </div>
          </div>
        </div>
      )}

      {error && <p className={`mt-3 text-sm ${textErr}`}>{error}</p>}
    </>
  );
}
