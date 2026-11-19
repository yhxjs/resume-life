"use client";

import { Suspense, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { SectionTitle, Loading, Empty } from "@/components/common/ui-bits";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import { InlineError } from "@/components/common/inline-error";
import { ToolHistoryDeletionFeedback } from "@/components/common/tool-history-deletion-feedback";
import { useToolHistoryDeletion } from "@/hooks/use-tool-history-deletion";
import { jsonFetch } from "@/lib/fetcher";
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  cardCls,
  inputCls,
  textareaTallCls,
  labelCls,
  textErr,
} from "@/lib/ui";
import { DefenseRiskLevelTag } from "@/components/defense/defense-badges";
import { useResumeOptions } from "@/hooks/use-resume-options";
import { useResumeVersionSelection } from "@/hooks/use-resume-version-selection";
import { ResumeVersionSelect } from "@/components/resume/resume-version-select";
import { errorMessage } from "@/lib/error-message";

type DefenseHistoryItem = {
  id: number;
  resumeId?: number | null;
  title: string;
  targetRole: string;
  riskLevel?: string | null;
  itemCount: number;
  createdAt: string;
};

function readHistory(value: unknown): DefenseHistoryItem[] {
  const items = value && typeof value === "object" ? (value as { items?: unknown }).items : null;
  if (!Array.isArray(items)) throw new Error("排雷历史响应不完整，请重新读取");
  const ids = new Set<number>();
  for (const item of items) {
    if (!item || typeof item !== "object" || !Number.isSafeInteger(item.id) || item.id <= 0 || ids.has(item.id) ||
      (item.resumeId !== undefined && item.resumeId !== null && (!Number.isSafeInteger(item.resumeId) || item.resumeId <= 0)) ||
      typeof item.title !== "string" || typeof item.targetRole !== "string" || typeof item.createdAt !== "string" ||
      (item.riskLevel !== undefined && item.riskLevel !== null && typeof item.riskLevel !== "string") ||
      !Number.isSafeInteger(item.itemCount) || item.itemCount < 0) {
      throw new Error("排雷历史响应不完整或存在重复记录，请重新读取");
    }
    ids.add(item.id);
  }
  return items as DefenseHistoryItem[];
}

const SAMPLE_RESUME_TEXT = `# 个人简历 - 张工 (资深全栈工程师)

## 个人简介
具备深厚的技术架构能力，思维活跃，熟悉高并发与微服务体系。深度参与业务全流程，抗压能力强，主导了多次团队核心系统的性能优化。

## 专业技能
- 熟练掌握 Java, Go, React, Vue, Spring Cloud, Kubernetes, Kafka, Redis, RocketMQ, MySQL, ES。
- 精通微服务架构设计与分库分表，具备从 0 到 1 搭建高可用分布式系统的丰富经验。

## 工作经历 (2021.06 - 至今 · 某知名互联网科技公司 · 高级研发工程师)
- 负责核心电商交易系统架构重构，全面优化了系统并发性能与代码可维护性。
- 通过引入 Redis 缓存与分布式消息队列，大幅提升系统吞吐量，接口响应速度提升 300%，支撑了多次大促活动。
- 协同大数据团队完成用户行为中台搭建，极大改善了数据交付效率，深受领导与业务方好评。

## 项目经历 (2022.03 - 2023.01 · 分布式低代码平台)
- 作为项目核心骨干，攻克了动态表单渲染与流程编排中的诸多技术难题，代码健壮性显著提高。
- 深度参与系统解耦与数据库慢查询调优，系统崩溃率降低 85%，获得部门季度技术创新奖。`;

export default function ResumeDefensePage() {
  return (
    <Suspense fallback={<Loading />}>
      <ResumeDefenseEntry />
    </Suspense>
  );
}

function ResumeDefenseEntry() {
  const searchParams = useSearchParams();
  const queryResumeId = searchParams.get("resumeId");
  const queryResumeVersionId = searchParams.get("resumeVersionId");
  return <ResumeDefenseContent key={JSON.stringify([queryResumeId, queryResumeVersionId])}
    queryResumeId={queryResumeId} queryResumeVersionId={queryResumeVersionId} />;
}

function ResumeDefenseContent({ queryResumeId, queryResumeVersionId }: {
  queryResumeId: string | null;
  queryResumeVersionId: string | null;
}) {
  const router = useRouter();
  const pasteInputId = useId();
  const targetRoleId = useId();
  const mounted = useRef(false);
  const generation = useRef<AbortController | null>(null);
  const historyRequest = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current?.abort(); generation.current = null;
      historyRequest.current?.abort(); historyRequest.current = null;
    };
  }, []);

  const [history, setHistory] = useState<DefenseHistoryItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const [mode, setMode] = useState<"resume" | "paste">("resume");
  const [selection, setSelection] = useState<{ id: number | "" } | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyAttempt, setHistoryAttempt] = useState(0);

  const { resumes, resumesError, reloadResumes } = useResumeOptions();
  const candidate = selection ? selection.id
    : queryResumeId !== null ? Number(queryResumeId)
      : queryResumeVersionId !== null ? "" : resumes?.[0]?.id ?? "";
  const selectedResume = typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0
    ? resumes?.find((resume) => resume.id === candidate) : undefined;
  const selectedResumeId = selectedResume ? String(selectedResume.id) : "";
  const { resumeVersionId, setResumeVersionId } = useResumeVersionSelection(
    selectedResume,
    queryResumeId !== null && selectedResume?.id === Number(queryResumeId) && queryResumeVersionId !== null
      ? Number(queryResumeVersionId) : null,
  );
  const validMaterials = Boolean(selectedResume?.versions.some((version) => version.id === resumeVersionId));
  const missingMaterials = resumes !== null && (candidate !== "" && !selectedResume
    ? "指定或已选的简历不在当前列表中，请重新读取或手动选择。"
    : selectedResume && !validMaterials
      ? "指定或已选的发布版不可用，请重新读取或选择已发布版本。"
      : queryResumeVersionId !== null && !selectedResume ? "请先选择该发布版本所属的简历。" : "");

  // 固定首次候选；刷新不替换手选材料，指定简历暂时消失后仍可原位恢复。
  useEffect(() => {
    if (resumes === null || selection !== null || (candidate === "" && queryResumeId === null && queryResumeVersionId === null)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelection({ id: candidate });
  }, [resumes, selection, candidate, queryResumeId, queryResumeVersionId]);

  const reloadHistory = useCallback(() => {
    if (!mounted.current) return;
    historyRequest.current?.abort(); historyRequest.current = null;
    setLoadingHistory(true); setHistoryError("");
    setHistoryAttempt((attempt) => attempt + 1);
  }, []);
  const deletion = useToolHistoryDeletion("resume-defenses", reloadHistory);
  const visibleHistory = history.filter((item) => !deletion.deletedIds.has(item.id));

  useEffect(() => {
    const controller = new AbortController();
    historyRequest.current = controller;
    const isCurrent = () => mounted.current && historyRequest.current === controller && !controller.signal.aborted;
    jsonFetch<unknown>("/api/tools/resume-defenses", { signal: controller.signal, cache: "no-store" })
      .then((res) => {
        if (!isCurrent()) return;
        setHistory(readHistory(res));
        setHistoryError("");
      })
      .catch((reason) => {
        if (isCurrent()) setHistoryError(errorMessage(reason));
      })
      .finally(() => {
        if (isCurrent()) { setLoadingHistory(false); historyRequest.current = null; }
      });
    return () => {
      controller.abort();
      if (historyRequest.current === controller) historyRequest.current = null;
    };
  }, [historyAttempt]);

  const resumeList = resumes ?? [];

  async function handleStartScan(e: React.FormEvent) {
    e.preventDefault();
    if (!mounted.current || generation.current) return;
    setError("");

    if (mode === "resume" && !validMaterials) {
      setError("请选择已发布的简历版本");
      return;
    }
    if (mode === "paste" && !pasteText.trim()) {
      setError("请粘贴要排雷的简历文本片段");
      return;
    }

    const controller = new AbortController();
    generation.current = controller;
    const isCurrent = () => mounted.current && generation.current === controller && !controller.signal.aborted;
    setScanning(true);

    try {
      const payload: Record<string, unknown> = {
        targetRole: targetRole.trim(),
      };
      if (mode === "resume") {
        payload.resumeId = selectedResume!.id;
        payload.resume_version_id = resumeVersionId;
      } else {
        payload.resumeContent = pasteText.trim();
      }

      const res = await jsonFetch<unknown>("/api/tools/resume-defenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      const id = res && typeof res === "object" ? (res as { id?: unknown }).id : undefined;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("生成响应不完整，请先核对历史记录是否已保存");
      router.push(`/tools/defense/${id}`);
    } catch (err) {
      if (!isCurrent()) return;
      generation.current = null;
      setError(errorMessage(err));
      setScanning(false);
      reloadHistory();
    }
  }

  function fillSample() {
    if (!mounted.current || generation.current) return;
    setMode("paste");
    setPasteText(SAMPLE_RESUME_TEXT);
    setTargetRole("大厂资深后端 / 全栈架构师 (P7/T8)");
  }

  return (
    <div className="mx-auto min-w-0 max-w-6xl space-y-8 [overflow-wrap:anywhere]">
      {/* 顶部标题栏 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">
            简历排雷与防御演练
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            结合简历全文核对表述依据、数据口径与个人分工，整理需要澄清的问题，并基于真实经历练习回答。
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={fillSample}
            disabled={scanning}
            className={`${btnGhost} text-xs cursor-pointer border border-line`}
          >
            填入练习样例
          </button>
        </div>
      </div>

      {/* 特色横幅 */}
      <div className="rounded-2xl border border-line bg-card p-5 shadow-card-subtle grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
        <div className="space-y-1.5 p-3 rounded-xl bg-danger-wash/40 border border-danger/15">
          <div className="font-bold text-danger flex items-center gap-1.5">
            <span>🔎 有依据的表述审阅</span>
          </div>
          <p className="text-muted leading-relaxed">
            结合上下文判断职责和数据是否说明清楚；缺少指标属于待核实，不据此认定造假。
          </p>
        </div>
        <div className="space-y-1.5 p-3 rounded-xl bg-accent-wash/40 border border-accent/15">
          <div className="font-bold text-accent flex items-center gap-1.5">
            <span>🎯 具体追问练习</span>
          </div>
          <p className="text-muted leading-relaxed">
            针对具体待澄清信息提供追问供练习，不预测真实面试官心理，也不把所有问题都套成架构选型或量化题。
          </p>
        </div>
        <div className="space-y-1.5 p-3 rounded-xl bg-primary-soft/40 border border-primary/15">
          <div className="font-bold text-primary flex items-center gap-1.5">
            <span>🛡️ 抽屉即问即评</span>
          </div>
          <p className="text-muted leading-relaxed">
            选择条目即可练习回答并获得反馈；参考方案不是经历证据，应按实际分工调整，不保证满分。
          </p>
        </div>
      </div>

      {/* 排雷发起表单 */}
      <div className={`relative ${cardCls} p-6 sm:p-7 space-y-6`}>
        <LoadingOverlay
          show={scanning}
          message="正在审阅简历表述…"
          description="正在结合全文核对表述依据，并整理待核实问题与练习参考，请稍候…"
        />
        <div className="flex flex-col items-start gap-3 border-b border-line pb-4 sm:flex-row sm:items-center sm:justify-between">
          <SectionTitle>发起简历排雷体检</SectionTitle>
          <div className="flex items-center rounded-lg border border-line p-0.5 bg-surface text-xs">
            <button
              type="button"
              disabled={scanning}
              onClick={() => setMode("resume")}
              className={`rounded-md px-3 py-1 font-medium transition-colors cursor-pointer ${
                mode === "resume"
                  ? "bg-card text-ink shadow-xs"
                  : "text-muted hover:text-ink"
              }`}
            >
              已有简历
            </button>
            <button
              type="button"
              disabled={scanning}
              onClick={() => setMode("paste")}
              className={`rounded-md px-3 py-1 font-medium transition-colors cursor-pointer ${
                mode === "paste"
                  ? "bg-card text-ink shadow-xs"
                  : "text-muted hover:text-ink"
              }`}
            >
              自由粘贴文本
            </button>
          </div>
        </div>

        <form onSubmit={handleStartScan} className="space-y-5">
          {mode === "resume" ? (
            <div className="space-y-2">
              <label className={labelCls}>选择要体检排雷的简历：</label>
              {resumeList.length > 0 ? (
                <select
                  value={selectedResumeId}
                  aria-label="选择要体检排雷的简历"
                  disabled={scanning}
                  onChange={(e) => setSelection({ id: e.target.value ? Number(e.target.value) : "" })}
                  className={inputCls}
                >
                  {!selectedResumeId && <option value="" disabled>请选择可用简历</option>}
                  {resumeList.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                    </option>
                  ))}
                </select>
              ) : resumes === null ? (
                !resumesError && <Loading label="读取已保存简历…" />
              ) : (
                <div className="p-4 rounded-xl border border-dashed border-line text-xs text-muted text-center space-y-2">
                  <p>暂无已保存的简历，你可以切换到“自由粘贴文本”模式直接排雷</p>
                  <button
                    type="button"
                    disabled={scanning}
                    onClick={() => setMode("paste")}
                    className={`${btnGhost} text-xs py-1 px-3 cursor-pointer`}
                  >
                    切换为粘贴模式
                  </button>
                </div>
              )}
              <ResumeVersionSelect resume={selectedResume} value={resumeVersionId} onChange={setResumeVersionId} disabled={scanning} />
              {resumesError && (
                <InlineError
                  message={`简历列表加载失败：${resumesError}`}
                  onRetry={reloadResumes}
                />
              )}
              {missingMaterials && <div role="alert" className={`space-y-2 text-xs ${textErr}`}>
                <p>{missingMaterials}</p>
                <button type="button" className={btnGhost} disabled={scanning} onClick={reloadResumes}>重新读取简历列表</button>
              </div>}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between">
                <label htmlFor={pasteInputId} className={labelCls}>粘贴简历内容或项目片段：</label>
                <span className="text-[11px] text-faint">支持整份简历或需要核对的项目段落</span>
              </div>
              <textarea
                id={pasteInputId}
                value={pasteText}
                disabled={scanning}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="粘贴简历文本（包括个人介绍、工作经历、项目经历、技术栈等）..."
                className={`${textareaTallCls} font-mono text-xs`}
              />
            </div>
          )}

          {/* 目标岗位 */}
          <div className="space-y-2">
            <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between">
              <label htmlFor={targetRoleId} className={labelCls}>目标应聘岗位 / 级别定位（选填）：</label>
              <span className="text-[11px] text-faint">用于安排准备优先级，不作为经历证据</span>
            </div>
            <input
              id={targetRoleId}
              type="text"
              value={targetRole}
              disabled={scanning}
              onChange={(e) => setTargetRole(e.target.value)}
              placeholder="例如：字节跳动电商资深前端工程师 (2-2) / 腾讯微信后端技术专家"
              className={inputCls}
            />
          </div>

          {error && <p role="alert" className={textErr}>{error}</p>}
          {error && <p role="status" className="text-xs leading-relaxed text-muted">响应异常时仍可能已保存，请先核对下方历史再决定是否重新扫描；历史读取失败时可单独重试。</p>}

          <div className="flex items-center justify-end pt-2">
            <button
              type="submit"
              disabled={scanning || (mode === "resume" ? !validMaterials : !pasteText.trim())}
              className={`${btnPrimary} min-w-[150px] cursor-pointer`}
            >
              {scanning ? (
                <>
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-on-primary" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  <span>正在审阅简历…</span>
                </>
              ) : (
                "开始简历排雷扫描"
              )}
            </button>
          </div>
        </form>
      </div>

      {/* 历史排雷记录 */}
      <div className="space-y-4">
        <SectionTitle count={visibleHistory.length}>排雷体检历史档案</SectionTitle>
        <ToolHistoryDeletionFeedback deletion={deletion} />

        {loadingHistory && <Loading label="加载排雷历史…" />}
        {historyError && (
          <InlineError
            message={`排雷历史加载失败：${historyError}`}
            onRetry={reloadHistory}
          />
        )}
        {!loadingHistory && !historyError && visibleHistory.length === 0 && (
          <Empty>暂无简历排雷记录，可以先选择简历或粘贴原文</Empty>
        )}
        {visibleHistory.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {visibleHistory.map((h) => (
              <div
                key={h.id}
                className={`${cardCls} p-4.5 hover:border-primary/60 transition-all hover:shadow-card-float flex flex-col justify-between group`}
              >
                <Link href={`/tools/defense/${h.id}`} className="space-y-2 block">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 flex-1 font-serif text-base font-bold text-ink group-hover:text-primary transition-colors line-clamp-1">
                      {h.title}
                    </span>
                    <span className="shrink-0 whitespace-nowrap"><DefenseRiskLevelTag level={h.riskLevel} /></span>
                  </div>
                  {h.targetRole && (
                    <p className="text-xs text-muted flex items-start gap-1.5">
                      <span className="shrink-0 text-faint">目标定位:</span>
                      <span className="min-w-0 flex-1 font-medium text-ink">{h.targetRole}</span>
                    </p>
                  )}
                </Link>

                <div className="mt-4 pt-3 border-t border-line/60 flex items-center justify-between text-xs text-faint">
                  <span><b className="text-ink font-mono">{h.itemCount}</b> 条待核实表述</span>
                  <div className="flex items-center gap-3">
                    <span>{new Date(h.createdAt).toLocaleDateString()}</span>
                    <button
                      type="button"
                      onClick={() => void deletion.remove(h.id, h.title)}
                      disabled={deletion.busy}
                      className={`${btnDanger} text-xs py-1 px-2.5 cursor-pointer`}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
