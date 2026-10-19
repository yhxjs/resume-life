"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { jsonFetch } from "@/lib/fetcher";
import { apiFetch } from "@/lib/api-fetch";
import type { DatabaseStats } from "@/lib/backup";
import { BackupExportSection } from "./backup-export-section";
import { BackupRestoreSection } from "./backup-restore-section";
import {
  BACKUP_MEDIA_TYPE,
  VALIDATION_DEBOUNCE_MS,
  backupFilename,
  encodePasswordHeader,
  isCompatibleBackup,
  passwordError,
  type BackupManifest,
  type BackupValidation,
  type Feedback,
} from "./backup-manager-utils";
import { errorMessage } from "@/lib/error-message";

export interface BackupManagerHandle {
  refreshStats: () => Promise<void>;
}

export const BackupManager = forwardRef<BackupManagerHandle>(function BackupManager(_, ref) {
  const [dbStats, setDbStats] = useState<DatabaseStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [exportConfirmation, setExportConfirmation] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<Feedback | null>(null);
  const exportAbort = useRef<AbortController | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const validationSequence = useRef(0);
  const validationAbort = useRef<AbortController | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importPassword, setImportPassword] = useState("");
  const [validatedBackup, setValidatedBackup] = useState<BackupValidation | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [preserveAiConfig, setPreserveAiConfig] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [restoreFeedback, setRestoreFeedback] = useState<Feedback | null>(null);

  async function loadStats(isCancelled?: () => boolean) {
    setLoadingStats(true);
    try {
      const response = await jsonFetch<{ ok: boolean; stats: DatabaseStats }>("/api/backup/stats");
      if (isCancelled?.()) return;
      setDbStats(response.ok && response.stats ? response.stats : null);
    } catch {
      if (isCancelled?.()) return;
      setDbStats(null);
    } finally {
      if (!isCancelled?.()) setLoadingStats(false);
    }
  }

  useImperativeHandle(ref, () => ({ refreshStats: loadStats }));

  useEffect(() => {
    let cancelled = false;
    loadStats(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    exportAbort.current?.abort();
    exportAbort.current = null;
  }, []);

  function invalidateValidation() {
    validationSequence.current += 1;
    validationAbort.current?.abort();
    validationAbort.current = null;
    setValidatedBackup(null);
    setValidationError(null);
    setValidating(false);
  }

  useEffect(() => {
    const sequence = ++validationSequence.current;
    validationAbort.current?.abort();
    validationAbort.current = null;
    setValidatedBackup(null);
    setValidating(false);

    if (!selectedFile || importPassword.length === 0) return;
    setValidationError(null);
    const invalidPassword = passwordError(importPassword);
    if (invalidPassword) {
      setValidationError(invalidPassword);
      return;
    }

    let controller: AbortController | null = null;
    const timeout = window.setTimeout(() => {
      controller = new AbortController();
      validationAbort.current = controller;
      setValidating(true);

      void (async () => {
        try {
          const response = await apiFetch("/api/backup/validate", {
            method: "POST",
            headers: {
              "Content-Type": BACKUP_MEDIA_TYPE,
              "X-Resume-Life-Backup-Password": encodePasswordHeader(importPassword),
            },
            body: selectedFile,
            signal: controller.signal,
          });
          const result = (await response.json()) as {
            ok?: boolean;
            error?: string;
            manifest?: BackupManifest;
            stats?: Record<string, number>;
            totalRecords?: number;
          };
          if (!response.ok || !result.ok || !result.manifest || !result.stats
              || !Number.isSafeInteger(result.totalRecords)) {
            throw new Error(result.error ?? "备份校验失败");
          }
          if (sequence !== validationSequence.current) return;
          setValidatedBackup({
            manifest: result.manifest,
            stats: result.stats,
            totalRecords: result.totalRecords as number,
          });
        } catch (error) {
          if (controller.signal.aborted || sequence !== validationSequence.current) return;
          setValidationError(error instanceof Error ? error.message : "备份校验失败");
        } finally {
          if (sequence === validationSequence.current) {
            setValidating(false);
            validationAbort.current = null;
          }
        }
      })();
    }, VALIDATION_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeout);
      controller?.abort();
    };
  }, [selectedFile, importPassword]);

  async function handleExport() {
    setExportFeedback(null);
    const invalidPassword = passwordError(exportPassword);
    if (invalidPassword) {
      setExportFeedback({ kind: "err", text: invalidPassword });
      return;
    }
    if (exportPassword !== exportConfirmation) {
      setExportFeedback({ kind: "err", text: "两次输入的导出密码不一致" });
      return;
    }

    const controller = new AbortController();
    exportAbort.current = controller;
    setExporting(true);
    setExportFeedback({ kind: "progress", text: "正在生成加密备份…" });
    try {
      const response = await apiFetch("/api/backup/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: exportPassword, confirmation: exportConfirmation }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(failure?.error ?? `HTTP ${response.status}`);
      }

      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = backupFilename(response.headers.get("Content-Disposition"));
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);

      setExportPassword("");
      setExportConfirmation("");
      setExportFeedback({ kind: "ok", text: "加密备份导出成功" });
    } catch (error) {
      if (controller.signal.aborted) return;
      setExportFeedback({
        kind: "err",
        text: `导出失败：${errorMessage(error)}`,
      });
    } finally {
      if (exportAbort.current === controller) {
        exportAbort.current = null;
        setExporting(false);
      }
    }
  }

  function handleFileSelect(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    invalidateValidation();
    setRestoreFeedback(null);
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (!isCompatibleBackup(file)) {
      setSelectedFile(null);
      event.target.value = "";
      setValidationError(file.name.toLowerCase().endsWith(".json")
        ? "不支持 JSON 文件，请选择 .rlbackup 加密备份"
        : "不兼容的备份文件，仅支持 .rlbackup 加密备份");
      return;
    }
    setSelectedFile(file);
  }

  function chooseBackupFile() {
    if (!fileInputRef.current) return;
    fileInputRef.current.value = "";
    fileInputRef.current.click();
  }

  async function handleRestore() {
    if (!selectedFile || !validatedBackup || passwordError(importPassword)) return;

    const confirmed = await confirmDialog({
      danger: true,
      title: "危险操作：完全覆盖现有数据",
      message:
        "恢复操作将清空当前数据库中所有的简历、知识库、面试记录、题库与错题本，并完全替换为备份文件中的数据！此操作不可撤销，是否确认继续？",
      confirmText: "确认完全覆盖并恢复",
      cancelText: "取消",
    });
    if (!confirmed) return;

    setRestoring(true);
    setRestoreFeedback({ kind: "progress", text: "正在恢复并覆盖系统数据…" });
    try {
      const response = await apiFetch("/api/backup/restore", {
        method: "POST",
        headers: {
          "Content-Type": BACKUP_MEDIA_TYPE,
          "X-Resume-Life-Backup-Password": encodePasswordHeader(importPassword),
          "X-Resume-Life-Preserve-Ai-Config": String(preserveAiConfig),
        },
        body: selectedFile,
      });
      const result = (await response.json()) as {
        ok: boolean;
        error?: string;
        stats?: Record<string, number>;
        snapshotCreated?: string;
      };
      if (!response.ok || !result.ok) throw new Error(result.error ?? "数据恢复失败");

      validationSequence.current += 1;
      validationAbort.current?.abort();
      validationAbort.current = null;
      setSelectedFile(null);
      setValidatedBackup(null);
      setValidationError(null);
      setImportPassword("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setRestoreFeedback({
        kind: "ok",
        text: "数据恢复成功。请保存灾备位置，确认完成后刷新页面以同步最新数据。",
        snapshotCreated: result.snapshotCreated,
      });
    } catch (error) {
      setRestoreFeedback({
        kind: "err",
        text: `恢复失败：${errorMessage(error)}`,
      });
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-card p-6 shadow-sm space-y-6">
      <div>
        <h3 className="font-serif text-lg font-bold text-ink">数据管理与灾备恢复</h3>
        <p className="text-xs text-muted mt-1 leading-relaxed text-pretty">
          将全量数据导出为加密的 .rlbackup 文件。备份密码不可找回；API Key 已位于加密密文中。
          {dbStats ? ` 当前数据库版本 ${dbStats.dbVersion}。` : ""}
        </p>
      </div>

      <BackupExportSection
        dbStats={dbStats}
        loadingStats={loadingStats}
        exportPassword={exportPassword}
        exportConfirmation={exportConfirmation}
        exporting={exporting}
        exportFeedback={exportFeedback}
        onExportPasswordChange={setExportPassword}
        onExportConfirmationChange={setExportConfirmation}
        onExport={handleExport}
      />

      <BackupRestoreSection
        fileInputRef={fileInputRef}
        selectedFile={selectedFile}
        importPassword={importPassword}
        validatedBackup={validatedBackup}
        validationError={validationError}
        validating={validating}
        preserveAiConfig={preserveAiConfig}
        restoring={restoring}
        restoreFeedback={restoreFeedback}
        onImportPasswordChange={(password) => {
          invalidateValidation();
          setImportPassword(password);
        }}
        onFileSelect={handleFileSelect}
        onChooseFile={chooseBackupFile}
        onPreserveAiConfigChange={setPreserveAiConfig}
        onRestore={handleRestore}
      />
    </div>
  );
});
