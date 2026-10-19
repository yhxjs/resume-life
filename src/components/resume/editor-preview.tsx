"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ResumeExportCheckDialog } from "@/components/resume/resume-export-check-dialog";
import { downloadCheckedResume, measureResumeExportLayout } from "@/lib/resume-export-client";
import type { ResumeExportIssue, ResumeExportLayoutEntry } from "@/lib/resume-export-check";
import { getResumeSaveQueue } from "@/lib/resume-save-queue";
import { resumeWordCount, type ModuleData } from "@/lib/modules";
import { resolveStyle, type CustomTemplate, type ResumeStyleOverrides } from "@/lib/templates";
import { prepare, ResumeDoc } from "@/components/resume/doc";
import { TemplatePicker } from "@/components/resume/template-picker";
import { InlineError } from "@/components/common/inline-error";
import { DiagnoseDialog } from "@/components/resume/diagnose-dialog";
import { useResumeZoom } from "@/hooks/use-resume-zoom";
import { ZoomControls } from "@/components/resume/zoom-controls";
import { PageBreakGuide } from "@/components/resume/page-break-guide";
import { SpacingTuningPopover } from "@/components/resume/spacing-tuning-popover";
import { StyleTuningToolbar } from "@/components/resume/style-tuning-toolbar";
import { ModuleOutline } from "@/components/resume/module-outline";
import { AnonymizeExportDialog } from "@/components/resume/anonymize-export-dialog";
import { PortfolioExportDialog } from "@/components/portfolio/portfolio-export-dialog";
import { ResumeExportMenu } from "@/components/resume/resume-export-menu";
import type { DiagnosisField } from "@/lib/diagnosis";
import { motionSafeScrollBehavior, prefersReducedMotion } from "@/lib/reduced-motion";

interface ResumeEditorPreviewProps {
  id: string;
  titleDraft: string;
  modules: ModuleData[];
  template: string;
  customs: CustomTemplate[];
  styleOverrides?: ResumeStyleOverrides;
  onUpdateStyleOverrides?: (overrides: ResumeStyleOverrides | null) => void;
  activeKey?: string;
  onSelectModule?: (key: string) => void;
  onOrderCommit?: (orderedKeys: string[]) => void;
  onAddModule?: () => void;
  /** 定位指令：从大纲树点击定位时传入 */
  locateTarget?: { key: string; entryIndex?: number; field?: string; timestamp: number } | null;
  /** 大纲树点击定位回调（用于通知右侧编辑区域联动滚动高亮） */
  onLocateTarget?: (target: { key: string; entryIndex?: number; field?: string; timestamp: number }) => void;
  /** 自定义模板列表加载失败的原因；空串表示正常 */
  templateLoadError?: string;
  onRetryTemplates?: () => void;
  /** 自定义模板列表发生变化（如悬浮工具栏另存了新模板）时刷新下拉数据 */
  onTemplatesChanged?: () => void;
  mobileTab: "edit" | "preview";
  onSwitchTemplate: (tpl: string) => void;
  onApplySuggestion: (moduleKey: string, itemId: string, field: DiagnosisField, value: string | string[]) => boolean;
  onUpdateAvatarOffset?: (offsetX: number, offsetY: number) => void;
}

export function ResumeEditorPreview({
  id,
  titleDraft,
  modules,
  template,
  customs,
  styleOverrides = {},
  onUpdateStyleOverrides,
  activeKey,
  onSelectModule,
  onOrderCommit,
  onAddModule,
  locateTarget: propLocateTarget,
  onLocateTarget,
  templateLoadError = "",
  onRetryTemplates,
  onTemplatesChanged,
  mobileTab,
  onSwitchTemplate,
  onApplySuggestion,
  onUpdateAvatarOffset,
}: ResumeEditorPreviewProps) {
  const router = useRouter();
  const [exportAction, setExportAction] = useState<"print" | "markdown" | "docx" | null>(null);
  const [exportLayout, setExportLayout] = useState<ResumeExportLayoutEntry[]>([]);
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
  } = useResumeZoom({ defaultMode: "auto", padding: 32 });

  const [internalLocateTarget, setInternalLocateTarget] = useState<{
    key: string;
    entryIndex?: number;
    timestamp: number;
  } | null>(null);

  const locateTarget = propLocateTarget ?? internalLocateTarget;

  // A4 分页警戒线开关：默认关闭，支持持久化到 localStorage
  const [showPageBreakGuide, setShowPageBreakGuide] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("resume_page_break_guide") === "true";
    } catch {
      return false;
    }
  });

  const [anonymizeDialogOpen, setAnonymizeDialogOpen] = useState(false);
  const [portfolioDialogOpen, setPortfolioDialogOpen] = useState(false);

  async function prepareExport() {
    const queue = getResumeSaveQueue(id);
    await queue.flush();
    if (queue.needsUnloadWarning) throw new Error("草稿尚未保存成功，请先解决保存问题再导出");
  }

  function locateExportIssue(issue: ResumeExportIssue) {
    if (issue.kind === "pagination") handleToggleGuide(true);
    if (issue.moduleKey === "__layout__") {
      paperRef.current?.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
      return;
    }
    if (issue.moduleKey === "basic" && !modules.some((module) => module.key === "basic")) {
      onAddModule?.();
      return;
    }
    requestAnimationFrame((timestamp) => {
      const target = { key: issue.moduleKey, entryIndex: issue.entryIndex, field: issue.field, timestamp };
      setInternalLocateTarget(target);
      onLocateTarget?.(target);
    });
  }

  const handleToggleGuide = (show: boolean) => {
    setShowPageBreakGuide(show);
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("resume_page_break_guide", String(show));
      } catch {
        // 存储不可用时保留当前页面的开关状态。
      }
    }
  };

  const baseStyle = resolveStyle(template, customs);
  const currentStyle = resolveStyle(template, customs, styleOverrides);

  // 拖动过程中的实时瞬时偏移，松手时提交保存
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    initialX: number;
    initialY: number;
  } | null>(null);

  // 在移动端切换到预览 Tab 时重新触发自适应自测
  useEffect(() => {
    if (mobileTab === "preview") {
      resetToAuto();
    }
  }, [mobileTab, resetToAuto]);

  const isAutoFitRef = useRef(isAutoFit);
  const resetToAutoRef = useRef(resetToAuto);
  useEffect(() => {
    isAutoFitRef.current = isAutoFit;
    resetToAutoRef.current = resetToAuto;
  }, [isAutoFit, resetToAuto]);

  // 大纲树点击定位：纯几何数学映射平滑滚动，彻底避开 CSS transform 导致的浏览器 scrollIntoView 失效与跳跃
  useEffect(() => {
    if (!locateTarget) return;

    // 如果当前处于缩放状态，先恢复自适应缩放
    const hadZoom = !isAutoFitRef.current;
    if (hadZoom) {
      resetToAutoRef.current();
    }

    // 给自适应 scale 与尺寸测量留出充分稳定时间（缩放恢复给 150ms，未缩放给 25ms）
    const waitTime = hadZoom ? 150 : 25;

    let animFrameId: number | null = null;
    const timer = setTimeout(() => {
      const paper = paperRef.current;
      const container = containerRef.current;
      if (!paper || !container) return;

      const { key, entryIndex } = locateTarget;

      let targetEl: HTMLElement | null = null;
      if (entryIndex !== undefined) {
        // 先在对应的模块内寻找细项
        const modContainer = paper.querySelector<HTMLElement>(`[data-resume-module="${key}"]`);
        if (modContainer) {
          targetEl = modContainer.querySelector<HTMLElement>(`[data-resume-entry="${entryIndex}"]`);
          if (!targetEl) {
            const allEntries = modContainer.querySelectorAll<HTMLElement>("[data-resume-entry]");
            if (allEntries[entryIndex]) {
              targetEl = allEntries[entryIndex];
            }
          }
        }
        if (!targetEl) {
          targetEl = paper.querySelector<HTMLElement>(
            `[data-resume-module="${key}"] [data-resume-entry="${entryIndex}"]`
          );
        }
      }

      if (!targetEl) {
        targetEl = paper.querySelector<HTMLElement>(`[data-resume-module="${key}"]`);
      }
      if (!targetEl && (key === "basic" || key.includes("basic"))) {
        targetEl = paper.querySelector<HTMLElement>(`[data-resume-module="basic"]`);
      }

      if (!targetEl) return;

      let offsetTopInPaper = 0;
      let curr: HTMLElement | null = targetEl;
      while (curr && curr !== paper && curr !== document.body) {
        offsetTopInPaper += curr.offsetTop;
        curr = curr.offsetParent as HTMLElement | null;
      }

      const activeScale = scale > 0 ? scale : 1;
      const targetScaledY = offsetTopInPaper * activeScale;
      const targetScaledHeight = targetEl.offsetHeight * activeScale;

      // 4. 将目标舒适停靠在纸张视窗中（留出更充分的上方视野与呼吸感，避免贴顶）
      const viewportHeight = container.clientHeight;
      const desiredScrollTop = Math.max(0, targetScaledY - Math.max(100, (viewportHeight - targetScaledHeight) * 0.45));

      // 5. 检查外部浏览器 window 是否需要平滑滚动（确保预览视窗整体呈现在屏幕可视区域，留出 120px 顶部安全边距）
      const containerRect = container.getBoundingClientRect();
      const currentWindowY = window.scrollY;
      let targetWindowY: number | null = null;
      if (containerRect.top < 80 || containerRect.top > window.innerHeight - 150) {
        targetWindowY = Math.max(0, currentWindowY + containerRect.top - 120);
      }

      const triggerGlow = () => {
        if (!targetEl) return;
        targetEl.classList.remove("resume-highlight-pulse");
        void targetEl.offsetWidth;
        targetEl.classList.add("resume-highlight-pulse");
        setTimeout(() => {
          targetEl?.classList.remove("resume-highlight-pulse");
        }, 2300);
      };

      const scrollContainer = container;
      const startContainerY = scrollContainer.scrollTop;
      const diffContainerY = desiredScrollTop - startContainerY;
      const startWindowY = currentWindowY;
      const diffWindowY = targetWindowY !== null ? targetWindowY - startWindowY : 0;

      if (prefersReducedMotion()) {
        scrollContainer.scrollTop = desiredScrollTop;
        if (targetWindowY !== null) window.scrollTo({ top: targetWindowY, behavior: "auto" });
        triggerGlow();
        return;
      }

      // 如果相距很近，直接闪烁高亮
      if (Math.abs(diffContainerY) < 3 && Math.abs(diffWindowY) < 3) {
        triggerGlow();
        return;
      }

      const duration = 520; // 520ms 丝滑减速缓动
      const startTime = performance.now();
      let glowFired = false;
      const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

      function step(now: number) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = easeOut(progress);

        scrollContainer.scrollTop = startContainerY + diffContainerY * ease;
        if (diffWindowY !== 0) {
          window.scrollTo(0, startWindowY + diffWindowY * ease);
        }

        if (progress >= 0.5 && !glowFired) {
          glowFired = true;
          triggerGlow();
        }

        if (progress < 1) {
          animFrameId = requestAnimationFrame(step);
        } else {
          scrollContainer.scrollTop = desiredScrollTop;
          if (diffWindowY !== 0 && targetWindowY !== null) {
            window.scrollTo(0, targetWindowY);
          }
          if (!glowFired) triggerGlow();
        }
      }

      animFrameId = requestAnimationFrame(step);
    }, waitTime);

    return () => {
      clearTimeout(timer);
      if (animFrameId !== null) cancelAnimationFrame(animFrameId);
    };
  }, [locateTarget, containerRef, paperRef, scale]);

  const prepared = prepare(titleDraft || "简历", modules);
  if (dragOffset && prepared.avatar) {
    prepared.avatarX = dragOffset.x;
    prepared.avatarY = dragOffset.y;
  }

  const handleAvatarPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onUpdateAvatarOffset) return;
    e.preventDefault();
    e.stopPropagation();

    const currentX = prepared.avatarX ?? 0;
    const currentY = prepared.avatarY ?? 0;
    dragStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialX: currentX,
      initialY: currentY,
    };
    setDragOffset({ x: currentX, y: currentY });

    const currentTarget = e.currentTarget;
    currentTarget.setPointerCapture(e.pointerId);

    const onPointerMove = (moveEvent: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      const effectiveScale = scale > 0 ? scale : 1;
      const deltaX = (moveEvent.clientX - state.startX) / effectiveScale;
      const deltaY = (moveEvent.clientY - state.startY) / effectiveScale;
      // 头像默认贴在右侧，向右拖动不能超过 0（防止越界出纸面/色块）；支持向左调整 -180px；上下微调 ±25px
      const nextX = Math.round(Math.min(Math.max(state.initialX + deltaX, -180), 0));
      const nextY = Math.round(Math.min(Math.max(state.initialY + deltaY, -25), 25));
      setDragOffset({ x: nextX, y: nextY });
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      currentTarget.removeEventListener("pointermove", onPointerMove);
      currentTarget.removeEventListener("pointerup", onPointerUp);
      currentTarget.removeEventListener("pointercancel", onPointerUp);
      try {
        currentTarget.releasePointerCapture(upEvent.pointerId);
      } catch {
        // pointer capture 异常安全兜底
      }

      const state = dragStateRef.current;
      dragStateRef.current = null;
      if (state) {
        const effectiveScale = scale > 0 ? scale : 1;
        const deltaX = (upEvent.clientX - state.startX) / effectiveScale;
        const deltaY = (upEvent.clientY - state.startY) / effectiveScale;
        const finalX = Math.round(Math.min(Math.max(state.initialX + deltaX, -180), 0));
        const finalY = Math.round(Math.min(Math.max(state.initialY + deltaY, -25), 25));
        setDragOffset(null);
        onUpdateAvatarOffset(finalX, finalY);
      }
    };

    currentTarget.addEventListener("pointermove", onPointerMove);
    currentTarget.addEventListener("pointerup", onPointerUp);
    currentTarget.addEventListener("pointercancel", onPointerUp);
  };

  return (
    <div
      className={`lg:sticky lg:top-20 lg:self-start ${
        mobileTab === "preview" ? "block" : "hidden lg:block"
      }`}
    >
      <div className="flex items-start gap-2.5">
        {/* 位于预览左外侧的悬浮操作区（大纲排序与样式调整） */}
        {((onOrderCommit && onSelectModule && onAddModule) || onUpdateStyleOverrides) && (
          <div className="no-print shrink-0 sticky top-24 z-30 pt-1 flex flex-col items-start gap-2">
            {onOrderCommit && onSelectModule && onAddModule && (
              <ModuleOutline
                modules={modules}
                activeKey={activeKey ?? ""}
                onSelect={onSelectModule}
                onOrderCommit={onOrderCommit}
                onAddModule={onAddModule}
                onLocate={(key, entryIndex) => {
                  const target = { key, entryIndex, timestamp: Date.now() };
                  setInternalLocateTarget(target);
                  onLocateTarget?.(target);
                }}
              />
            )}
            {onUpdateStyleOverrides && (
              <StyleTuningToolbar
                currentStyle={currentStyle}
                overrides={styleOverrides}
                template={template}
                customs={customs}
                onUpdateOverrides={onUpdateStyleOverrides}
                onTemplatesChanged={onTemplatesChanged}
                availableModules={modules
                  .filter((m) => m.type !== "basic")
                  .map((m) => ({ key: m.key || m.type, label: m.label }))}
              />
            )}
          </div>
        )}

        {/* 预览主体内容（顶栏与纸张视口，干净无遮挡） */}
        <div className="flex-1 min-w-0 space-y-3">
          <div className="no-print flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-card p-2 shadow-card-subtle">
            {/* 左侧：排版与视图区 */}
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              <TemplatePicker value={template} customs={customs} onChange={onSwitchTemplate} />
              {onUpdateStyleOverrides && (
                <SpacingTuningPopover
                  currentStyle={currentStyle}
                  baseStyle={baseStyle}
                  overrides={styleOverrides}
                  paperHeight={paperHeight}
                  showPageBreakGuide={showPageBreakGuide}
                  onTogglePageBreakGuide={handleToggleGuide}
                  onUpdateOverrides={onUpdateStyleOverrides}
                />
              )}
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
              <span
                className="rounded-md bg-surface px-1.5 py-1 font-mono text-[11px] text-muted border border-line/50"
                title="当前简历全文总字数"
              >
                {resumeWordCount(modules)} 字
              </span>
              <InlineError message={templateLoadError} onRetry={onRetryTemplates} />
            </div>

            {/* 右侧：AI 赋能 + 交付导出 */}
            <div className="flex items-center gap-1.5 sm:gap-2">
              {/* AI 诊断与排雷组 */}
              <div className="flex items-center gap-1.5">
                <DiagnoseDialog
                  resumeId={id}
                  modules={modules}
                  onApply={onApplySuggestion}
                  triggerClassName="inline-flex items-center gap-1 rounded-lg border border-line bg-card px-2 py-1.5 text-xs font-medium text-ink shadow-xs transition-colors hover:border-primary/50 hover:bg-surface cursor-pointer"
                />
                <Link
                  href={`/tools/defense?resumeId=${id}`}
                  className="inline-flex items-center gap-1 rounded-lg border border-danger/30 bg-danger/5 px-2 py-1.5 text-xs font-medium text-danger shadow-xs transition-colors hover:bg-danger/10 hover:border-danger/50"
                  title="让毒舌大厂面试官逐行扫描这份简历的高危软肋与防御预案"
                >
                  <span>💣 简历排雷</span>
                </Link>
              </div>

              {/* 分割线 */}
              <div className="h-4 w-px bg-line/80 shrink-0" aria-hidden="true" />

              {/* 交付导出下拉菜单 */}
              <ResumeExportMenu
                onRequestExport={(format) => {
                  setExportLayout(measureResumeExportLayout(paperRef.current));
                  if (format === "anonymize") setAnonymizeDialogOpen(true);
                  else if (format === "portfolio") setPortfolioDialogOpen(true);
                  else setExportAction(format);
                }}
              />
            </div>
          </div>

          <div className="relative">
            <div
              ref={containerRef}
              onPointerDown={handleViewportPointerDown}
              className={`zoom-viewport w-full rounded-2xl border border-line/80 bg-surface/50 p-4 shadow-xs overflow-auto [scrollbar-gutter:stable] flex justify-center lg:max-h-[calc(100vh-140px)] ${viewportClassName}`}
              style={{ minHeight: 400, scrollbarGutter: "stable" }}
            >
              <div
                className="zoom-stage mx-auto my-auto relative shrink-0"
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
                    className="paper relative min-h-[297mm] w-[210mm] bg-white text-black rounded-[2px]"
                  >
                    <ResumeDoc
                      key={`${template}_${JSON.stringify(styleOverrides)}`}
                      prepared={prepared}
                      style={currentStyle}
                      onAvatarPointerDown={prepared.avatar ? handleAvatarPointerDown : undefined}
                    />
                    <PageBreakGuide
                      visible={showPageBreakGuide}
                      paperHeight={paperHeight}
                      style={currentStyle}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <AnonymizeExportDialog
        open={anonymizeDialogOpen}
        onClose={() => setAnonymizeDialogOpen(false)}
        resumeId={id}
        title={titleDraft || "简历"}
        modules={modules}
        beforeExport={prepareExport}
        resumeStyle={currentStyle}
        onLocate={locateExportIssue}
        layout={exportLayout}
        paperHeight={paperHeight}
        pageMargin={currentStyle.pageMargin}
      />
      <PortfolioExportDialog
        isOpen={portfolioDialogOpen}
        onClose={() => setPortfolioDialogOpen(false)}
        resumeId={Number(id)}
        resumeTitle={titleDraft || "个人简历"}
        beforeExport={prepareExport}
      />
      <ResumeExportCheckDialog
        open={exportAction !== null}
        title={titleDraft}
        modules={modules}
        layout={exportLayout}
        paperHeight={paperHeight}
        pageMargin={currentStyle.pageMargin}
        onClose={() => setExportAction(null)}
        onLocate={locateExportIssue}
        continueLabel={exportAction === "print" ? "继续到打印预览" : "继续导出"}
        onContinue={async (confirmed, skipExportCheck) => {
          await prepareExport();
          if (exportAction === "print") router.push(`/resumes/${id}/print`);
          else await downloadCheckedResume(id, titleDraft, exportAction === "docx" ? "docx" : "md", confirmed, { skipExportCheck });
        }}
      />
    </div>
  );
}
