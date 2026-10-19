"use client";

import { useState } from "react";
import type { ProjectSummary } from "@/lib/summary";
import type { EntrySubItem } from "@/lib/modules";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { btnGhost, btnPrimary, inputCls, labelCls, textareaCls, textErr } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { jsonFetch } from "@/lib/fetcher";

type ProjectBrief = { id: number; name: string };

/**
 * 结构化摘取数据包：分别送达对应位置
 */
export type ExtractPayload = {
  techStack?: string;      // 写入自定义副项 label: "技术栈"
  brief?: string;          // 写入无 key 自定义副项 label: ""
  achievements?: string[]; // 写入多行独立描述项 descriptionItems
  mode: "replace" | "append";
};

type ResumeElementKey = "techStack" | "brief" | "achievements";

/** 「从项目摘取」对话框：选项目 → 勾选三要素 → 精准写入对应位置 */
export function ExtractDialog({
  current = "",
  currentName = "",
  currentSubItems,
  currentDescriptionItems,
  onWrite,
  onApply,
}: {
  current?: string;
  currentName?: string;
  currentSubItems?: EntrySubItem[];
  currentDescriptionItems?: string[];
  onWrite?: (description: string) => void;
  onApply?: (payload: ExtractPayload) => void;
}) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectBrief[] | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [summary, setSummary] = useState<ProjectSummary | null>(null);

  // 勾选状态
  const [checkedElements, setCheckedElements] = useState<Set<ResumeElementKey>>(
    new Set(["techStack", "brief", "achievements"])
  );
  const [checkedAchievements, setCheckedAchievements] = useState<Set<number>>(new Set());

  // 可编辑内容草稿
  const [draftTechStack, setDraftTechStack] = useState("");
  const [draftBrief, setDraftBrief] = useState("");
  const [draftAchievements, setDraftAchievements] = useState<string[]>([]);

  const [mode, setMode] = useState<"replace" | "append">("replace");
  const [error, setError] = useState("");
  const dialogRef = useModalFocus(open, () => setOpen(false), "input, textarea, select");

  async function openDialog() {
    setOpen(true);
    setError("");
    try {
      const list = await jsonFetch<ProjectBrief[]>("/api/projects");
      setProjects(list);
      if (list.length > 0) await pickProject(list[0]!.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function pickProject(id: number) {
    setProjectId(id);
    setSummary(null);
    setError("");
    try {
      const data = await jsonFetch<{ summary: ProjectSummary }>(`/api/projects/${id}`);
      const sum = data.summary;
      setSummary(sum);

      const tech = sum.techStack || "";
      const brief = sum.brief || "";
      const achs = sum.achievements || [];

      setDraftTechStack(tech);
      setDraftBrief(brief);
      setDraftAchievements(achs);

      const initialElements = new Set<ResumeElementKey>();
      if (tech.trim()) initialElements.add("techStack");
      if (brief.trim()) initialElements.add("brief");
      if (achs.length > 0) initialElements.add("achievements");
      setCheckedElements(initialElements);

      const initialAchs = new Set<number>(Array.from({ length: achs.length }, (_, i) => i));
      setCheckedAchievements(initialAchs);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function toggleElement(key: ResumeElementKey) {
    const next = new Set(checkedElements);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCheckedElements(next);
  }

  function toggleAchievement(index: number) {
    const next = new Set(checkedAchievements);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setCheckedAchievements(next);
  }

  function handleWrite() {
    const selectedTech = checkedElements.has("techStack") && draftTechStack.trim() ? draftTechStack.trim() : undefined;
    const selectedBrief = checkedElements.has("brief") && draftBrief.trim() ? draftBrief.trim() : undefined;
    const selectedAchs = checkedElements.has("achievements")
      ? draftAchievements
          .filter((_, idx) => checkedAchievements.has(idx))
          .map((a) => a.trim())
          .filter((a) => a.length > 0)
      : undefined;

    const payload: ExtractPayload = {
      techStack: selectedTech,
      brief: selectedBrief,
      achievements: selectedAchs,
      mode,
    };

    if (onApply) {
      onApply(payload);
    }

    if (onWrite) {
      const lines: string[] = [];
      if (selectedTech) lines.push(`【技术栈】\n${selectedTech}`);
      if (selectedBrief) lines.push(`【项目简要概述】\n${selectedBrief}`);
      if (selectedAchs && selectedAchs.length > 0) {
        lines.push(`【项目描述与成果】\n${selectedAchs.map((a) => (a.startsWith("•") ? a : `• ${a}`)).join("\n")}`);
      }
      const text = lines.join("\n\n");
      onWrite(mode === "append" && current.trim() ? `${current.trim()}\n\n${text}` : text);
    }

    setOpen(false);
  }

  if (!open) {
    return (
      <button className={`${btnGhost} text-primary`} onClick={openDialog}>
        从项目摘取
      </button>
    );
  }

  const hasResumeData = Boolean(
    summary &&
      (summary.techStack?.trim() ||
        summary.brief?.trim() ||
        (summary.achievements && summary.achievements.length > 0))
  );

  const selectedProjectName = projects?.find((p) => p.id === projectId)?.name || "";
  const previewProjectTitle = currentName?.trim() || selectedProjectName || "项目名称";

  const isNothingSelected =
    !checkedElements.has("techStack") &&
    !checkedElements.has("brief") &&
    (!checkedElements.has("achievements") || checkedAchievements.size === 0);

  const newTech = checkedElements.has("techStack") && draftTechStack.trim() ? draftTechStack.trim() : "";
  const newBrief = checkedElements.has("brief") && draftBrief.trim() ? draftBrief.trim() : "";

  let previewSubItems: { label: string; value: string; isNew?: boolean }[] = [];
  if (mode === "replace") {
    if (newTech) previewSubItems.push({ label: "技术栈", value: newTech, isNew: true });
    if (newBrief) previewSubItems.push({ label: "", value: newBrief, isNew: true });
  } else {
    // 追加模式：合并已有副项与新副项
    const existing = (currentSubItems ?? []).map((s) => ({ label: s.label, value: s.value, isNew: false }));
    const merged = [...existing];

    if (newTech) {
      const techIdx = merged.findIndex((s) => s.label === "技术栈");
      if (techIdx >= 0) {
        merged[techIdx] = { label: "技术栈", value: newTech, isNew: true };
      } else {
        merged.push({ label: "技术栈", value: newTech, isNew: true });
      }
    }

    if (newBrief) {
      const briefIdx = merged.findIndex((s) => s.label === "");
      if (briefIdx >= 0) {
        merged[briefIdx] = { label: "", value: newBrief, isNew: true };
      } else {
        merged.push({ label: "", value: newBrief, isNew: true });
      }
    }

    previewSubItems = merged;
  }

  const selectedNewAchs = checkedElements.has("achievements")
    ? draftAchievements
        .filter((_, idx) => checkedAchievements.has(idx))
        .map((a) => a.trim())
        .filter((a) => a.length > 0)
    : [];

  let previewAchievements: { text: string; isNew?: boolean }[] = [];
  if (mode === "replace") {
    previewAchievements = selectedNewAchs.map((text) => ({ text, isNew: true }));
  } else {
    // 追加模式：原有成果排在前面，新增选中的成果追加在末尾
    const existingAchs = (currentDescriptionItems ?? [])
      .map((d) => d.trim())
      .filter((d) => d.length > 0)
      .map((text) => ({ text, isNew: false }));

    previewAchievements = [
      ...existingAchs,
      ...selectedNewAchs.map((text) => ({ text, isNew: true })),
    ];
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="从项目摘取到简历"
      className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-overlay p-3 sm:p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-[2px]"
      onClick={() => setOpen(false)}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="dialog-in flex flex-col max-h-[92dvh] w-full max-w-5xl rounded-2xl border border-line bg-card shadow-card-float outline-none overflow-hidden"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5 sm:px-6 bg-card">
          <div className="flex items-center gap-2">
            <h2 className="font-serif text-base sm:text-lg font-bold text-ink tracking-tight">
              从项目摘取到简历
            </h2>
            <span className="rounded-full bg-primary-soft px-2.5 py-0.5 text-[11px] font-bold text-primary">
              左侧配置 · 右侧预览
            </span>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-ink"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          {error && <p className={`text-sm mb-3 ${textErr}`}>{error}</p>}

          {projects && projects.length === 0 ? (
            <p className="text-sm text-muted">
              知识库还没有项目。请先到「知识库」创建项目、导入材料并生成总结。
            </p>
          ) : projects ? (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* 左侧：表单配置区 */}
              <div className="lg:col-span-7 space-y-4">
                <label className="block">
                  <span className={labelCls}>选择项目</span>
                  <select
                    className={`${inputCls} mt-1`}
                    value={projectId ?? ""}
                    onChange={(e) => pickProject(Number(e.target.value))}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>

                {summary && !hasResumeData && (
                  <div className="rounded-xl border border-accent/40 bg-accent-wash px-4 py-3 text-xs text-accent space-y-1">
                    <p className="font-bold">⚠️ 该项目尚未提炼简历三要素</p>
                    <p>
                      当前摘取仅限「技术栈 + 项目简要概述 + 项目描述与成果」。请先前往知识库项目详情页点击「✨ 单独提炼简历三项」或重新生成总结。
                    </p>
                  </div>
                )}

                {summary && hasResumeData && (
                  <div className="space-y-4">
                    {/* 要素 1：技术栈（副项） */}
                    <div className="rounded-xl border border-line bg-surface/30 p-3.5 space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-1.5 text-sm font-semibold text-ink cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checkedElements.has("techStack")}
                            onChange={() => toggleElement("techStack")}
                            className="h-4 w-4 accent-(--primary)"
                          />
                          <span>技术栈</span>
                          <span className="text-[11px] font-normal text-primary">→ 写入自定义副项「技术栈」</span>
                        </label>
                        {!draftTechStack.trim() && <span className="text-xs text-muted">未提炼</span>}
                      </div>
                      {checkedElements.has("techStack") && (
                        <input
                          className={`${inputCls} text-xs sm:text-sm bg-card`}
                          value={draftTechStack}
                          onChange={(e) => setDraftTechStack(e.target.value)}
                          placeholder="例如：React 19, TypeScript, Tailwind CSS, SQLite"
                        />
                      )}
                    </div>

                    {/* 要素 2：项目简要概述（无 key 副项） */}
                    <div className="rounded-xl border border-line bg-surface/30 p-3.5 space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-1.5 text-sm font-semibold text-ink cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checkedElements.has("brief")}
                            onChange={() => toggleElement("brief")}
                            className="h-4 w-4 accent-(--primary)"
                          />
                          <span>项目简要概述</span>
                          <span className="text-[11px] font-normal text-primary">→ 写入无 key 自定义副项（纯文本紧凑显示）</span>
                        </label>
                        {!draftBrief.trim() && <span className="text-xs text-muted">未提炼</span>}
                      </div>
                      {checkedElements.has("brief") && (
                        <textarea
                          rows={2}
                          className={`${textareaCls} text-xs sm:text-sm bg-card font-sans`}
                          value={draftBrief}
                          onChange={(e) => setDraftBrief(e.target.value)}
                          placeholder="一两句精炼说明项目定位与解决的核心痛点..."
                        />
                      )}
                    </div>

                    {/* 要素 3：项目描述与成果（多行独立描述项） */}
                    <div className="rounded-xl border border-line bg-surface/30 p-3.5 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-1.5 text-sm font-semibold text-ink cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checkedElements.has("achievements")}
                            onChange={() => toggleElement("achievements")}
                            className="h-4 w-4 accent-(--primary)"
                          />
                          <span>项目描述与成果</span>
                          <span className="text-[11px] font-normal text-primary">→ 每一项单独作为一行写入成果列表</span>
                        </label>
                        {draftAchievements.length === 0 && <span className="text-xs text-muted">未提炼</span>}
                      </div>

                      {checkedElements.has("achievements") && draftAchievements.length > 0 && (
                        <div className="mt-2 space-y-2">
                          <span className="text-xs font-medium text-muted block">勾选要摘取的成果条目（支持二次微调）：</span>
                          {draftAchievements.map((ach, idx) => (
                            <div key={idx} className="flex items-start gap-2 bg-card p-2 rounded-lg border border-line/70">
                              <input
                                type="checkbox"
                                checked={checkedAchievements.has(idx)}
                                onChange={() => toggleAchievement(idx)}
                                className="h-4 w-4 mt-1 accent-(--primary) shrink-0 cursor-pointer"
                              />
                              <span className="font-mono text-xs font-bold text-primary mt-1 shrink-0">{idx + 1}.</span>
                              <textarea
                                rows={2}
                                className={`${textareaCls} flex-1 text-xs bg-surface/30 font-sans`}
                                value={ach}
                                onChange={(e) => {
                                  const next = [...draftAchievements];
                                  next[idx] = e.target.value;
                                  setDraftAchievements(next);
                                }}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 写入方式 */}
                    <div className="pt-1">
                      <span className={labelCls}>写入方式</span>
                      <div className="mt-2 flex flex-col sm:flex-row gap-2 sm:gap-4 text-xs sm:text-sm">
                        <label className="flex items-center gap-1.5 accent-(--primary) cursor-pointer">
                          <input
                            type="radio"
                            checked={mode === "replace"}
                            onChange={() => setMode("replace")}
                            className="h-4 w-4"
                          />
                          <span><strong>替换现有内容</strong></span>
                        </label>
                        <label className="flex items-center gap-1.5 accent-(--primary) cursor-pointer">
                          <input
                            type="radio"
                            checked={mode === "append"}
                            onChange={() => setMode("append")}
                            className="h-4 w-4"
                          />
                          <span><strong>追加到现有内容</strong></span>
                        </label>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 右侧：应用后实时效果预览区 */}
              <div className="lg:col-span-5 sticky top-0 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted">
                    👁️ 简历条目实际预览效果
                  </span>
                  <span
                    className={`rounded px-2 py-0.5 text-[10px] font-bold border ${
                      mode === "replace"
                        ? "bg-accent-wash text-accent border-accent/30"
                        : "bg-primary-soft text-primary border-primary/20"
                    }`}
                  >
                    {mode === "replace" ? "⚡ 完全替换预览" : "➕ 追加合并预览"}
                  </span>
                </div>

                <div className="rounded-2xl border border-line bg-surface/40 p-4.5 shadow-2xs space-y-3">
                  {/* 项目标题与时间行模拟 */}
                  <div className="flex items-baseline justify-between border-b border-line pb-2.5">
                    <div>
                      <h3 className="font-serif text-sm sm:text-base font-bold text-ink">
                        {previewProjectTitle}
                      </h3>
                      <p className="text-xs text-muted mt-0.5">担任角色：技术负责人 / 核心开发</p>
                    </div>
                    <span className="font-mono text-xs text-muted">至今</span>
                  </div>

                  {/* 自定义副项预览区 */}
                  <div className="space-y-1.5">
                    {previewSubItems.length > 0 ? (
                      previewSubItems.map((sub, idx) => (
                        <div key={idx} className="text-xs leading-relaxed flex items-start gap-1.5">
                          {sub.label ? (
                            <div className="flex-1">
                              <strong className="font-semibold text-ink">{sub.label}：</strong>
                              <span className="text-ink">{sub.value}</span>
                              {sub.isNew && mode === "append" && (
                                <span className="ml-1.5 rounded bg-primary-soft text-[10px] text-primary px-1 font-medium">
                                  新设定
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className="flex-1 text-muted bg-card/60 p-2 rounded-lg border border-line/60">
                              <span>{sub.value}</span>
                              {sub.isNew && mode === "append" && (
                                <span className="ml-1.5 rounded bg-primary-soft text-[10px] text-primary px-1 font-medium">
                                  新增简述
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-faint italic py-0.5">暂无副项</p>
                    )}
                  </div>

                  {/* 描述与成果列表预览区 */}
                  <div className="pt-1">
                    {previewAchievements.length > 0 ? (
                      <ul className="space-y-1.5">
                        {previewAchievements.map((ach, i) => (
                          <li
                            key={i}
                            className={`flex items-baseline gap-2 text-xs leading-relaxed p-1 rounded transition-colors ${
                              ach.isNew && mode === "append"
                                ? "bg-primary-soft/30 text-ink"
                                : "text-ink"
                            }`}
                          >
                            <span className="text-primary font-bold shrink-0">•</span>
                            <span className="flex-1">{ach.text}</span>
                            {ach.isNew && mode === "append" && (
                              <span className="shrink-0 rounded bg-primary-soft text-[10px] text-primary px-1 font-medium border border-primary/20">
                                新增追加
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-faint italic py-1">暂无勾选的项目描述与成果</p>
                    )}
                  </div>

                  <div className="mt-3 rounded-lg border border-primary/20 bg-primary-soft/30 p-2 text-[11px] text-primary leading-tight">
                    {mode === "replace"
                      ? "💡 替换模式：点击写入后，本条项目经历的现有副项和描述行将被全部覆盖为上方新预览内容。"
                      : "💡 追加模式：点击写入后，保留当前已有内容，并在其末尾追加上方带有 [新增追加] 标签的新条目。"}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">加载中…</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3 sm:px-6 bg-card">
          <button className={btnGhost} onClick={() => setOpen(false)}>
            取消
          </button>
          <button
            className={btnPrimary}
            onClick={handleWrite}
            disabled={!hasResumeData || isNothingSelected}
          >
            写入项目经历对应位置
          </button>
        </div>
      </div>
    </div>
  );
}
