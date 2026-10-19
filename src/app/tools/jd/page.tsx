"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { confirmDialog, alertDialog } from "@/components/common/confirm-dialog";
import { jsonFetch } from "@/lib/fetcher";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import { parseJdPortraitResult } from "@/lib/jd-portrait";
import { btnDanger, btnPrimary, textareaTallCls } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { useCursorList } from "@/hooks/use-cursor-list";

type PortraitItem = {
  id: number;
  jd: string;
  result: string;
  created_at: string;
};

/** 列表行标题：优先岗位速写，缺失时退回 JD 首行 */
function itemTitle(it: PortraitItem): string {
  const result = parseJdPortraitResult(it.result);
  if (result?.role) return result.role;
  const firstLine = it.jd.split("\n").find((l) => l.trim()) ?? "";
  return firstLine.slice(0, 50) || "（无 JD）";
}

const SAMPLE_JDS = [
  {
    label: "大厂资深前端/架构",
    text: `【岗位职责】
1. 负责核心中后台及低代码平台的技术架构设计与性能攻坚；
2. 负责前端工程化体系建设（规范、CI/CD、自动化测试、监控告警体系）；
3. 主导跨团队复杂业务协同，保障高可用与卓越的用户体验。

【任职要求】
1. 本科及以上学历，5年以上前端开发经验，深入理解 React/Vue 核心源码与设计思想；
2. 精通 TypeScript、前端工程化与性能优化链路，有微前端或大型 monorepo 落地经验者优先；
3. 具备强烈的技术自驱力，良好的跨团队沟通与架构抽象能力。`,
  },
  {
    label: "高并发分布式后端",
    text: `【岗位职责】
1. 负责亿级高并发交易链路的核心系统设计、架构演进与稳定性保障；
2. 攻克高可用、高扩展性技术难关，解决分布式一致性与容灾容错难题；
3. 参与关键技术预研与沉淀，持续提升系统的可观测性与吞吐量。

【任职要求】
1. 计算机相关专业本科以上，深入理解 Java/Go 底层原理与 JVM 调优机制；
2. 熟练掌握 MySQL 分库分表、Redis、Kafka/RocketMQ 及主流分布式框架；
3. 具备大促保障、线上复杂故障定位与性能攻坚经验，思维严密、追求卓越。`,
  },
  {
    label: "AI+全栈应用开发",
    text: `【岗位职责】
1. 负责 AI Agent 应用及知识库问答系统的端到端功能研发与交互落地；
2. 协同算法团队完成大模型 Prompt 调优、RAG 向量检索工程化与全链路链路评测；
3. 快速试错并敏捷交付业务闭环，持续探索 AI 与生产力工具的深度融合。

【任职要求】
1. 熟练掌握 Next.js / React / Node.js 或 Python 全栈开发能力；
2. 熟悉主流 LLM API 协议、LangChain/LlamaIndex 或向量数据库使用；
3. 拥有极强的产品感知与动手能力，能独立从 0 到 1 交付可用产品原型。`,
  },
];

export default function JdPortraitPage() {
  const router = useRouter();
  const { items, total, nextCursor, loadingMore, listError: loadError, failedCursor, loadMore, reload } = useCursorList<PortraitItem>({
    queryKey: "jd-portraits",
    buildUrl: (cursor) => `/api/tools/jd-portraits?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    delay: 0,
  });
  const [jd, setJd] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  async function generate() {
    if (!jd.trim()) return;
    setGenerating(true);
    setError("");
    try {
      const data = await jsonFetch<{ id: number }>("/api/tools/jd-portraits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jd: jd.trim() }),
      });
      router.push(`/tools/jd/${data.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setGenerating(false);
    }
  }

  async function remove(id: number) {
    if (!(await confirmDialog({ title: "删除记录", message: "确定删除这份考点画像？", danger: true }))) return;
    try {
      await jsonFetch(`/api/tools/jd-portraits/${id}`, { method: "DELETE" });
    } catch (err) {
      await alertDialog({ title: "删除失败", message: errorMessage(err) });
      return;
    }
    reload();
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      {/* 顶部标题栏 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">
            JD 考点画像
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            粘贴一段岗位要求，AI 解析出这场面试的考点雷达：必考技能、可能追问方向与公司风格猜测，考前面一遍心里有底。
          </p>
        </div>
        {items !== null && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>已载入画像存档：<strong className="font-mono text-ink font-bold text-sm">{items.length}</strong> 份{total !== null && ` / 共 ${total} 份`}</span>
          </div>
        )}
      </div>

      {/* 生成输入卡片 */}
      <div className="relative rounded-2xl border border-line bg-card p-6 shadow-card-subtle space-y-4">
        <LoadingOverlay
          show={generating}
          message="AI 正在深度解析 JD 考点雷达…"
          description="正在拆解核心必考技术栈、高频追问方向与企业技术文化，约需 15-20 秒，请稍候…"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 pb-3">
          <div className="flex items-center gap-2">
            <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
            <h2 className="text-sm font-serif font-bold text-ink">输入岗位招聘要求 (JD)</h2>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">填入范例：</span>
            {SAMPLE_JDS.map((sample, idx) => (
              <span key={sample.label} className="flex items-center gap-1">
                {idx > 0 && <span className="text-faint">·</span>}
                <button
                  type="button"
                  onClick={() => setJd(sample.text)}
                  className="text-primary hover:underline font-medium"
                >
                  {sample.label}
                </button>
              </span>
            ))}
          </div>
        </div>

        <label className="block">
          <textarea
            className={`${textareaTallCls} font-sans text-xs sm:text-sm`}
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            placeholder="粘贴目标岗位的职责与任职要求，AI 将据此解析必考技能权重、深度追问方向与公司技术文化推测…"
          />
        </label>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <span className="text-xs text-muted">
            {jd.trim().length > 0 ? `已输入 ${jd.trim().length} 字，点击即可全景拆解` : "支持直接粘贴各大招聘平台完整 JD 文本"}
          </span>
          <button
            className={btnPrimary}
            onClick={generate}
            disabled={generating || !jd.trim()}
          >
            {generating ? "AI 深度解析考点中（约需 15-20 秒）…" : "生成考点画像雷达 →"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger-wash p-4 text-xs text-danger">
          {error}
        </div>
      )}
      {/* 历史画像卡片网格 */}
      <div className="space-y-4 pt-2">
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
          <h2 className="font-serif text-base font-bold text-ink">历史考点画像记录</h2>
        </div>

        {loadError && <LoadError message={`画像历史加载失败：${loadError}`} onRetry={failedCursor === null ? reload : loadMore} />}
        {items === null ? (
          !loadError && <Loading label="正在加载画像历史…" />
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line p-8 text-center text-xs text-muted bg-surface/30">
            还没有画像记录：贴上一段岗位 JD，生成你的第一份考点雷达吧
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {items.map((it) => {
              const parsed = parseJdPortraitResult(it.result);
              return (
                <div
                  key={it.id}
                  className="group flex flex-col justify-between rounded-2xl border border-line bg-card p-5 shadow-card-subtle transition-all duration-200 hover:border-primary/50 hover:bg-surface/30"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/tools/jd/${it.id}`}
                        className="font-serif text-base font-bold text-ink hover:text-primary transition-colors line-clamp-1"
                      >
                        {itemTitle(it)}
                      </Link>
                      <span className="shrink-0 rounded-full border border-primary/20 bg-primary-soft px-2.5 py-0.5 text-[10px] font-medium text-primary">
                        考点雷达
                      </span>
                    </div>

                    {parsed?.mustSkills && parsed.mustSkills.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {parsed.mustSkills.slice(0, 4).map((s) => (
                          <span
                            key={s.name}
                            className="rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-[10px] text-muted"
                          >
                            {s.name} · {s.weight}分
                          </span>
                        ))}
                      </div>
                    )}

                    <p className="text-xs text-muted line-clamp-2 leading-relaxed">
                      {it.jd.split("\n").filter(Boolean)[0] || "无原始描述"}
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
                      <Link href={`/tools/jd/${it.id}`} className={btnPrimary}>
                        查看雷达
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {nextCursor && (
          <div className="flex justify-center pt-2">
            <button type="button" className={btnPrimary} onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "加载中…" : failedCursor === nextCursor ? "重试加载更多" : "加载更多"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
