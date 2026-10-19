"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CommandModal } from "@/components/common/modal-variants";
import { useDebouncedSearch } from "@/hooks/use-debounced-search";
import { useCompositionInput } from "@/hooks/use-composition-input";
import { jsonFetch } from "@/lib/fetcher";
import { textErr } from "@/lib/ui";
import { HighlightText } from "@/components/common/highlight-text";
import type { MatchedSnippet } from "@/lib/search-snippet";

type ResumeHit = { id: number; title: string; updated_at: string; snippets?: MatchedSnippet[] };
type ProjectHit = { id: number; name: string; updated_at: string; snippets?: MatchedSnippet[] };
type QuestionHit = { id: number; drill_id: number; idx: number; question: string; label: string | null; snippets?: MatchedSnippet[] };
type InterviewHit = {
  id: number;
  jd: string;
  status: string;
  created_at: string;
  resume_title: string;
  answered: number;
  snippets?: MatchedSnippet[];
};
type ApplicationHit = {
  id: number;
  company: string;
  role: string;
  stage: string;
  updated_at: string;
  snippets?: MatchedSnippet[];
};
type SearchResponse = {
  resumes: ResumeHit[];
  projects: ProjectHit[];
  questions: QuestionHit[];
  interviews: InterviewHit[];
  applications?: ApplicationHit[];
};

type Hit = { key: string; title: string; meta: string; href: string; snippets?: MatchedSnippet[] };

/** 全局搜索/命令面板（Ctrl+K 唤起，见 SiteNav）：跨简历、项目、题目、面试记录搜索并跳转。
 * 由父组件在打开时才挂载，因此每次打开都从空白开始。 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [committedQuery, setCommittedQuery] = useState("");
  const { isComposingRef, bind: inputBind } = useCompositionInput("", setCommittedQuery);
  const [results, setResults] = useState<{ key: string; data: SearchResponse } | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const queryKey = committedQuery.trim().slice(0, 100);
  const matchingResults = results?.key === queryKey ? results.data : null;
  useDebouncedSearch<{ key: string; data: SearchResponse }>({
    queryKey,
    delay: 400,
    load: (signal) => {
      const q = committedQuery.trim().slice(0, 100);
      return jsonFetch<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`, { signal })
        .then((data) => ({ key: q, data }));
    },
    onStart: () => setSearching(true),
    onSuccess: (data) => {
      setResults(data);
      setError("");
      setSelected(0);
      setSearching(false);
    },
    onError: (err) => {
      setResults(null);
      setError(err.message);
      setSearching(false);
    },
    onEmpty: () => {
      setResults(null);
      setSearching(false);
      setError("");
    },
  });

  // 选中项滚入可视区
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, results]);

  const sections: { label: string; hits: Hit[] }[] = [];
  if (matchingResults) {
    if (matchingResults.applications && matchingResults.applications.length > 0)
      sections.push({
        label: "求职投递",
        hits: matchingResults.applications.map((app) => ({
          key: `app-${app.id}`,
          title: `${app.company} · ${app.role}`,
          meta: `求职看板 · 更新于 ${new Date(app.updated_at).toLocaleDateString()}`,
          href: `/applications`,
          snippets: app.snippets,
        })),
      });
    if (matchingResults.resumes.length > 0)
      sections.push({
        label: "简历",
        hits: matchingResults.resumes.map((r) => ({
          key: `resume-${r.id}`,
          title: r.title,
          meta: `更新于 ${new Date(r.updated_at).toLocaleDateString()}`,
          href: `/resumes/${r.id}`,
          snippets: r.snippets,
        })),
      });
    if (matchingResults.projects.length > 0)
      sections.push({
        label: "项目",
        hits: matchingResults.projects.map((p) => ({
          key: `project-${p.id}`,
          title: p.name,
          meta: `更新于 ${new Date(p.updated_at).toLocaleDateString()}`,
          href: `/knowledge/${p.id}`,
          snippets: p.snippets,
        })),
      });
    if (matchingResults.questions.length > 0)
      sections.push({
        label: "题目",
        hits: matchingResults.questions.map((q) => ({
          key: `question-${q.id}`,
          title: q.question,
          meta: `${q.label ?? "未命名练习"} · 第 ${q.idx} 题`,
          href: `/drills/${q.drill_id}`,
          snippets: q.snippets,
        })),
      });
    if (matchingResults.interviews.length > 0)
      sections.push({
        label: "面试记录",
        hits: matchingResults.interviews.map((it) => ({
          key: `interview-${it.id}`,
          title: it.resume_title,
          meta: `JD：${it.jd.slice(0, 30)}${it.jd.length > 30 ? "…" : ""} · ${it.status === "finished" ? "已结束" : "进行中"}`,
          href: `/interviews/${it.id}`,
          snippets: it.snippets,
        })),
      });
  }
  const flat = sections.flatMap((s) => s.hits);

  function openHit(hit: Hit) {
    onClose();
    router.push(hit.href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (isComposingRef.current || ("isComposing" in e.nativeEvent && (e.nativeEvent as KeyboardEvent).isComposing)) {
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length === 0) return;
      setSelected((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length === 0) return;
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.currentTarget.value.trim().slice(0, 100) !== results?.key) return;
      const hit = flat[selected];
      if (hit) openHit(hit);
    }
  }

  let body: React.ReactNode;
  if (!committedQuery.trim()) {
    body = (
      <p className="px-3 py-10 text-center text-sm text-faint">
        输入关键词，跨简历、项目、题目与面试记录搜索
      </p>
    );
  } else if (error) {
    body = <p className={`px-3 py-6 text-sm ${textErr}`}>{error}</p>;
  } else if (matchingResults && flat.length === 0) {
    body = <p className="px-3 py-10 text-center text-sm text-faint">没有匹配「{committedQuery.trim()}」的结果</p>;
  } else {
    let index = -1;
    body = sections.map((section) => (
      <div key={section.label}>
        <div className="px-3 pb-1 pt-2 text-xs font-medium text-faint">{section.label}</div>
        {section.hits.map((hit) => {
          index += 1;
          const active = index === selected;
          return (
            <button
              key={hit.key}
              id={`command-result-${hit.key}`}
              type="button"
              role="option"
              aria-selected={active}
              data-selected={active || undefined}
              onMouseEnter={() => setSelected(flat.indexOf(hit))}
              onClick={() => openHit(hit)}
              className={`flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 sm:py-2 text-left transition-colors min-h-[40px] sm:min-h-0 ${
                active ? "bg-primary-soft" : ""
              }`}
            >
              <div className="flex w-full items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm font-medium text-ink">
                  <HighlightText text={hit.title} keyword={committedQuery.trim()} />
                </span>
                <span className="max-w-[45%] shrink-0 truncate text-xs text-faint">{hit.meta}</span>
              </div>
              {hit.snippets && hit.snippets.length > 0 && (
                <div className="flex flex-col gap-1 pl-2 border-l-2 border-primary/20 text-xs text-muted w-full my-0.5">
                  {hit.snippets.map((snip, sIdx) => (
                    <div key={sIdx} className="line-clamp-2 leading-relaxed">
                      {snip.source && (
                        <span className="mr-1.5 inline-block rounded bg-surface-raised px-1 py-0.5 text-[10px] text-faint border border-line">
                          {snip.source}
                        </span>
                      )}
                      <HighlightText text={snip.text} keyword={committedQuery.trim()} />
                    </div>
                  ))}
                </div>
              )}
            </button>
          );
        })}
      </div>
    ));
  }

  return (
    <CommandModal
      open
      title="全局搜索"
      onClose={onClose}
      initialFocusSelector="[data-command-search]"
    >
      <div className="flex items-center gap-2 border-b border-line px-3.5 sm:px-4">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="h-4 w-4 shrink-0 text-faint"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          data-command-search
          {...inputBind}
          onKeyDown={onKeyDown}
          maxLength={100}
          placeholder="搜索简历、项目、题目、面试记录…"
          role="combobox"
          aria-expanded={Boolean(committedQuery.trim() && matchingResults)}
          aria-controls={listboxId}
          aria-activedescendant={flat[selected] ? `command-result-${flat[selected].key}` : undefined}
          aria-autocomplete="list"
          aria-label="搜索关键词"
          className="h-12 w-full bg-transparent text-base sm:text-sm text-ink outline-none placeholder:text-faint"
        />
        {searching && Boolean(committedQuery.trim()) && <span className="shrink-0 text-xs text-faint">搜索中…</span>}
        <button
          type="button"
          onClick={onClose}
          className="sm:hidden shrink-0 rounded-lg px-2 py-1 text-xs text-muted hover:text-ink"
        >
          取消
        </button>
      </div>
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label="搜索结果"
        className="max-h-[min(65dvh,480px)] overflow-y-auto p-2"
      >
        {body}
      </div>
      <div className="hidden sm:flex items-center gap-4 border-t border-line px-4 py-2 text-xs text-faint">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> 选择
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> 打开
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd> 关闭
        </span>
      </div>
    </CommandModal>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-line px-1 font-mono text-[10px] leading-relaxed">
      {children}
    </kbd>
  );
}
