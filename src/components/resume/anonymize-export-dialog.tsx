"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { Modal } from "@/components/common/modal";
import { apiFetch } from "@/lib/api-fetch";
import { ResumeExportCheckDialog } from "@/components/resume/resume-export-check-dialog";
import type { ResumeExportIssue, ResumeExportLayoutEntry } from "@/lib/resume-export-check";
import { downloadCheckedResume, measureResumeExportLayout } from "@/lib/resume-export-client";
import { prepare, ResumeDoc } from "@/components/resume/doc";
import type { ResumeStyle } from "@/lib/templates";
import { btnGhost, btnPrimary } from "@/lib/ui";
import { resumeToMarkdown } from "@/lib/resume-markdown";
import { errorMessage } from "@/lib/error-message";
import { ANONYMIZE_STORAGE_KEY } from "@/lib/browser-sensitive-data";
import {
  DEFAULT_ANONYMIZE_CONFIG,
  isAnonymizeConfig,
  anonymizeResumeModules,
  anonymizeResumeTitle,
  calculateAnonymizeStats,
  extractResumeEntities,
  type AnonymizeConfig,
  type CustomSensitiveRule,
} from "@/lib/resume-anonymize";
import type { ModuleData, BasicContent } from "@/lib/modules";
import { AnonymizeBasicConfigEditor, AnonymizeCustomRulesEditor } from "./anonymize-config-editor";
import { AnonymizeEntityEditor, AnonymizePreview, type AnonymizeEntityOverrides } from "./anonymize-entity-preview";

interface AnonymizeExportDialogProps {
  open: boolean;
  onClose: () => void;
  resumeId: string | number;
  title: string;
  modules: ModuleData[];
  beforeExport?: () => Promise<void>;
  onLocate?: (issue: ResumeExportIssue) => void;
  layout?: ResumeExportLayoutEntry[];
  paperHeight?: number;
  pageMargin?: number;
  resumeStyle?: ResumeStyle;
}

const STORAGE_KEY = ANONYMIZE_STORAGE_KEY;

export function AnonymizeExportDialog({
  open,
  onClose,
  resumeId,
  title,
  modules,
  beforeExport,
  onLocate,
  layout,
  paperHeight,
  pageMargin,
  resumeStyle,
}: AnonymizeExportDialogProps) {
  const [exportFormat, setExportFormat] = useState<"md" | "pdf" | "docx" | null>(null);
  const exportPaperRef = useRef<HTMLDivElement>(null);
  const [exportLayout, setExportLayout] = useState<ResumeExportLayoutEntry[]>([]);

  function requestExport(format: "md" | "pdf" | "docx") {
    setExportLayout(resumeStyle ? measureResumeExportLayout(exportPaperRef.current) : layout ?? []);
    setExportFormat(format);
  }
  // 从简历数据中自动识别提取全部已填公司、项目、学校
  const autoEntities = useMemo(() => extractResumeEntities(modules), [modules]);

  const [storedConfig] = useState(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          const candidate = {
            ...DEFAULT_ANONYMIZE_CONFIG,
            ...parsed,
          };
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !isAnonymizeConfig(candidate)) {
            return { config: DEFAULT_ANONYMIZE_CONFIG, reset: true };
          }
          return { config: candidate, reset: false };
        }
      } catch {
        return { config: DEFAULT_ANONYMIZE_CONFIG, reset: true };
      }
    }
    return { config: DEFAULT_ANONYMIZE_CONFIG, reset: false };
  });
  const [config, setConfig] = useState<AnonymizeConfig>(storedConfig.config);

  // 维护自动识别实体的用户开关与自定义替换词覆盖
  const [entityOverrides, setEntityOverrides] = useState<AnonymizeEntityOverrides>({});

  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [downloadingMd, setDownloadingMd] = useState(false);
  const [downloadingDocx, setDownloadingDocx] = useState(false);
  const [errorText, setErrorText] = useState("");
  // 预检会卸载编辑区，规则草稿留在容器中，返回修改时保持输入。
  const [newSource, setNewSource] = useState("");
  const [newReplacement, setNewReplacement] = useState("");

  // 持久化存储用户基础配置
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      } catch {}
    }
  }, [config]);

  // 将自动识别实体中已启用的规则，与手动自定义规则合并
  const effectiveConfig = useMemo<AnonymizeConfig>(() => {
    const autoRules: CustomSensitiveRule[] = [];
    for (const ent of autoEntities) {
      const override = entityOverrides[ent.source];
      // 默认策略：公司与项目默认启用脱敏，学校默认不启用
      const isEnabled = override?.enabled !== undefined
        ? override.enabled
        : (ent.kind === "company" || ent.kind === "project");
      const rep = (override?.replacement ?? ent.defaultReplacement).trim();

      if (isEnabled && rep) {
        autoRules.push({
          id: ent.id,
          source: ent.source,
          replacement: rep,
        });
      }
    }

    // 过滤掉同名已被自动规则覆盖的手动规则，避免重复
    const manualRules = config.customRules.filter(
      (r) => !autoRules.some((a) => a.source.toLowerCase() === r.source.toLowerCase())
    );

    return {
      ...config,
      customRules: [...autoRules, ...manualRules],
    };
  }, [config, autoEntities, entityOverrides]);

  // 实时脱敏计算与命中统计
  const anonymizedModules = useMemo(
    () => anonymizeResumeModules(modules, effectiveConfig),
    [modules, effectiveConfig]
  );

  const anonymizedTitle = useMemo(
    () => anonymizeResumeTitle(title, modules, effectiveConfig),
    [title, modules, effectiveConfig]
  );

  const stats = useMemo(
    () => calculateAnonymizeStats(modules, effectiveConfig),
    [modules, effectiveConfig]
  );

  const originalBasic = useMemo(() => {
    const mod = modules.find((m) => m.type === "basic");
    return (mod?.content ?? {}) as Partial<BasicContent>;
  }, [modules]);

  const anonymizedBasic = useMemo(() => {
    const mod = anonymizedModules.find((m) => m.type === "basic");
    return (mod?.content ?? {}) as Partial<BasicContent>;
  }, [anonymizedModules]);

  function handleToggleEntity(source: string, enabled: boolean) {
    setEntityOverrides((prev) => ({
      ...prev,
      [source]: {
        ...prev[source],
        enabled,
      },
    }));
  }

  function handleEntityReplacementChange(source: string, replacement: string) {
    setEntityOverrides((prev) => ({
      ...prev,
      [source]: {
        ...prev[source],
        replacement,
      },
    }));
  }

  // 导出 Markdown（纯前端即时生成）
  async function handleExportMarkdown() {
    setErrorText("");
    setDownloadingMd(true);
    try {
      await beforeExport?.();
      const mdContent = resumeToMarkdown(anonymizedTitle, anonymizedModules);

      const blob = new Blob([mdContent], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${anonymizedTitle}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onClose();
    } catch (err: unknown) {
      setErrorText(errorMessage(err));
      throw err;
    } finally {
      setDownloadingMd(false);
    }
  }

  // 导出 PDF（向后端请求脱敏流）
  async function handleExportPdf(confirmedIssueIds: string[], skipExportCheck: boolean) {
    setErrorText("");
    setDownloadingPdf(true);
    try {
      await beforeExport?.();
      const res = await apiFetch(`/api/resumes/${resumeId}/export/pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonymizeConfig: effectiveConfig, confirmedIssueIds, skipExportCheck }),
      });

      if (!res.ok) {
        let msg = "生成脱敏 PDF 失败，请稍后重试";
        try {
          const errJson = (await res.json()) as { error?: string };
          if (errJson.error) msg = errJson.error;
        } catch {}
        throw new Error(msg);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const filename = res.headers.get("Content-Disposition")?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      a.download = filename ? decodeURIComponent(filename) : "[脱敏版] 简历.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onClose();
    } catch (err: unknown) {
      setErrorText(errorMessage(err));
      throw err;
    } finally {
      setDownloadingPdf(false);
    }
  }

  async function handleExportDocx(confirmedIssueIds: string[], skipExportCheck: boolean) {
    setErrorText("");
    setDownloadingDocx(true);
    try {
      await beforeExport?.();
      await downloadCheckedResume(resumeId, "[脱敏版] 简历", "docx", confirmedIssueIds, { anonymizeConfig: effectiveConfig, skipExportCheck });
      onClose();
    } catch (err: unknown) {
      setErrorText(errorMessage(err));
      throw err;
    } finally {
      setDownloadingDocx(false);
    }
  }

  if (!open) return null;

  return (
    <>
    {resumeStyle && (
      <div aria-hidden className="no-print pointer-events-none" style={{ position: "fixed", left: -10000, top: 0, width: "210mm" }}>
        <div ref={exportPaperRef} className="bg-white text-black">
          <ResumeDoc prepared={prepare(anonymizedTitle, anonymizedModules)} style={resumeStyle} />
        </div>
      </div>
    )}
    <Modal
      open={open && exportFormat === null}
      title={
        <div className="flex items-center gap-2">
          <span className="text-xl">🛡️</span>
          <span className="font-serif text-lg font-bold text-ink">
            敏感隐私一键脱敏导出
          </span>
        </div>
      }
      description="自动识别简历中填写的联系方式、公司名称、项目与学校，智能转换为保密通用代号，一键生成脱敏保密版简历。"
      onClose={onClose}
      loading={downloadingPdf || downloadingDocx}
      loadingText={downloadingPdf ? "正在生成脱敏版 PDF…" : "正在生成脱敏版 Word (DOCX)…"}
      loadingDescription="正在执行敏感信息遮蔽与排版渲染，请稍候…"
    >
      <div className="space-y-6 pt-1 max-h-[75vh] overflow-y-auto pr-1">
        {storedConfig.reset && <p role="status" className="text-xs text-accent">保存的脱敏配置格式无效，已恢复默认脱敏设置。请核对规则后导出。</p>}
        {errorText && (
          <div className="rounded-lg bg-danger-wash p-3 text-xs text-danger font-medium border border-danger/20">
            ⚠️ {errorText}
          </div>
        )}

        {/* 1. 自动识别的个人信息与联系方式 */}
        <AnonymizeBasicConfigEditor config={config} setConfig={setConfig} originalBasic={originalBasic} />

        {/* 2–4. 自动识别的公司、项目与学校 */}
        <AnonymizeEntityEditor
          autoEntities={autoEntities}
          entityOverrides={entityOverrides}
          onToggleEntity={handleToggleEntity}
          onReplacementChange={handleEntityReplacementChange}
        />

        {/* 5. 补充自定义保密词替换 (可选) */}
        <AnonymizeCustomRulesEditor
          config={config}
          setConfig={setConfig}
          newSource={newSource}
          setNewSource={setNewSource}
          newReplacement={newReplacement}
          setNewReplacement={setNewReplacement}
          onError={setErrorText}
        />

        {/* 6. 实时脱敏效果预览与统计摘要 */}
        <AnonymizePreview
          stats={stats}
          originalBasic={originalBasic}
          anonymizedBasic={anonymizedBasic}
          avatarEnabled={config.avatar.enabled}
        />
      </div>

      {/* 底部操作栏 */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <button type="button" onClick={onClose} className={btnGhost}>
          取消
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => requestExport("md")}
            disabled={downloadingMd || downloadingPdf || downloadingDocx}
            className={`${btnGhost} text-xs`}
            title="生成纯本地脱敏的 Markdown 文件"
          >
            {downloadingMd ? "正在生成 MD..." : "📄 导出脱敏 Markdown"}
          </button>
          <button
            type="button"
            onClick={() => requestExport("docx")}
            disabled={downloadingMd || downloadingPdf || downloadingDocx}
            className={`${btnGhost} text-xs`}
            title="生成可编辑的脱敏 Word 文档，保留模板样式；头像按脱敏设置处理"
          >
            {downloadingDocx ? "正在生成脱敏 DOCX..." : "导出脱敏 DOCX"}
          </button>
          <button
            type="button"
            onClick={() => requestExport("pdf")}
            disabled={downloadingPdf || downloadingMd || downloadingDocx}
            className={`${btnPrimary} text-xs`}
            title="请求生成保密脱敏的矢量 A4 PDF 简历"
          >
            {downloadingPdf ? "正在生成脱敏 PDF..." : "📥 导出脱敏 PDF"}
          </button>
        </div>
      </div>
    </Modal>
    <ResumeExportCheckDialog
      open={open && exportFormat !== null}
      title={title}
      modules={modules}
      exportedContent={{ title: anonymizedTitle, modules: anonymizedModules }}
      layout={exportLayout}
      paperHeight={paperHeight}
      pageMargin={pageMargin}
      onClose={() => setExportFormat(null)}
      onLocate={(issue) => {
        setExportFormat(null);
        if (issue.inExportedContent) {
          setErrorText("该问题来自脱敏替换结果，请修改对应的替换内容后重新导出：" + issue.excerpt);
          return;
        }
        onClose();
        onLocate?.(issue);
      }}
      onContinue={async (confirmed, skipExportCheck) => {
        if (exportFormat === "pdf") await handleExportPdf(confirmed, skipExportCheck);
        else if (exportFormat === "docx") await handleExportDocx(confirmed, skipExportCheck);
        else await handleExportMarkdown();
      }}
    />
    </>
  );
}
