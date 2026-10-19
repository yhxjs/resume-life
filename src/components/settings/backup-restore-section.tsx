"use client";

import type { ChangeEvent, RefObject } from "react";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import {
  badgeCls,
  badgePrimary,
  btnDangerSolid,
  btnGhost,
  btnPrimary,
  inputCls,
  labelCls,
  wellCls,
} from "@/lib/ui";
import {
  BACKUP_EXTENSION,
  BACKUP_MEDIA_TYPE,
  tableCount,
  type BackupValidation,
  type Feedback,
} from "./backup-manager-utils";

export function BackupRestoreSection({
  fileInputRef,
  selectedFile,
  importPassword,
  validatedBackup,
  validationError,
  validating,
  preserveAiConfig,
  restoring,
  restoreFeedback,
  onImportPasswordChange,
  onFileSelect,
  onChooseFile,
  onPreserveAiConfigChange,
  onRestore,
}: {
  fileInputRef: RefObject<HTMLInputElement | null>;
  selectedFile: File | null;
  importPassword: string;
  validatedBackup: BackupValidation | null;
  validationError: string | null;
  validating: boolean;
  preserveAiConfig: boolean;
  restoring: boolean;
  restoreFeedback: Feedback | null;
  onImportPasswordChange: (password: string) => void;
  onFileSelect: (event: ChangeEvent<HTMLInputElement>) => void;
  onChooseFile: () => void;
  onPreserveAiConfigChange: (preserve: boolean) => void;
  onRestore: () => void;
}) {
  return (
    <div className="relative rounded-xl border border-line bg-surface p-4 sm:p-5 space-y-4">
      <LoadingOverlay
        show={restoring}
        message="正在恢复并覆盖系统数据…"
        description="正在执行数据落库与状态同步，此过程通常耗时数秒，请勿关闭或刷新浏览器…"
      />
      <div>
        <h4 className="text-sm font-serif font-bold text-ink">从加密备份恢复</h4>
        <p className="text-xs text-danger mt-1">恢复将清空并完全覆盖当前系统的现有业务数据，请谨慎操作。</p>
      </div>

      <label className="block">
        <span className={labelCls}>导入密码</span>
        <input
          className={`${inputCls} mt-1`}
          type="password"
          autoComplete="off"
          value={importPassword}
          onChange={(event) => onImportPasswordChange(event.target.value)}
          disabled={restoring}
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="file"
          aria-label="备份文件"
          ref={fileInputRef}
          onChange={onFileSelect}
          accept={`${BACKUP_EXTENSION},${BACKUP_MEDIA_TYPE}`}
          className="hidden"
        />
        <button type="button" className={btnGhost} onClick={onChooseFile} disabled={restoring}>
          {selectedFile ? "更换备份文件" : "选择备份文件 (.rlbackup)"}
        </button>
        {selectedFile && (
          <span className="max-w-full break-all font-mono text-xs text-ink sm:max-w-xs">
            {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
          </span>
        )}
      </div>

      {validating && (
        <div role="status" className="rounded-lg border border-line bg-card px-3.5 py-2 text-xs text-muted">
          正在验证备份完整性…
        </div>
      )}
      {validationError && (
        <div role="alert" className="rounded-lg border border-danger/25 bg-danger-wash px-3.5 py-2 text-xs text-danger">
          备份验证失败：{validationError}
        </div>
      )}

      {validatedBackup && selectedFile && (
        <div className={`space-y-3 ${wellCls}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold text-ink">待恢复备份包详情</span>
            <span className={badgePrimary}>格式版本 v{validatedBackup.manifest.backupVersion}</span>
          </div>
          <div className="text-xs text-muted space-y-1 leading-relaxed">
            <div>文件名：<span className="break-all font-mono text-ink">{selectedFile.name}</span></div>
            <div>导出时间：<span className="font-mono text-ink">{new Date(validatedBackup.manifest.createdAt).toLocaleString("zh-CN")}</span></div>
            <div>备份数据库版本：{validatedBackup.manifest.dbVersion}</div>
            <div className="flex flex-wrap gap-1.5 pt-1.5">
              <span className={badgeCls}>简历 {tableCount(validatedBackup.stats, "resumes")} 份</span>
              <span className={badgeCls}>项目 {tableCount(validatedBackup.stats, "projects")} 个</span>
              <span className={badgeCls}>面试记录 {tableCount(validatedBackup.stats, "interviews")} 场</span>
              <span className={badgeCls}>专项练习 {tableCount(validatedBackup.stats, "drills")} 次</span>
              <span className={badgeCls}>通用题库 {tableCount(validatedBackup.stats, "bank_entries")} 条</span>
              <span className={badgeCls}>错题本 {tableCount(validatedBackup.stats, "notebook_entries")} 条</span>
              <span className={badgePrimary}>共 {validatedBackup.totalRecords} 条记录</span>
            </div>
          </div>

          <div className="pt-2 border-t border-line/60">
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={preserveAiConfig}
                onChange={(event) => onPreserveAiConfigChange(event.target.checked)}
                disabled={restoring}
                className="mt-0.5 h-4 w-4 rounded border-line text-primary focus:ring-primary/20"
              />
              <div>
                <span className="text-xs font-bold text-ink">保留当前设备的 AI Key 与模型配置（推荐）</span>
                <p className="text-[11px] text-faint leading-relaxed mt-0.5">
                  勾选后，备份中的 AI 配置不会覆盖当前设备上的 API 密钥、端点与模型设置。
                </p>
              </div>
            </label>
          </div>

          <div className="pt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[11px] text-danger font-medium">点击后将二次确认，再完全覆盖现有业务数据。</span>
            <button type="button" className={btnDangerSolid} onClick={onRestore} disabled={restoring}>
              {restoring ? "正在恢复并覆盖…" : "完全覆盖并恢复系统数据"}
            </button>
          </div>
        </div>
      )}

      {restoreFeedback && (
        <div
          role={restoreFeedback.kind === "err" ? "alert" : "status"}
          className={`rounded-lg px-4 py-2.5 text-xs font-medium ${
            restoreFeedback.kind === "err"
              ? "border border-danger/25 bg-danger-wash text-danger"
              : "border border-primary/25 bg-primary-soft text-primary"
          }`}
        >
          {restoreFeedback.text}
          {restoreFeedback.kind === "ok" && (
            <div className="mt-3 space-y-3">
              {restoreFeedback.snapshotCreated && (
                <div>
                  <p className="font-bold">恢复前灾备位置</p>
                  <code className="mt-1 block select-all break-all font-mono text-ink">
                    {restoreFeedback.snapshotCreated}
                  </code>
                </div>
              )}
              <button type="button" className={btnPrimary} onClick={() => window.location.reload()}>
                确认完成并刷新页面
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
