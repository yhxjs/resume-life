"use client";

import Link from "next/link";
import { PublishVersionButton } from "@/components/resume/publish-version-button";
import { btnGhost } from "@/lib/ui";
import { Loading, LoadError, Empty, SectionTitle } from "@/components/common/ui-bits";
import { PreparationReturnLink } from "@/components/application/preparation-return-link";
import type { Status } from "@/components/resume/module-editors";
import { AddModuleDialog, ModuleTabs } from "@/components/resume/module-tabs";
import { ResumeEditorPreview } from "@/components/resume/editor-preview";
import { ResumeModuleRenderer } from "@/components/resume/module-renderer";
import { ResumeEditorTitlebar } from "@/components/resume/editor-titlebar";
import { MetricBeautifyDialog } from "@/components/resume/metric-beautify-dialog";
import { FormatBeautifyDialog } from "@/components/resume/format-beautify-dialog";
import { readDescribableItems } from "@/lib/module-descriptions";
import { useResumeEditorController } from "@/hooks/use-resume-editor-controller";
import { BackToTop } from "@/components/common/back-to-top";

export function ResumeEditor({ id }: { id: string }) {
  const {
    modules,
    titleDraft,
    template,
    styleOverrides,
    customs,
    templateLoadError,
    setTemplateReloadVersion,
    activeKey,
    setActiveKey,
    loadError,
    retryLoad,
    status,
    warnings,
    styleCorrupted,
    addOpen,
    setAddOpen,
    mobileTab,
    setMobileTab,
    setEditLocateTarget,
    rightEditorContainerRef,
    saveError,
    storageError,
    savePhase,
    nextRetryAt,
    canUndo,
    canRedo,
    undo,
    redo,
    setDraft,
    handleBeautifyApply,
    addModule,
    removeModule,
    renameModule,
    moveModule,
    commitOrder,
    handleTitleChange,
    saveTitle,
    retrySave,
    switchTemplate,
    handleUpdateStyleOverrides,
    updateAvatarOffset,
    applySuggestion,
  } = useResumeEditorController(id);

  if (loadError) return <LoadError message={loadError} onRetry={retryLoad} />;
  if (!modules) return <Loading />;

  const active = modules.find((m) => m.key === activeKey) ?? modules[0];
  const st = (key: string): Status => {
    const moduleStatus = status[key] ?? "idle";
    return savePhase === "blocked" && moduleStatus === "err" ? "idle" : moduleStatus;
  };
  const retryTime = nextRetryAt === null
    ? ""
    : new Date(nextRetryAt).toLocaleTimeString("zh-CN", { hour12: false });

  return (
    <div>
      <PreparationReturnLink />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <p className="text-sm text-muted">正在编辑草稿 · 发布后可绑定到投递、面试等记录</p>
        <div className="flex flex-wrap gap-2"><Link href={`/resumes/${id}/versions`} className={btnGhost}>查看版本树</Link><PublishVersionButton resumeId={id} /></div>
      </div>
      {/* 移动端/窄屏专属分段切换控制器：编辑内容 vs 简历预览 */}
      <div className="lg:hidden sticky top-14 z-20 -mx-4 px-4 py-2 bg-bg/95 backdrop-blur border-b border-line mb-4">
        <div className="flex rounded-xl bg-surface p-1 border border-line">
          <button
            type="button"
            onClick={() => setMobileTab("edit")}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors min-h-[38px] ${
              mobileTab === "edit"
                ? "bg-card text-ink shadow-xs font-semibold"
                : "text-muted hover:text-ink"
            }`}
          >
            📝 编辑内容
          </button>
          <button
            type="button"
            onClick={() => setMobileTab("preview")}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors min-h-[38px] ${
              mobileTab === "preview"
                ? "bg-card text-ink shadow-xs font-semibold"
                : "text-muted hover:text-ink"
            }`}
          >
            👁️ 简历预览
          </button>
        </div>
      </div>

      {(savePhase === "blocked" || savePhase === "retry-wait" || storageError) && (
        <div role="alert" className="mb-4 rounded-lg border border-danger/30 bg-danger-wash px-4 py-3 text-sm text-danger">
          {savePhase === "blocked" && (
            <>
              <p>保存失败：{saveError}</p>
              <p>自动重试已停止，草稿仅在当前标签页中保留。</p>
            </>
          )}
          {savePhase === "retry-wait" && (
            <>
              <p>暂时无法保存：{saveError}</p>
              <p>草稿仅在当前标签页中保留，服务器恢复后会自动重试。</p>
              <p>{retryTime ? `将在 ${retryTime} 自动重试。` : "正在等待服务器确认。"}</p>
            </>
          )}
          {storageError && (
            <p>浏览器无法保留本地草稿，请等待保存成功后再关闭或刷新页面。</p>
          )}
          {savePhase === "blocked" && (
            <button type="button" className="mt-2 underline" onClick={retrySave}>重试保存</button>
          )}
          {savePhase === "retry-wait" && nextRetryAt !== null && (
            <button type="button" className="mt-2 underline" onClick={retrySave}>立即重试</button>
          )}
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_480px]">
        {/* 左：实时简历文档 */}
        <ResumeEditorPreview
          id={id}
          titleDraft={titleDraft}
          modules={modules}
          template={template}
          customs={customs}
          styleOverrides={styleOverrides}
          onUpdateStyleOverrides={handleUpdateStyleOverrides}
          activeKey={active?.key ?? ""}
          onSelectModule={setActiveKey}
          onOrderCommit={commitOrder}
          onAddModule={() => setAddOpen(true)}
          templateLoadError={templateLoadError}
          onRetryTemplates={() => setTemplateReloadVersion((version) => version + 1)}
          onTemplatesChanged={() => setTemplateReloadVersion((version) => version + 1)}
          mobileTab={mobileTab}
          onSwitchTemplate={switchTemplate}
          onApplySuggestion={applySuggestion}
          onUpdateAvatarOffset={updateAvatarOffset}
          onLocateTarget={(target) => {
            setActiveKey(target.key);
            setMobileTab("edit");
            setEditLocateTarget(target);
          }}
        />

        {/* 右：编辑表单 */}
        <div
          ref={rightEditorContainerRef}
          className={mobileTab === "edit" ? "block" : "hidden lg:block"}
        >
          {warnings.length > 0 && (
            <div className="mb-4 rounded-lg border border-accent/30 bg-accent-wash px-4 py-2.5 text-sm text-ink">
              {warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
              {styleCorrupted && (
                <button type="button" className="mt-2 underline" onClick={() => handleUpdateStyleOverrides(null)}>
                  使用模板默认排版修复
                </button>
              )}
            </div>
          )}

          <ResumeEditorTitlebar
            title={titleDraft}
            onTitleChange={handleTitleChange}
            onSaveTitle={saveTitle}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
          />

        {modules.length > 0 ? (
          <>
            <ModuleTabs
              modules={modules}
              activeKey={active?.key ?? ""}
              onSelect={setActiveKey}
              onReorder={moveModule}
              onOrderCommit={commitOrder}
              onDelete={removeModule}
              onRename={renameModule}
              onAdd={() => setAddOpen(true)}
            />
            {active && (active.type === "work" || active.type === "projects") ? (
              <div className="pt-4 pb-1">
                <SectionTitle
                  right={
                    <div className="flex items-center gap-1">
                      <FormatBeautifyDialog
                        items={readDescribableItems(active.type, active.content)}
                        onApply={handleBeautifyApply(active.key, active.type)}
                      />
                      <MetricBeautifyDialog
                        resumeId={id}
                        moduleType={active.type}
                        items={readDescribableItems(active.type, active.content)}
                        onApply={handleBeautifyApply(active.key, active.type)}
                      />
                    </div>
                  }
                >
                  {active.label}
                </SectionTitle>
              </div>
            ) : null}
            <div className="pt-5">
              {active && (
                <ResumeModuleRenderer
                  module={active}
                  resumeId={id}
                  status={st(active.key)}
                  onDraftChange={setDraft}
                />
              )}
            </div>
          </>
        ) : (
          <div className="mt-6">
            <Empty>
              还没有任何模块。点击下方按钮，从模板模块中添加，或自定义一个新模块。
              <div className="mt-3">
                <button
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
                  onClick={() => setAddOpen(true)}
                >
                  + 添加模块
                </button>
              </div>
            </Empty>
          </div>
        )}
      </div>

        <AddModuleDialog open={addOpen} onClose={() => setAddOpen(false)} onSubmit={addModule} />
      </div>
      <BackToTop />
    </div>
  );
}
