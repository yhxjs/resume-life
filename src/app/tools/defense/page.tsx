"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { SectionTitle, Loading, Empty } from "@/components/common/ui-bits";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import { InlineError } from "@/components/common/inline-error";
import { alertDialog, confirmDialog } from "@/components/common/confirm-dialog";
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
  badgeDanger,
  badgeAccent,
  badgePrimary,
} from "@/lib/ui";
import type { RiskLevel } from "@/lib/resume-defense";
import { useResumeOptions } from "@/hooks/use-resume-options";
import { useResumeVersionSelection } from "@/hooks/use-resume-version-selection";
import { ResumeVersionSelect } from "@/components/resume/resume-version-select";
import { errorMessage } from "@/lib/error-message";

type DefenseHistoryItem = {
  id: number;
  resumeId: number | null;
  title: string;
  targetRole: string;
  riskLevel: RiskLevel;
  itemCount: number;
  createdAt: string;
};

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

function RiskLevelTag({ level }: { level: RiskLevel }) {
  if (level === "critical") {
    return <span className={badgeDanger}>⚠️ 极度高危 / 破绽百出</span>;
  }
  if (level === "high") {
    return <span className={badgeDanger}>🔥 疑点密集 / 重点追问</span>;
  }
  if (level === "medium") {
    return <span className={badgeAccent}>⚡ 局部软肋 / 需做预案</span>;
  }
  return <span className={badgePrimary}>✓ 相对严密 / 风险可控</span>;
}

export default function ResumeDefensePage() {
  return (
    <Suspense fallback={<Loading />}>
      <ResumeDefenseContent />
    </Suspense>
  );
}

function ResumeDefenseContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryResumeId = searchParams.get("resumeId");
  const queryResumeVersionId = searchParams.get("resumeVersionId");

  const [history, setHistory] = useState<DefenseHistoryItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const [mode, setMode] = useState<"resume" | "paste">("resume");
  const [selectedResumeId, setSelectedResumeId] = useState<string>("");
  const [pasteText, setPasteText] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);

  const { resumes, resumesError } = useResumeOptions(reloadVersion);
  const selectedResume = resumes?.find((resume) => String(resume.id) === selectedResumeId);
  const { resumeVersionId, setResumeVersionId } = useResumeVersionSelection(
    selectedResume,
    selectedResumeId === queryResumeId && queryResumeVersionId ? Number(queryResumeVersionId) : null,
  );

  // 简历列表就绪后确定选中项：URL 指定且存在则用之，否则落到第一份；一份都没有则切到粘贴模式。
  // 与拉取分离，避免 queryResumeId 变化时重取列表。
  // 这是「外部数据就绪 → 本地默认值」的一次性同步；规则针对的是渲染期级联重渲染，
  // 而此处只在 resumes 或 queryResumeId 变化时触发一次，故显式豁免该规则。
  useEffect(() => {
    if (!resumes) return;
    if (queryResumeId && resumes.some((r) => String(r.id) === queryResumeId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedResumeId(queryResumeId);
      setMode("resume");
    } else if (resumes.length > 0) {
      setSelectedResumeId(String(resumes[0]!.id));
    } else {
      setMode("paste");
    }
  }, [resumes, queryResumeId]);

  useEffect(() => {
    let cancelled = false;
    // 加载历史排雷记录
    jsonFetch<{ items: DefenseHistoryItem[] }>("/api/tools/resume-defenses")
      .then((res) => {
        if (cancelled) return;
        setHistory(res.items || []);
        setHistoryError("");
      })
      .catch((reason) => {
        if (!cancelled) setHistoryError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => { cancelled = true; };
  }, [queryResumeId, reloadVersion]);

  const resumeList = resumes ?? [];

  async function handleStartScan(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (mode === "resume" && (!selectedResumeId || !resumeVersionId)) {
      setError("请选择已发布的简历版本");
      return;
    }
    if (mode === "paste" && !pasteText.trim()) {
      setError("请粘贴要排雷的简历文本片段");
      return;
    }

    setScanning(true);

    try {
      const payload: Record<string, unknown> = {
        targetRole: targetRole.trim(),
      };
      if (mode === "resume") {
        payload.resumeId = Number(selectedResumeId);
        payload.resume_version_id = resumeVersionId;
      } else {
        payload.resumeContent = pasteText.trim();
      }

      const res = await jsonFetch<{ id: number }>("/api/tools/resume-defenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      router.push(`/tools/defense/${res.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setScanning(false);
    }
  }

  function fillSample() {
    setMode("paste");
    setPasteText(SAMPLE_RESUME_TEXT);
    setTargetRole("大厂资深后端 / 全栈架构师 (P7/T8)");
  }

  async function handleDeleteHistory(id: number) {
    if (
      !(await confirmDialog({
        title: "删除排雷报告",
        message: "确定删除这份简历排雷报告吗？删除后相关防御演练记录将一并清除。",
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await jsonFetch(`/api/tools/resume-defenses/${id}`, { method: "DELETE" });
      setHistory((prev) => prev.filter((item) => item.id !== id));
    } catch (err) {
      await alertDialog({
        title: "删除失败",
        message: errorMessage(err),
      });
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      {/* 顶部标题栏 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">
            简历排雷与防御演练
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            让 AI 扮演毒舌大厂技术面试官，逐字逐行深挖简历软肋，揪出假大空、无基数数据疑点与术语堆砌，并量身定制攻防自辩预案。
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={fillSample}
            className={`${btnGhost} text-xs cursor-pointer border border-line`}
          >
            填入典型高危样例
          </button>
        </div>
      </div>

      {/* 特色横幅 */}
      <div className="rounded-2xl border border-line bg-card p-5 shadow-card-subtle grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
        <div className="space-y-1.5 p-3 rounded-xl bg-danger-wash/40 border border-danger/15">
          <div className="font-bold text-danger flex items-center gap-1.5">
            <span>🤬 毒舌挑剔扫描</span>
          </div>
          <p className="text-muted leading-relaxed">
            告别温和客套！模拟大厂最严格的高工视角，专门戳破“提升300%”、“主导重构”等水词泡沫。
          </p>
        </div>
        <div className="space-y-1.5 p-3 rounded-xl bg-accent-wash/40 border border-accent/15">
          <div className="font-bold text-accent flex items-center gap-1.5">
            <span>🎯 致命连环追问</span>
          </div>
          <p className="text-muted leading-relaxed">
            预测面试官现场大概率深挖死穴的 2-3 个连环问题，提前准备好技术选型权衡与基线指标。
          </p>
        </div>
        <div className="space-y-1.5 p-3 rounded-xl bg-primary-soft/40 border border-primary/15">
          <div className="font-bold text-primary flex items-center gap-1.5">
            <span>🛡️ 抽屉即问即评</span>
          </div>
          <p className="text-muted leading-relaxed">
            点击任意高危坑点直接滑出抽屉进行文字自辩对练，面试官现场打分批改，传授满分防御口径。
          </p>
        </div>
      </div>

      {/* 排雷发起表单 */}
      <div className={`relative ${cardCls} p-6 sm:p-7 space-y-6`}>
        <LoadingOverlay
          show={scanning}
          message="AI 毒舌面试官正在深度排雷中…"
          description="正在深挖假大空话术、无基数数据疑点与技术软肋，生成攻防自辩预案，请稍候…"
        />
        <div className="flex items-center justify-between border-b border-line pb-4">
          <SectionTitle>发起简历排雷体检</SectionTitle>
          <div className="flex items-center rounded-lg border border-line p-0.5 bg-surface text-xs">
            <button
              type="button"
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
                  onChange={(e) => setSelectedResumeId(e.target.value)}
                  className={inputCls}
                >
                  {resumeList.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="p-4 rounded-xl border border-dashed border-line text-xs text-muted text-center space-y-2">
                  <p>暂无已保存的简历，你可以切换到“自由粘贴文本”模式直接排雷</p>
                  <button
                    type="button"
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
                  onRetry={() => setReloadVersion((version) => version + 1)}
                />
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className={labelCls}>粘贴简历内容或项目片段：</label>
                <span className="text-[11px] text-faint">支持整份简历或单个高风险项目段落</span>
              </div>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="粘贴简历文本（包括个人介绍、工作经历、项目经历、技术栈等）..."
                className={`${textareaTallCls} font-mono text-xs`}
              />
            </div>
          )}

          {/* 目标岗位 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className={labelCls}>目标应聘岗位 / 级别定位（选填）：</label>
              <span className="text-[11px] text-faint">填写大厂级别，面试官毒舌挑刺更具针对性</span>
            </div>
            <input
              type="text"
              value={targetRole}
              onChange={(e) => setTargetRole(e.target.value)}
              placeholder="例如：字节跳动电商资深前端工程师 (2-2) / 腾讯微信后端技术专家"
              className={inputCls}
            />
          </div>

          {error && <p className={textErr}>{error}</p>}

          <div className="flex items-center justify-end pt-2">
            <button
              type="submit"
              disabled={scanning || (mode === "resume" ? !selectedResumeId || !resumeVersionId : !pasteText.trim())}
              className={`${btnPrimary} min-w-[150px] cursor-pointer`}
            >
              {scanning ? (
                <>
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-on-primary" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  <span>毒舌排雷扫描中…</span>
                </>
              ) : (
                "开始毒舌排雷扫描 💣"
              )}
            </button>
          </div>
        </form>
      </div>

      {/* 历史排雷记录 */}
      <div className="space-y-4">
        <SectionTitle count={history.length}>排雷体检历史档案</SectionTitle>

        {loadingHistory ? (
          <Loading label="加载排雷历史…" />
        ) : historyError ? (
          <InlineError
            message={`排雷历史加载失败：${historyError}`}
            onRetry={() => setReloadVersion((version) => version + 1)}
          />
        ) : history.length === 0 ? (
          <Empty>暂无简历排雷记录，快发起第一次毒舌体检吧</Empty>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {history.map((h) => (
              <div
                key={h.id}
                className={`${cardCls} p-4.5 hover:border-primary/60 transition-all hover:shadow-card-float flex flex-col justify-between group`}
              >
                <Link href={`/tools/defense/${h.id}`} className="space-y-2 block">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-serif text-base font-bold text-ink group-hover:text-primary transition-colors line-clamp-1">
                      {h.title}
                    </span>
                    <RiskLevelTag level={h.riskLevel} />
                  </div>
                  {h.targetRole && (
                    <p className="text-xs text-muted flex items-center gap-1.5">
                      <span className="text-faint">目标定位:</span>
                      <span className="font-medium text-ink">{h.targetRole}</span>
                    </p>
                  )}
                </Link>

                <div className="mt-4 pt-3 border-t border-line/60 flex items-center justify-between text-xs text-faint">
                  <span>抓出 <b className="text-ink font-mono">{h.itemCount}</b> 处高危软肋</span>
                  <div className="flex items-center gap-3">
                    <span>{new Date(h.createdAt).toLocaleDateString()}</span>
                    <button
                      type="button"
                      onClick={() => handleDeleteHistory(h.id)}
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
