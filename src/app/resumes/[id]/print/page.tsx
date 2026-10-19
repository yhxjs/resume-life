"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { flushSync } from "react-dom";
import { ResumeExportCheckDialog } from "@/components/resume/resume-export-check-dialog";
import { downloadCheckedResume, measureResumeExportLayout } from "@/lib/resume-export-client";
import { inspectResumeForExport, type ResumeExportIssue, type ResumeExportLayoutEntry } from "@/lib/resume-export-check";
import { isTemplateRef, resolveStyle, type CustomTemplate, type ResumeStyleOverrides } from "@/lib/templates";
import { prepare, ResumeDoc } from "@/components/resume/doc";
import { TemplatePicker } from "@/components/resume/template-picker";
import { InlineError } from "@/components/common/inline-error";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import { jsonFetch } from "@/lib/fetcher";
import { apiFetch } from "@/lib/api-fetch";
import { btnGhost, btnPrimary } from "@/lib/ui";
import type { ModuleData } from "@/lib/modules";
import { errorMessage } from "@/lib/error-message";
import { useResumeZoom } from "@/hooks/use-resume-zoom";
import { ZoomControls } from "@/components/resume/zoom-controls";
import { AnonymizeExportDialog } from "@/components/resume/anonymize-export-dialog";

type ResumeData = {
  resume: { id: number; title: string; template: string; dataGeneration?: string | null; style_overrides?: ResumeStyleOverrides; styleCorrupted?: boolean; created_at: string; updated_at: string };
  modules: ModuleData[];
  warnings?: string[];
  corruptedKeys?: string[];
};

export default function PrintPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<ResumeData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [template, setTemplate] = useState("classic");
  const savedTemplateRef = useRef("classic");
  const pendingTemplateSaveRef = useRef<Promise<void> | null>(null);
  const templateSelectionRef = useRef(0);
  const [templateSaveError, setTemplateSaveError] = useState("");
  const [customs, setCustoms] = useState<CustomTemplate[]>([]);
  const [templateLoadError, setTemplateLoadError] = useState("");
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templateReloadVersion, setTemplateReloadVersion] = useState(0);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [anonymizeDialogOpen, setAnonymizeDialogOpen] = useState(false);
  const [exportAction, setExportAction] = useState<"pdf" | "md" | "print" | null>(null);
  const [exportLayout, setExportLayout] = useState<ResumeExportLayoutEntry[]>([]);
  const [printApproval, setPrintApproval] = useState<string[]>([]);
  const [skipPrintCheck, setSkipPrintCheck] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  function requestExport(action: "pdf" | "md" | "print" | "anonymize") {
    if (integrityError) {
      setDownloadError(integrityError);
      return;
    }
    setExportLayout(measureResumeExportLayout(paperRef.current));
    if (action === "anonymize") setAnonymizeDialogOpen(true);
    else setExportAction(action);
  }

  function locateExportIssue(issue: ResumeExportIssue) {
    const target = new URLSearchParams({ module: issue.moduleKey === "__layout__" ? data?.modules.at(-1)?.key ?? "basic" : issue.moduleKey });
    if (issue.entryIndex !== undefined) target.set("entry", String(issue.entryIndex));
    if (issue.entryId) target.set("item", issue.entryId);
    if (issue.field) target.set("field", issue.field);
    router.push(`/resumes/${params.id}#${target}`);
  }

  useEffect(() => {
    const reset = () => { setPrintApproval([]); setSkipPrintCheck(false); };
    window.addEventListener("afterprint", reset);
    return () => window.removeEventListener("afterprint", reset);
  }, []);

  const {
    scale,
    isAutoFit,
    canZoomIn,
    canZoomOut,
    viewportClassName,
    containerRef,
    paperRef,
    paperHeight,
    zoomIn,
    zoomOut,
    setManualScale,
    resetToAuto,
    handleViewportPointerDown,
  } = useResumeZoom({ defaultMode: "manual", defaultManualScale: 1.0, padding: 32 });

  useEffect(() => {
    let cancelled = false;
    jsonFetch<ResumeData>(`/api/resumes/${params.id}`)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        if (isTemplateRef(d.resume.template)) {
          savedTemplateRef.current = d.resume.template;
          setTemplate(d.resume.template);
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => { cancelled = true; };
  }, [params.id, loadAttempt]);

  useEffect(() => {
    let cancelled = false;
    jsonFetch<{ items: CustomTemplate[] }>("/api/templates")
      .then((d) => {
        if (cancelled) return;
        setCustoms(d.items);
        setTemplatesLoaded(true);
        setTemplateLoadError("");
      })
      .catch((reason) => {
        if (!cancelled) setTemplateLoadError(errorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [templateReloadVersion]);

  function switchTemplate(ref: string) {
    const selection = ++templateSelectionRef.current;
    const priorSave = pendingTemplateSaveRef.current;
    setTemplate(ref);
    setTemplateSaveError("");
    setDownloadError("");
    const save = (async () => {
      try {
        await priorSave?.catch(() => undefined);
        await jsonFetch(`/api/resumes/${params.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ template: ref, dataGeneration: data?.resume.dataGeneration }),
        });
        savedTemplateRef.current = ref;
      } catch (err) {
        if (selection === templateSelectionRef.current) {
          setTemplate(savedTemplateRef.current);
          setTemplateSaveError(errorMessage(err));
        }
        throw err;
      }
    })();
    pendingTemplateSaveRef.current = save;
    void save.then(
      () => { if (pendingTemplateSaveRef.current === save) pendingTemplateSaveRef.current = null; },
      () => { if (pendingTemplateSaveRef.current === save) pendingTemplateSaveRef.current = null; },
    );
  }

  async function waitForTemplateSave() {
    let pending = pendingTemplateSaveRef.current;
    while (pending) {
      await pending;
      const latest = pendingTemplateSaveRef.current;
      pending = latest !== pending ? latest : null;
    }
  }

  async function handleDownloadPdf(confirmedIssueIds: string[], skipExportCheck: boolean) {
    setDownloadError("");
    setDownloadingPdf(true);
    try {
      await waitForTemplateSave();
      const res = await apiFetch(`/api/resumes/${params.id}/export/pdf`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmedIssueIds, skipExportCheck }),
      });
      if (!res.ok) {
        let msg = "生成 PDF 失败，请稍后重试";
        try {
          const errJson = await res.json() as { error?: string };
          if (errJson.error) msg = errJson.error;
        } catch {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const rawTitle = data?.resume.title || "简历";
      a.download = `${rawTitle}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(errorMessage(err));
      throw err;
    } finally {
      setDownloadingPdf(false);
    }
  }

  if (loadError) return <LoadError message={loadError} onRetry={() => { setLoadError(""); setLoadAttempt((attempt) => attempt + 1); }} />;
  if (!data) return <Loading />;

  const prepared = prepare(data.resume.title, data.modules);
  const currentStyle = resolveStyle(template, customs, data.resume.style_overrides);
  const selectedCustom = template.startsWith("custom:") ? customs.find((item) => `custom:${item.id}` === template) : undefined;
  const templateIntegrityError = !template.startsWith("custom:") ? ""
    : templateLoadError || !templatesLoaded ? "导出已暂停：自定义模板尚未成功加载，请重试加载。"
    : selectedCustom?.corrupted ? "导出已暂停：模板数据损坏，请到样式工厂修复后重新导出。"
    : !selectedCustom ? "导出已暂停：自定义模板不存在，请重新选择模板。" : "";
  const integrityError = (data.resume.styleCorrupted ? "导出已暂停：排版数据损坏，请返回编辑页显式保存排版后重新导出。" : "")
    || (data.corruptedKeys?.length ? "导出已暂停：部分模块数据损坏，请返回编辑页修复后重新导出。" : "") || templateIntegrityError;
  const printBlocked = Boolean(integrityError) || (!skipPrintCheck && !inspectResumeForExport({ title: data.resume.title, modules: data.modules, confirmedIssueIds: new Set(printApproval) }).canExport);

  return (
    <div className="print-container mx-auto max-w-[900px] pb-12">
      <LoadingOverlay
        show={downloadingPdf}
        fullScreen
        message="正在编译渲染高保真 PDF…"
        description="正在进行矢量排版计算与字体打包，请稍候…"
      />
      <style>{`
        @page {
          size: A4;
          margin-top: ${currentStyle.pageMargin}mm;
          margin-bottom: ${currentStyle.pageMargin}mm;
          margin-left: 0;
          margin-right: 0;
        }
        @page :first {
          margin-top: 0mm;
        }
        @media print {
          *, *::before, *::after {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          header, footer, .no-print { display: none !important; }
          main, .print-container {
            padding: 0 !important;
            margin: 0 !important;
            max-width: none !important;
            width: 100% !important;
          }
          .zoom-viewport, .zoom-stage {
            overflow: visible !important;
            max-height: none !important;
            height: auto !important;
            width: auto !important;
            min-width: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
            border: none !important;
            background: transparent !important;
            box-shadow: none !important;
          }
          .zoom-stage > div {
            transform: none !important;
            width: auto !important;
          }
          .paper {
            width: 210mm !important;
            min-height: auto !important;
            border: none !important;
            box-shadow: none !important;
            margin: 0 auto !important;
            transform: none !important;
          }
          body { background: #fff !important; }
        }
      `}</style>

      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Link href={`/resumes/${params.id}`} className={btnGhost}>
          ← 返回编辑
        </Link>
        <TemplatePicker value={template} customs={customs} onChange={switchTemplate} />
        <InlineError message={integrityError || templateSaveError || downloadError} />
        <ZoomControls
          scale={scale}
          isAutoFit={isAutoFit}
          canZoomIn={canZoomIn}
          canZoomOut={canZoomOut}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onSelectScale={setManualScale}
          onResetAutoFit={resetToAuto}
        />
        <InlineError
          message={templateLoadError}
          onRetry={() => setTemplateReloadVersion((version) => version + 1)}
        />
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className={btnGhost}
            onClick={() => requestExport("anonymize")}
            title="一键隐去联系方式与个人隐私，替换保密代号后导出"
          >
            🛡️ 隐私脱敏导出
          </button>
          <button
            type="button"
            onClick={() => requestExport("md")}
            className={btnGhost}
            title="导出当前简历为 Markdown (.md) 文件"
          >
            导出 Markdown
          </button>
          <button
            className={btnPrimary}
            onClick={() => requestExport("pdf")}
            disabled={downloadingPdf}
            title="生成标准矢量 PDF 文件，文字可选中且支持重新导入 AI 解析"
          >
            {downloadingPdf ? "正在生成 PDF..." : "📥 直接下载 PDF"}
          </button>
          <button className={btnGhost} onClick={() => requestExport("print")}>
            浏览器打印
          </button>
        </div>
      </div>
      <p className="no-print mb-3 text-xs text-faint">
        💡 建议优先使用<strong>「直接下载 PDF」</strong>生成标准无杂质矢量文件；若使用「浏览器打印」，请在打印预览的「更多设置」中<strong>取消勾选「页眉和页脚」</strong>（边距保持「默认」），即可在保留换页上下边距的同时去除顶部网址与底部日期标题。
      </p>

      <div
        ref={containerRef}
        onPointerDown={handleViewportPointerDown}
        className={`zoom-viewport w-full rounded-2xl border border-line/80 bg-surface/50 p-4 shadow-inner overflow-auto [scrollbar-gutter:stable] flex justify-center ${viewportClassName}`}
        style={{ minHeight: 500, scrollbarGutter: "stable" }}
      >
        <div
          className="zoom-stage mx-auto my-auto relative shrink-0 transition-transform duration-75"
          style={{
            width: Math.round(794 * scale),
            height: Math.round(paperHeight * scale),
            minWidth: Math.round(794 * scale),
          }}
        >
          <div
            style={{
              width: 794,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          >
            <div
              ref={paperRef}
              className="paper min-h-[297mm] w-[210mm] bg-white text-black shadow-[0_1px_3px_oklch(0_0_0/0.1),0_12px_32px_oklch(0_0_0/0.1)]"
            >
              <ResumeDoc prepared={prepared} style={currentStyle} />
            </div>
          </div>
        </div>
      </div>

      {printBlocked && (
        <>
          <style>{"@media print { .paper { display: none !important; } .export-print-blocked { display: block !important; } }"}</style>
          <p className="export-print-blocked hidden">{integrityError || "导出已暂停：请先通过页面上的「浏览器打印」完成数字和占位符检查。"}</p>
        </>
      )}
      <ResumeExportCheckDialog
        open={exportAction !== null}
        title={data.resume.title}
        modules={data.modules}
        layout={exportLayout}
        paperHeight={paperHeight}
        pageMargin={currentStyle.pageMargin}
        onClose={() => setExportAction(null)}
        onLocate={locateExportIssue}
        onContinue={async (confirmed, skipExportCheck) => {
          if (integrityError) throw new Error(integrityError);
          if (exportAction === "pdf") await handleDownloadPdf(confirmed, skipExportCheck);
          else if (exportAction === "md") await downloadCheckedResume(params.id, data.resume.title, "md", confirmed, { skipExportCheck });
          else {
            await waitForTemplateSave();
            flushSync(() => { setPrintApproval(confirmed); setSkipPrintCheck(skipExportCheck); setExportAction(null); });
            window.print();
          }
        }}
      />
      <AnonymizeExportDialog
        open={anonymizeDialogOpen}
        onClose={() => setAnonymizeDialogOpen(false)}
        resumeId={params.id}
        title={data.resume.title}
        modules={data.modules}
        beforeExport={waitForTemplateSave}
        resumeStyle={currentStyle}
        onLocate={locateExportIssue}
        layout={exportLayout}
        paperHeight={paperHeight}
        pageMargin={currentStyle.pageMargin}
      />
    </div>
  );
}
