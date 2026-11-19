"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { alertDialog } from "@/components/common/confirm-dialog";
import { ToolHistoryDeletionFeedback } from "@/components/common/tool-history-deletion-feedback";
import { Empty, Loading, LoadError } from "@/components/common/ui-bits";
import { useRouter } from "next/navigation";
import { jsonFetch } from "@/lib/fetcher";
import { btnPrimary, inputCls, labelCls } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { readProjectList, type ProjectListItem } from "@/lib/project-history";
import { useProjectDeletion } from "@/hooks/use-project-deletion";

export default function KnowledgePage() {
  const router = useRouter();
  const [items, setItems] = useState<ProjectListItem[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const nameRef = useRef(name);
  const pageSession = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const deletion = useProjectDeletion(retryLoad);
  const visibleItems = items?.filter(item => !deletion.deletedIds.has(item.id)) ?? null;
  const locked = creating || deletion.busy;

  useLayoutEffect(() => {
    const controller = new AbortController(); pageSession.current = controller;
    return () => { controller.abort(); if (pageSession.current === controller) pageSession.current = null; };
  }, []);
  function isCurrent(session: AbortController) { return pageSession.current === session && !session.signal.aborted; }

  function retryLoad() {
    if (!pageSession.current || pageSession.current.signal.aborted) return;
    setLoadError("");
    setLoadAttempt((attempt) => attempt + 1);
  }

  useEffect(() => {
    const controller = new AbortController();
    jsonFetch<unknown>("/api/projects", { signal: controller.signal, cache: "no-store" })
      .then((data) => {
        if (!controller.signal.aborted) {
          setItems(readProjectList(data));
          setLoadError("");
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(err));
      });
    return () => {
      controller.abort();
    };
  }, [loadAttempt]);

  async function create() {
    const session = pageSession.current; const projectName = nameRef.current.trim();
    if (!session || !isCurrent(session) || mutation.current || !deletion.canStart() || !projectName) return;
    mutation.current = true;
    setCreating(true);
    try {
      const data = await jsonFetch<{ id: number }>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projectName }), signal: session.signal,
      });
      if (!isCurrent(session)) return;
      if (!data || !Number.isSafeInteger(data.id) || data.id <= 0) throw new Error("创建项目响应不完整，请先核对项目目录再决定是否重新创建");
      router.push(`/knowledge/${data.id}`);
    } catch (err) {
      if (!isCurrent(session)) return;
      await alertDialog({ title: "创建失败", message: errorMessage(err), signal: session.signal });
      if (!isCurrent(session)) return;
      mutation.current = false;
      setCreating(false);
    }
  }

  function remove(id: number) {
    if (mutation.current || !deletion.canStart()) return;
    const item = visibleItems?.find(item => item.id === id);
    if (item) void deletion.remove(item);
  }

  return (
    <div className="mx-auto min-w-0 max-w-7xl space-y-8 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">技术项目知识库</h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            沉淀真实架构设计文档与上线复盘材料，AI 自动提炼 STAR 条目与技术亮点，支撑简历一键摘取与深度考题生成。
          </p>
        </div>
      </div>

      {/* 快速新建项目卡片 */}
      <div className="rounded-2xl border border-line bg-card p-5 shadow-card-subtle flex flex-col sm:flex-row items-center justify-between gap-4 bg-grain">
        <div className="space-y-1 w-full sm:w-auto">
          <div className="flex items-center gap-2">
            <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
            <span className="font-serif font-bold text-sm text-ink">建立新项目档案</span>
          </div>
          <p className="text-xs text-muted">录入项目名称，随后导入架构方案或故障复盘，打造应聘深度硬核谈资</p>
        </div>
        <div className="flex w-full sm:w-auto items-end gap-2.5">
          <label className="min-w-0 flex-1 sm:w-80 sm:flex-none" htmlFor="knowledge-project-name">
            <span className={labelCls}>项目名称</span>
            <input
              id="knowledge-project-name"
              className={`${inputCls} mt-1 w-full`}
              value={name}
              disabled={locked}
              onChange={(e) => { if (mutation.current || !deletion.canStart()) return; nameRef.current = e.target.value; setName(e.target.value); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void create(); }}
              placeholder="例如：金融核心计费引擎 / 云原生网关改造..."
            />
          </label>
          <button
            className={btnPrimary}
            onClick={create}
            disabled={locked || !name.trim()}
          >
            {creating ? "创建中…" : "立即创建"}
          </button>
        </div>
      </div>

      {loadError && <LoadError message={`项目列表加载失败：${loadError}`} onRetry={retryLoad} />}
      <ToolHistoryDeletionFeedback deletion={deletion} deletingLabel="正在删除项目及关联记录…" />
      {visibleItems === null ? (
        !loadError && <Loading label="加载项目知识库中…" />
      ) : visibleItems.length === 0 ? (
        <Empty>还没有项目档案。输入名称创建第一个，再导入设计文档供 AI 总结 STAR 亮点与命制深挖考题。</Empty>
      ) : (
        /* 现代化项目档案卡片阵列 */
        <div className="space-y-4">
          <div className="flex items-center justify-between text-xs text-muted border-b border-line pb-2.5 px-1">
            <span>已归档技术项目 ({visibleItems.length})</span>
            <span>材料沉淀状态</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {visibleItems.map((item) => (
              <div
                key={item.id}
                className="group flex flex-col justify-between rounded-2xl border border-line bg-card p-5 shadow-card-subtle transition-all duration-200 hover:border-primary/40 hover:shadow-card-float"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={`/knowledge/${item.id}`}
                        className="font-serif text-base sm:text-lg font-bold text-ink hover:text-primary transition-colors line-clamp-1"
                      >
                        {item.name}
                      </Link>
                      <p className="mt-1 font-mono text-[11px] text-faint">
                        {item.summary_updated_at
                          ? `STAR 总结更新于 ${new Date(item.summary_updated_at).toLocaleDateString()}`
                          : "尚未生成 AI 结构化亮点总结"}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full border border-primary/20 bg-primary-soft px-2.5 py-0.5 font-mono text-xs font-bold text-primary">
                      {item.material_count} 份技术材料
                    </span>
                  </div>

                  {/* 状态徽标与简述 */}
                  <div className="rounded-xl border border-line/70 bg-surface/40 p-3 text-xs text-muted leading-relaxed">
                    {item.summary_updated_at ? (
                      <span className="text-ink font-medium">
                        ✨ 已生成五维 STAR 提炼架构，可一键摘取至简历模块或用于题目练习。
                      </span>
                    ) : (
                      <span className="text-faint">
                        导入设计文档、PRD 或复盘笔记后，AI 将自动归纳难点成果。
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-5 flex items-center justify-between border-t border-line/60 pt-3.5 text-xs">
                  <button
                    type="button"
                    onClick={() => remove(item.id)}
                    disabled={creating || (deletion.busy && deletion.phase !== "confirming")}
                    className="text-danger hover:underline px-1 py-1"
                    title="删除项目材料、总结历史、练习及关联复习"
                  >
                    删除档案
                  </button>

                  <Link
                    href={`/knowledge/${item.id}`}
                    className="inline-flex items-center gap-1 font-serif font-bold text-primary hover:underline"
                  >
                    <span>进入项目档案库</span>
                    <span aria-hidden>→</span>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
