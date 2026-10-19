"use client";

import type { DatabaseStats } from "@/lib/backup";
import { badgeCls, btnPrimary, inputCls, labelCls } from "@/lib/ui";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import type { Feedback } from "./backup-manager-utils";

export function BackupExportSection({
  dbStats,
  loadingStats,
  exportPassword,
  exportConfirmation,
  exporting,
  exportFeedback,
  onExportPasswordChange,
  onExportConfirmationChange,
  onExport,
}: {
  dbStats: DatabaseStats | null;
  loadingStats: boolean;
  exportPassword: string;
  exportConfirmation: string;
  exporting: boolean;
  exportFeedback: Feedback | null;
  onExportPasswordChange: (password: string) => void;
  onExportConfirmationChange: (confirmation: string) => void;
  onExport: () => void;
}) {
  return (
    <div className="relative rounded-xl border border-line bg-surface p-4 sm:p-5 space-y-4">
      <LoadingOverlay
        show={exporting}
        message="正在生成加密备份…"
        description="正在读取数据库记录并进行加密打包，请稍候…"
      />
      <div>
        <h4 className="text-sm font-serif font-bold text-ink">全库加密备份包下载</h4>
        <p className="text-xs text-muted mt-0.5">密码仅用于本次导出，应用自身不持久化密码。</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelCls}>导出密码</span>
          <input
            className={`${inputCls} mt-1`}
            type="password"
            autoComplete="off"
            value={exportPassword}
            onChange={(event) => onExportPasswordChange(event.target.value)}
            disabled={exporting}
          />
        </label>
        <label className="block">
          <span className={labelCls}>确认导出密码</span>
          <input
            className={`${inputCls} mt-1`}
            type="password"
            autoComplete="off"
            value={exportConfirmation}
            onChange={(event) => onExportConfirmationChange(event.target.value)}
            disabled={exporting}
          />
        </label>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px] text-faint">密码长度为 12–256 个 Unicode code point，且两次输入必须一致。</p>
        <button type="button" className={btnPrimary} onClick={onExport} disabled={exporting}>
          {exporting ? "正在打包导出…" : "导出加密备份 (.rlbackup)"}
        </button>
      </div>
      {exportFeedback && (
        <div
          role={exportFeedback.kind === "err" ? "alert" : "status"}
          className={`rounded-lg px-3.5 py-2 text-xs font-medium ${
            exportFeedback.kind === "err"
              ? "border border-danger/25 bg-danger-wash text-danger"
              : "border border-primary/25 bg-primary-soft text-primary"
          }`}
        >
          {exportFeedback.text}
        </div>
      )}

      <div className="pt-2 border-t border-line/60 flex flex-wrap items-center gap-2 text-xs text-faint">
        <span className="font-medium text-muted">当前系统数据概览：</span>
        {loadingStats ? (
          <span>加载统计中…</span>
        ) : dbStats ? (
          <>
            <span className={badgeCls}>简历 {dbStats.resumes} 份</span>
            <span className={badgeCls}>项目 {dbStats.projects} 个</span>
            <span className={badgeCls}>面试 {dbStats.interviews} 场</span>
            <span className={badgeCls}>刷题练习 {dbStats.drills} 次</span>
            <span className={badgeCls}>通用题库 {dbStats.bank_entries} 条</span>
            <span className={badgeCls}>错题本 {dbStats.notebook_entries} 条</span>
            <span className="sm:ml-auto text-[11px] text-faint">共 {dbStats.totalRecords} 条记录</span>
          </>
        ) : (
          <span>无法获取统计</span>
        )}
      </div>
    </div>
  );
}
