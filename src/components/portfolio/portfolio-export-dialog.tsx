"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { Modal } from "@/components/common/modal";
import { apiFetch } from "@/lib/api-fetch";
import type {
  PortfolioSourcesData,
  PortfolioExportOptions,
  PortfolioProjectSelection,
} from "@/lib/portfolio-types";
import { DEFAULT_ANONYMIZE_CONFIG, type AnonymizeConfig } from "@/lib/resume-anonymize";
import { normalizePortfolioLink, PORTFOLIO_LINK_LABELS } from "@/lib/portfolio-links";
import { PortfolioProjectLinks } from "./portfolio-project-links";
import { PORTFOLIO_TEMPLATES, type PortfolioTemplateId } from "@/lib/portfolio-templates";

interface PortfolioExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  resumeId: number;
  currentVersionId?: number | null;
  resumeTitle?: string;
  beforeExport?: () => Promise<void>;
}

type SourceState = {
  loading: boolean;
  sources: PortfolioSourcesData | null;
  errorMsg: string;
};

type SourceAction =
  | { type: "load-start" }
  | { type: "load-success"; sources: PortfolioSourcesData }
  | { type: "load-failure"; errorMsg: string }
  | { type: "set-error"; errorMsg: string };

function sourceReducer(state: SourceState, action: SourceAction): SourceState {
  switch (action.type) {
    case "load-start":
      return { ...state, loading: true, errorMsg: "" };
    case "load-success":
      return { loading: false, sources: action.sources, errorMsg: "" };
    case "load-failure":
    case "set-error":
      return { ...state, loading: false, errorMsg: action.errorMsg };
  }
}

export function PortfolioExportDialog({
  isOpen,
  onClose,
  resumeId,
  currentVersionId,
  resumeTitle,
  beforeExport,
}: PortfolioExportDialogProps) {
  const [sourceState, dispatchSource] = useReducer(sourceReducer, {
    loading: isOpen,
    sources: null,
    errorMsg: "",
  });
  const selectionInitialized = useRef(false);
  const [selectedVersionId] = useState<number | null>(
    currentVersionId ?? null
  );
  const [selectedProjects, setSelectedProjects] = useState<Map<number, PortfolioProjectSelection>>(
    new Map()
  );
  const [siteTitle, setSiteTitle] = useState(resumeTitle ? `${resumeTitle} - 个人作品集` : "个人作品集");
  const [accentColor, setAccentColor] = useState("#b8722c");
  const [siteTemplate, setSiteTemplate] = useState<PortfolioTemplateId>("flow");
  const [anonymizeConfig] = useState<AnonymizeConfig>(DEFAULT_ANONYMIZE_CONFIG);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    dispatchSource({ type: "load-start" });

    apiFetch("/api/portfolio/sources", { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error("获取作品集数据源失败");
        return res.json();
      })
      .then((data: PortfolioSourcesData) => {
        if (controller.signal.aborted) return;
        dispatchSource({ type: "load-success", sources: data });
        // 默认全选前 3 个项目库项目
        const initialMap = new Map<number, PortfolioProjectSelection>();
        data.projects.slice(0, 3).forEach((p, idx) => {
          initialMap.set(p.id, {
            projectId: p.id,
            featured: true,
            order: idx,
            customLinks: {},
          });
        });
        if (!selectionInitialized.current) {
          setSelectedProjects(initialMap);
          selectionInitialized.current = true;
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        dispatchSource({ type: "load-failure", errorMsg: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, [isOpen]);

  const toggleProject = (projectId: number) => {
    setSelectedProjects((prev) => {
      const next = new Map(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.set(projectId, {
          projectId,
          featured: true,
          customLinks: {},
        });
      }
      return next;
    });
  };

  const updateProjectLink = (
    projectId: number,
    field: "demoUrl" | "repoUrl" | "docUrl",
    value: string
  ) => {
    setSelectedProjects((prev) => {
      const next = new Map(prev);
      const curr = next.get(projectId);
      if (curr) {
        next.set(projectId, {
          ...curr,
          customLinks: {
            ...curr.customLinks,
            [field]: value,
          },
        });
      }
      return next;
    });
  };

  const handleExportZip = async () => {
    for (const project of selectedProjects.values()) {
      for (const [key, label] of Object.entries(PORTFOLIO_LINK_LABELS)) {
        const value = project.customLinks?.[key as keyof typeof PORTFOLIO_LINK_LABELS] ?? "";
        if (normalizePortfolioLink(value) === null) {
          const name = sourceState.sources?.projects.find((item) => item.id === project.projectId)?.name ?? "项目";
          dispatchSource({ type: "set-error", errorMsg: `${name}的${label}必须是完整的 HTTP/HTTPS 地址` });
          return;
        }
      }
    }
    setExporting(true);
    dispatchSource({ type: "set-error", errorMsg: "" });

    const payload: PortfolioExportOptions = {
      resumeId,
      versionId: selectedVersionId,
      siteTitle,
      accentColor,
      siteTemplate,
      selectedProjects: Array.from(selectedProjects.values()),
      anonymizeConfig,
    };

    try {
      await beforeExport?.();
      const res = await apiFetch("/api/portfolio/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "导出失败，请重试");
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `portfolio-${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      dispatchSource({ type: "set-error", errorMsg: err instanceof Error ? err.message : String(err) });
    } finally {
      setExporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="导出个人作品集与静态网页"
      loading={exporting}
      loadingText="正在打包生成作品集静态站点…"
      loadingDescription="正在读取项目档案与配置并压缩为 Zip 包，请稍候…"
    >
      <div className="space-y-5 text-sm">
        {sourceState.errorMsg && (
          <div className="rounded-lg bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-400">
            {sourceState.errorMsg}
          </div>
        )}

        {sourceState.loading ? (
          <div className="py-12 text-center text-muted">正在加载数据源...</div>
        ) : (
          <>
            {/* 基本设定 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label htmlFor="portfolio-export-template" className="mb-1 block text-xs font-semibold text-ink">主页模板</label>
                <select id="portfolio-export-template" value={siteTemplate} onChange={(event) => setSiteTemplate(event.target.value as PortfolioTemplateId)}
                  className="w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink focus:border-primary focus:outline-none">
                  {PORTFOLIO_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.description}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">网页标题</label>
                <input
                  type="text"
                  value={siteTitle}
                  onChange={(e) => setSiteTitle(e.target.value)}
                  className="w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink focus:border-primary focus:outline-none"
                  placeholder="例如：张三的个人作品集"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">主色调 (Accent Color)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={accentColor}
                    onChange={(e) => setAccentColor(e.target.value)}
                    className="h-8 w-12 rounded cursor-pointer border border-line p-0.5"
                  />
                  <span className="text-xs text-muted font-mono">{accentColor}</span>
                </div>
              </div>
            </div>

            {/* 项目库关联勾选 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-ink">
                  附加作品 ({selectedProjects.size} 个已选)
                </span>
                <span className="text-[11px] text-muted">展示作品概述、成果与链接</span>
              </div>

              <div className="max-h-56 overflow-y-auto space-y-2 rounded-lg border border-line/60 bg-surface/50 p-2">
                {sourceState.sources?.projects.length === 0 ? (
                  <div className="py-4 text-center text-xs text-muted">项目库暂无可用档案</div>
                ) : (
                  sourceState.sources?.projects.map((proj) => {
                    const isSelected = selectedProjects.has(proj.id);
                    const selItem = selectedProjects.get(proj.id);

                    return (
                      <div
                        key={proj.id}
                        className={`rounded-lg border p-2.5 transition-colors ${
                          isSelected ? "border-primary/50 bg-primary/5" : "border-line bg-card"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <label className="flex items-center gap-2 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleProject(proj.id)}
                              className="rounded text-primary focus:ring-primary/20"
                            />
                            <span className="font-semibold text-xs text-ink">{proj.name}</span>
                          </label>
                        </div>

                        {isSelected && selItem && (
                          <div className="mt-2.5 pt-2 border-t border-line/60 grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                            <PortfolioProjectLinks name={proj.name} links={selItem.customLinks}
                              onChange={(field, value) => updateProjectLink(proj.id, field, value)} />
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* 脱敏安全选项 */}
            <div className="rounded-lg bg-surface/70 p-3 border border-line">
              <div className="text-xs font-semibold text-ink mb-1.5 flex items-center gap-1.5">
                <span>🛡️ 隐私脱敏防护</span>
                <span className="rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">已预设防护</span>
              </div>
              <p className="text-[11px] text-muted leading-relaxed">
                姓名及标题中的同名信息会遮盖，电话、邮箱会部分隐藏，地址只保留可识别的城市；项目正文和自定义链接仍需在公开前人工核对。
              </p>
            </div>

            {/* 底部按钮 */}
            <div className="flex justify-end gap-3 pt-3 border-t border-line">
              <button
                type="button"
                onClick={onClose}
                disabled={exporting}
                className="rounded-lg border border-line px-4 py-1.5 text-xs text-ink hover:bg-surface"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleExportZip}
                disabled={exporting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50 cursor-pointer"
              >
                {exporting ? "正在打包静态站点..." : "生成并下载静态站点 Zip 包"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
