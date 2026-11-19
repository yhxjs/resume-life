"use client";

import {
  forwardRef,
  useEffect,
  useLayoutEffect,
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
  readBackupValidation,
  readBackupRestoreConfirmation,
  type BackupManifest,
  type BackupValidation,
  type Feedback,
} from "./backup-manager-utils";
import { errorMessage } from "@/lib/error-message";

export interface BackupManagerHandle {
  refreshStats: () => Promise<void>;
}

type BackupCommand = { kind: "export" | "restore"; controller: AbortController; allowingRetry?: boolean };
type ValidatedSelection = { file: File; password: string; sequence: number; backup: BackupValidation };

export const BackupManager = forwardRef<BackupManagerHandle>(function BackupManager(_, ref) {
  const [dbStats, setDbStats] = useState<DatabaseStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [exportConfirmation, setExportConfirmation] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<Feedback | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const validationSequence = useRef(0);
  const validationAbort = useRef<AbortController | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importPassword, setImportPassword] = useState("");
  const [validatedBackup, setValidatedBackup] = useState<BackupValidation | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [preserveAiConfig, setPreserveAiConfig] = useState(true);
  const [restorePhase, setRestorePhase] = useState<"idle" | "confirming" | "restoring" | "unknown" | "completed">("idle");
  const [allowingRetry, setAllowingRetry] = useState(false);
  const [restoreFeedback, setRestoreFeedback] = useState<Feedback | null>(null);
  const pageSession = useRef<AbortController | null>(null);
  const command = useRef<BackupCommand | null>(null);
  const selection = useRef<ValidatedSelection | null>(null);
  const preserveRef = useRef(true);
  const exportInput = useRef({ password: "", confirmation: "" });
  const restoring = restorePhase === "restoring";
  const locked = exporting || restorePhase !== "idle";

  useLayoutEffect(() => {
    const controller = new AbortController(); pageSession.current = controller;
    return () => { controller.abort(); command.current?.controller.abort(); command.current = null; selection.current = null; pageSession.current = null; };
  }, []);
  function isCurrent(operation: BackupCommand) { return Boolean(pageSession.current && !pageSession.current.signal.aborted && command.current === operation && !operation.controller.signal.aborted); }

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

  function invalidateValidation() {
    selection.current = null;
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
          if (controller.signal.aborted || sequence !== validationSequence.current) return;
          if (!response.ok) throw new Error(result?.error ?? "备份校验失败");
          const backup = readBackupValidation(result);
          selection.current = { file: selectedFile, password: importPassword, sequence, backup };
          setValidatedBackup(backup);
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
    if (!pageSession.current || pageSession.current.signal.aborted || command.current || restorePhase === "completed") return;
    const { password, confirmation } = exportInput.current;
    setExportFeedback(null);
    const invalidPassword = passwordError(password);
    if (invalidPassword) {
      setExportFeedback({ kind: "err", text: invalidPassword });
      return;
    }
    if (password !== confirmation) {
      setExportFeedback({ kind: "err", text: "两次输入的导出密码不一致" });
      return;
    }

    const controller = new AbortController();
    const operation: BackupCommand = { kind: "export", controller }; command.current = operation;
    setExporting(true);
    setExportFeedback({ kind: "progress", text: "正在生成加密备份…" });
    try {
      const response = await apiFetch("/api/backup/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, confirmation }),
        signal: controller.signal,
      });
      if (!isCurrent(operation)) return;
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(failure?.error ?? `HTTP ${response.status}`);
      }

      const blob = await response.blob();
      if (!isCurrent(operation)) return;
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
      exportInput.current = { password: "", confirmation: "" };
      setExportFeedback({ kind: "ok", text: "加密备份导出成功" });
    } catch (error) {
      if (!isCurrent(operation)) return;
      setExportFeedback({
        kind: "err",
        text: `导出失败：${errorMessage(error)}`,
      });
    } finally {
      if (isCurrent(operation)) {
        command.current = null;
        setExporting(false);
      }
    }
  }

  function handleFileSelect(event: ChangeEvent<HTMLInputElement>) {
    if (command.current || restorePhase === "completed") return;
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
    if (!fileInputRef.current || command.current || restorePhase === "completed") return;
    fileInputRef.current.value = "";
    fileInputRef.current.click();
  }

  async function handleRestore() {
    const current = selection.current;
    if (!pageSession.current || pageSession.current.signal.aborted || command.current || restorePhase === "completed" || !current || current.sequence !== validationSequence.current || passwordError(current.password)) return;
    const operation: BackupCommand = { kind: "restore", controller: new AbortController() }; command.current = operation;
    const preserve = preserveRef.current;
    setRestorePhase("confirming"); setRestoreFeedback(null);

    const confirmed = await confirmDialog({
      danger: true,
      title: "危险操作：完全覆盖现有数据",
      message: `文件：${current.file.name}（${current.file.size} 字节）；导出时间：${current.backup.manifest.createdAt}；数据库版本：${current.backup.manifest.dbVersion}；共 ${current.backup.totalRecords} 条记录。${preserve ? "保留当前设备的 AI Key 与模型配置" : "使用备份中的 AI 配置覆盖当前设备配置"}。恢复将完全覆盖简历、项目知识库、投递及提交快照、面试、练习、题库、错题与复习历史等全部业务数据。服务端会先建立恢复前灾备，完成后请保存灾备位置；离页取消本地等待不会撤销可能已提交的恢复。确认继续？`,
      confirmText: "确认完全覆盖并恢复",
      cancelText: "取消",
      signal: operation.controller.signal,
    });
    if (!isCurrent(operation)) return;
    if (!confirmed) { command.current = null; setRestorePhase("idle"); return; }

    setRestorePhase("restoring");
    setRestoreFeedback({ kind: "progress", text: "正在恢复并覆盖系统数据…" });
    try {
      const response = await apiFetch("/api/backup/restore", {
        method: "POST",
        headers: {
          "Content-Type": BACKUP_MEDIA_TYPE,
          "X-Resume-Life-Backup-Password": encodePasswordHeader(current.password),
          "X-Resume-Life-Preserve-Ai-Config": String(preserve),
        },
        body: current.file, signal: operation.controller.signal,
      });
      if (!isCurrent(operation)) return;
      const result = (await response.json()) as {
        ok: boolean;
        error?: string;
        stats?: Record<string, number>;
        snapshotCreated?: string;
      };
      if (!isCurrent(operation)) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 499) {
          command.current = null; setRestorePhase("idle");
          setRestoreFeedback({ kind: "err", text: `恢复失败：${result?.error ?? `HTTP ${response.status}`}。文件与校验结果已保留，核对后可重新确认。` }); return;
        }
        throw new Error(result?.error ?? `HTTP ${response.status}`);
      }
      const snapshotCreated = readBackupRestoreConfirmation(result, current.backup);

      validationSequence.current += 1;
      validationAbort.current?.abort();
      validationAbort.current = null;
      setSelectedFile(null);
      selection.current = null;
      setValidatedBackup(null);
      setValidationError(null);
      setImportPassword("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setRestoreFeedback({
        kind: "ok",
        text: "数据恢复成功。请保存灾备位置，确认完成后刷新页面以同步最新数据。",
        snapshotCreated,
      });
      setRestorePhase("completed");
    } catch (error) {
      if (!isCurrent(operation)) return;
      setRestorePhase("unknown");
      setRestoreFeedback({
        kind: "err",
        text: `恢复结果尚未确认：${errorMessage(error)}。恢复可能已完成或仍会稍后完成，请先在其他页面核对业务数据和恢复前灾备。不要直接重复覆盖；本页保留文件、密码与校验结果。`,
      });
    }
  }

  async function allowRestoreRetry() {
    const operation = command.current;
    if (!operation || operation.kind !== "restore" || !isCurrent(operation) || restorePhase !== "unknown" || operation.allowingRetry) return;
    operation.allowingRetry = true; setAllowingRetry(true);
    const confirmed = await confirmDialog({ title: "允许再次覆盖恢复", confirmText: "允许再次恢复", danger: true, signal: operation.controller.signal,
      message: "上次恢复可能已完成或仍会稍后完成。请先在其他页面核对数据及恢复前灾备；再次覆盖会清除恢复后新增或修改的数据，并建立新的灾备。确认已核对风险并允许再次恢复？此确认仅解除本页锁，不会提交恢复。" });
    if (!isCurrent(operation)) return;
    operation.allowingRetry = false; setAllowingRetry(false);
    if (confirmed) { command.current = null; setRestorePhase("idle"); setRestoreFeedback({ kind: "err", text: "已允许再次恢复，文件与密码已保留。再次覆盖可能清除新数据；仍需点击恢复并明确确认，不会自动重复提交。" }); }
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
        locked={locked}
        exportFeedback={exportFeedback}
        onExportPasswordChange={(value) => { if (command.current || restorePhase === "completed") return; exportInput.current.password = value; setExportPassword(value); }}
        onExportConfirmationChange={(value) => { if (command.current || restorePhase === "completed") return; exportInput.current.confirmation = value; setExportConfirmation(value); }}
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
        locked={locked}
        confirming={restorePhase === "confirming"}
        unknown={restorePhase === "unknown"}
        allowingRetry={allowingRetry}
        onAllowRetry={allowRestoreRetry}
        restoreFeedback={restoreFeedback}
        onImportPasswordChange={(password) => {
          if (command.current || restorePhase === "completed") return;
          invalidateValidation();
          setImportPassword(password);
        }}
        onFileSelect={handleFileSelect}
        onChooseFile={chooseBackupFile}
        onPreserveAiConfigChange={(value) => { if (command.current || restorePhase === "completed") return; preserveRef.current = value; setPreserveAiConfig(value); }}
        onRestore={handleRestore}
      />
    </div>
  );
});
