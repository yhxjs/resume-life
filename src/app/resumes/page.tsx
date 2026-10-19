"use client";

import { useEffect, useState } from "react";
import { confirmDialog, alertDialog } from "@/components/common/confirm-dialog";
import { Empty, Loading, LoadError } from "@/components/common/ui-bits";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { jsonFetch } from "@/lib/fetcher";
import { btnGhost, btnPrimary, inputCls } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";

type ResumeItem = { id: number; title: string; created_at: string; updated_at: string; versions?: { id: number; version: number }[] };

export default function ResumesPage() {
  const router = useRouter();
  const [items, setItems] = useState<ResumeItem[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [copyingId, setCopyingId] = useState<number | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  function retryLoad() {
    setLoadError("");
    setLoadAttempt((attempt) => attempt + 1);
  }

  async function load() {
    try {
      setItems(await jsonFetch<ResumeItem[]>("/api/resumes"));
      setLoadError("");
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }

  useEffect(() => {
    let cancelled = false;
    jsonFetch<ResumeItem[]>("/api/resumes")
      .then((data) => {
        if (!cancelled) {
          setItems(data);
          setLoadError("");
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  async function create() {
    if (!title.trim()) return;
    setCreating(true);
    try {
      const data = await jsonFetch<{ id: number }>("/api/resumes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() }),
      });
      router.push(`/resumes/${data.id}`);
    } catch (err) {
      await alertDialog({ title: "创建失败", message: errorMessage(err) });
      setCreating(false);
    }
  }

  async function copyResume(id: number) {
    setCopyingId(id);
    try {
      await jsonFetch(`/api/resumes/${id}/copy`, { method: "POST" });
      await load();
    } catch (err) {
      await alertDialog({ title: "复制失败", message: errorMessage(err) });
    } finally {
      setCopyingId(null);
    }
  }

  async function remove(id: number, name: string) {
    if (!(await confirmDialog({ title: "删除简历", message: `确定删除简历「${name}」？该操作不可恢复。`, danger: true }))) return;
    try {
      await jsonFetch(`/api/resumes/${id}`, { method: "DELETE" });
    } catch (err) {
      await alertDialog({ title: "删除失败", message: errorMessage(err) });
      return;
    }
    load();
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">简历管理中心</h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            针对不同目标岗位并存多份定制简历；六大模块结构化维护，支持 PDF/Word 智能解析与打印级导出。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/resumes/import" className={btnGhost}>
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4 shrink-0 text-muted"
              aria-hidden
            >
              <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
              <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
            </svg>
            <span>导入已有简历 (PDF/Word)</span>
          </Link>
        </div>
      </div>

      {/* 快速新建简历横幅 */}
      <div className="rounded-2xl border border-line bg-card p-5 shadow-card-subtle flex flex-col sm:flex-row items-center justify-between gap-4 bg-grain">
        <div className="space-y-1 w-full sm:w-auto">
          <div className="flex items-center gap-2">
            <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
            <span className="font-serif font-bold text-sm text-ink">创建新简历</span>
          </div>
          <p className="text-xs text-muted">按目标岗位建立简历，编辑后手动发布版本（例如：前端工程师 / 架构师）</p>
        </div>
        <div className="flex w-full sm:w-auto items-center gap-2.5">
          <input
            className={`${inputCls} sm:w-80`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="例如：高级前端工程师-外企远程..."
          />
          <button
            className={btnPrimary}
            onClick={create}
            disabled={creating || !title.trim()}
          >
            {creating ? "创建中…" : "立即创建"}
          </button>
        </div>
      </div>

      {loadError && <LoadError message={`简历列表加载失败：${loadError}`} onRetry={retryLoad} />}
      {items === null ? (
        !loadError && <Loading label="加载简历列表中…" />
      ) : items.length === 0 ? (
        <Empty
          action={
            <Link href="/resumes/import" className={btnPrimary}>
              导入 PDF / Word 简历
            </Link>
          }
        >
          还没有创建任何简历。输入标题创建第一份，或导入已有的本地简历快速提炼。
        </Empty>
      ) : (
        /* 现代化简历卡片阵列 */
        <div className="space-y-4">
          <div className="flex items-center justify-between text-xs text-muted border-b border-line pb-2.5 px-1">
            <span>共维护 {items.length} 个简历版本</span>
            <span>按最后更新时间排序</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {items.map((item, index) => (
              <div
                key={item.id}
                className="group relative flex flex-col justify-between rounded-2xl border border-line bg-card p-5 shadow-card-subtle transition-all duration-200 hover:border-primary/40 hover:shadow-card-float"
              >
                {/* 第一份或首推版本标记 */}
                {index === 0 && (
                  <div className="absolute right-0 top-0 rounded-bl-xl bg-primary px-3 py-0.5 text-[10px] font-bold text-on-primary shadow-xs">
                    常用主投版
                  </div>
                )}

                <div className="space-y-3">
                  <div className="flex items-start justify-between pr-14">
                    <div>
                      <Link
                        href={`/resumes/${item.id}`}
                        className="font-serif text-base sm:text-lg font-bold text-ink hover:text-primary transition-colors line-clamp-1"
                      >
                        {item.title}
                      </Link>
                      <p className="mt-1 font-mono text-[11px] text-faint">
                        最后修改：{new Date(item.updated_at).toLocaleString()}
                      </p>
                      <Link className="mt-2 inline-block text-xs text-primary underline underline-offset-4" href={`/resumes/${item.id}/versions`}>
                        {item.versions?.length ? `版本树 · ${item.versions.length} 个已发布版本` : "版本树 · 尚未发布"}
                      </Link>
                    </div>
                  </div>

                  {/* 模块标签胶囊 */}
                  <div className="flex flex-wrap gap-1.5 pt-1 text-[11px]">
                    <span className="rounded-md border border-line bg-surface px-2 py-0.5 text-muted">
                      基本信息
                    </span>
                    <span className="rounded-md border border-line bg-surface px-2 py-0.5 text-muted">
                      专业技能
                    </span>
                    <span className="rounded-md border border-line bg-surface px-2 py-0.5 text-muted">
                      工作经历
                    </span>
                    <span className="rounded-md border border-line bg-surface px-2 py-0.5 text-muted">
                      项目经历
                    </span>
                    <span className="rounded-md border border-line bg-surface px-2 py-0.5 text-muted">
                      教育背景
                    </span>
                  </div>
                </div>

                {/* 底部操作集 */}
                <div className="mt-5 flex items-center justify-between border-t border-line/60 pt-3.5 text-xs">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => copyResume(item.id)}
                      disabled={copyingId !== null}
                      className="text-muted hover:text-ink font-medium px-2 py-1 rounded hover:bg-surface transition-colors"
                      title="复制为此简历的新副本"
                    >
                      {copyingId === item.id ? "复制中…" : "复制"}
                    </button>
                    <Link
                      href={`/resumes/${item.id}/print`}
                      target="_blank"
                      className="text-muted hover:text-ink font-medium px-2 py-1 rounded hover:bg-surface transition-colors"
                      title="打开打印与 PDF 导出视图"
                    >
                      导出 PDF
                    </Link>
                    <a
                      href={`/api/resumes/${item.id}/export`}
                      download
                      className="text-muted hover:text-ink font-medium px-2 py-1 rounded hover:bg-surface transition-colors"
                      title="导出为 Markdown (.md) 文件"
                    >
                      导出 MD
                    </a>
                    <button
                      type="button"
                      onClick={() => remove(item.id, item.title)}
                      className="text-danger hover:underline px-2 py-1"
                      title="彻底删除此简历"
                    >
                      删除
                    </button>
                  </div>

                  <Link
                    href={`/resumes/${item.id}`}
                    className="inline-flex items-center gap-1 font-serif font-bold text-primary hover:underline"
                  >
                    <span>进入工作台精修</span>
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
