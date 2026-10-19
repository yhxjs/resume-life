"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Modal } from "@/components/common/modal";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { btnPrimary, btnGhost, inputCls, labelCls } from "@/lib/ui";
import { jsonFetch } from "@/lib/fetcher";
import { fetchSse } from "@/lib/fetch-sse";
import type { ProjectSummary } from "@/lib/summary";
import type { SummaryChange } from "@/lib/project-summary-diff";
import type { MaterialChange } from "@/lib/project-summary-history";
import { errorMessage } from "@/lib/error-message";
import { DirectoryPickerDialog } from "./directory-picker-dialog";

interface DetectedClisResponse {
  codex: { available: boolean; path?: string };
  claude: { available: boolean; path?: string };
  recommended: "codex" | "claude" | null;
}

interface CheckRelationResponse {
  isRelated: boolean | null;
  reason: string;
}

interface ScanRepoModalProps {
  open: boolean;
  projectId: number;
  projectName: string;
  repoPaths?: string[];
  onPathsChange?: (paths: string[]) => void;
  onClose: () => void;
  onSuccess: (proposal: { summary: ProjectSummary; comparison?: SummaryChange[]; materialChanges?: MaterialChange[]; materialFingerprint?: string; revisionId?: number }, repoPath: string) => void;
}

export function ScanRepoModal({
  open,
  projectId,
  projectName,
  repoPaths: propRepoPaths,
  onPathsChange,
  onClose,
  onSuccess,
}: ScanRepoModalProps) {
  const [repoPaths, setRepoPaths] = useState<string[]>(propRepoPaths || []);
  const [inputPath, setInputPath] = useState("");
  const [cliType, setCliType] = useState<"auto" | "claude" | "codex">("auto");
  const [scanning, setScanning] = useState(false);
  const [checkingRelation, setCheckingRelation] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [cliInfo, setCliInfo] = useState<DetectedClisResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [statusText, setStatusText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const restoreRepoPaths = useEffectEvent(() => {
    if (propRepoPaths) setRepoPaths(propRepoPaths);
  });

  // 弹窗打开时同步外部记录的路径并检测环境中的 CLI
  useEffect(() => {
    if (!open) return;

    let active = true;
    Promise.resolve().then(() => {
      if (active) {
        restoreRepoPaths();
        setScanning(false);
        setCheckingRelation(false);
        setDetecting(true);
      }
    });

    jsonFetch<DetectedClisResponse>(`/api/projects/${projectId}/scan-repo`)
      .then((res) => {
        if (!active) return;
        setCliInfo(res);
        if (res.recommended) {
          setCliType(res.recommended);
        }
      })
      .catch((err) => {
        if (!active) return;
        setErrorMsg(`探测 CLI 环境失败: ${errorMessage(err)}`);
      })
      .finally(() => {
        if (active) setDetecting(false);
      });

    return () => {
      active = false;
      abortRef.current?.abort();
    };
  }, [open, projectId]);

  // 日志自动滚动到底部
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  function handleCancel() {
    abortRef.current?.abort();
    if (scanning || checkingRelation) {
      setScanning(false);
      setCheckingRelation(false);
      setStatusText("操作已被用户取消");
    } else {
      onClose();
    }
  }

  function handleAddPath(pathToAdd?: string) {
    const target = (pathToAdd !== undefined ? pathToAdd : inputPath).trim();
    if (!target) return;

    if (repoPaths.includes(target)) {
      setErrorMsg("该路径已在待扫描列表中");
      return;
    }

    const next = [...repoPaths, target];
    setRepoPaths(next);
    onPathsChange?.(next);
    setInputPath("");
    setErrorMsg("");
  }

  function handleRemovePath(index: number) {
    const next = repoPaths.filter((_, i) => i !== index);
    setRepoPaths(next);
    onPathsChange?.(next);
  }

  function handleClearPaths() {
    setRepoPaths([]);
    onPathsChange?.([]);
  }

  async function handleStartScan() {
    // 汇总待扫描的所有路径：已添加的列表 + 输入框中尚未按添加的路径
    const finalPaths = [...repoPaths];
    const pendingInput = inputPath.trim();
    if (pendingInput && !finalPaths.includes(pendingInput)) {
      finalPaths.push(pendingInput);
      onPathsChange?.(finalPaths);
    }

    if (finalPaths.length === 0) {
      setErrorMsg("请填写或选择至少一个本地源码/Git 仓库目录路径");
      return;
    }

    setErrorMsg("");
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const isCurrent = () => abortRef.current === controller && !controller.signal.aborted;

    try {
      if (finalPaths.length > 1) {
        setCheckingRelation(true);
        setStatusText("AI 正在深度研判多个代码库之间的架构关联关系...");
        let relationRes: CheckRelationResponse;
        try {
          relationRes = await jsonFetch<CheckRelationResponse>(
            `/api/projects/${projectId}/scan-repo?action=check-relation`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ repoPaths: finalPaths, preferredCli: cliType }),
              signal: controller.signal,
            }
          );
        } catch (err) {
          if (!isCurrent()) return;
          console.warn("AI 关系判定失败:", err);
          relationRes = { isRelated: null, reason: "关联预检未能完成，无法确认这些代码库属于同一项目。" };
        }
        if (!isCurrent()) return;

        if (relationRes.isRelated !== true) {
          const shouldContinue = await confirmDialog({
            title: relationRes.isRelated === false
              ? "所选代码库可能不属于同一项目"
              : "代码库关联性暂时无法确认",
            message: `${relationRes.reason}\n\n是否仍要将它们合并为一个项目提炼简历 STAR 档案？`,
            confirmText: "仍然合并扫描",
            cancelText: "取消并调整路径",
          });
          if (!isCurrent()) return;
          if (!shouldContinue) {
            setStatusText("已取消合并扫描，请调整路径选择");
            return;
          }
        }
      }
      if (!isCurrent()) return;
      setCheckingRelation(false);
      setScanning(true);
      setLogs([]);
      setStatusText(
        finalPaths.length > 1
          ? `正在初始化 ${finalPaths.length} 个代码工程的联合扫描...`
          : "正在初始化扫描进程..."
      );

      await fetchSse<{ summary?: ProjectSummary; comparison?: SummaryChange[]; materialChanges?: MaterialChange[]; materialFingerprint?: string; revisionId?: number; repoPath?: string; repoPaths?: string[] }>(
        `/api/projects/${projectId}/scan-repo`,
        {
          method: "POST",
          body: {
            repoPaths: finalPaths,
            preferredCli: cliType,
          },
          signal: controller.signal,
          onDelta: (text, extra) => {
            if (!isCurrent()) return;
            const logLine = (extra as { log?: string })?.log || text;
            setStatusText(text);
            if (logLine) {
              setLogs((prev) => [...prev, logLine]);
            }
          },
          onDone: (data) => {
            if (!isCurrent()) return;
            if (data.summary) {
              setStatusText("扫描提炼完成！正在载入工作台草稿...");
              setTimeout(() => {
                if (!isCurrent()) return;
                onSuccess({ summary: data.summary!, comparison: data.comparison, materialChanges: data.materialChanges, materialFingerprint: data.materialFingerprint, revisionId: data.revisionId }, finalPaths.join(" ; "));
                onClose();
              }, 400);
            } else {
              setErrorMsg("扫描已完成但未返回有效的总结数据");
            }
          },
          onError: (err) => {
            if (!isCurrent()) return;
            setErrorMsg(err.message);
            setStatusText("扫描失败");
          },
        }
      );
    } catch (err) {
      if (isCurrent()) {
        setErrorMsg(errorMessage(err));
        setStatusText("扫描中断");
      }
    } finally {
      if (isCurrent()) {
        setScanning(false);
        setCheckingRelation(false);
      }
    }
  }

  return (
    <Modal
      open={open}
      title={
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary text-sm">
            📂
          </span>
          <span className="font-serif text-lg font-bold text-ink">一键扫描本地仓库提炼项目亮点</span>
        </div>
      }
      description={`调用本机 Codex 或 Claude Code CLI 深入剖析「${projectName}」本地源码，自动生成五维 STAR 简历素材`}
      onClose={handleCancel}
      closeOnBackdrop={!scanning && !checkingRelation}
      escapeDisabled={scanning || checkingRelation}
      loading={checkingRelation}
      loadingText="AI 正在研判多个代码库关联性…"
      loadingDescription="正在深度分析多模块工程架构与代码库依赖关系，请稍候…"
    >
      <div className="space-y-4 pt-2">
        {/* 本地路径输入与多路径清单 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="repo-path-input" className={labelCls}>
              本地源码目录绝对路径（支持选择多个合并为同一项目） <span className="text-accent">*</span>
            </label>
            <button
              type="button"
              disabled={scanning || checkingRelation}
              onClick={() => setPickerOpen(true)}
              className="text-xs text-primary font-medium hover:underline flex items-center gap-1 cursor-pointer disabled:opacity-50"
            >
              <span>📁</span>
              <span>弹窗浏览本地目录</span>
            </button>
          </div>

          {/* 路径添加输入框与按钮 */}
          <div className="flex items-center gap-2">
            <input
              id="repo-path-input"
              type="text"
              className={inputCls}
              placeholder="输入代码路径，按回车或点击「添加」，例如 D:\projects\app-frontend"
              value={inputPath}
              onChange={(e) => setInputPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddPath();
                }
              }}
              disabled={scanning || checkingRelation}
            />
            <button
              type="button"
              className={`${btnGhost} shrink-0`}
              disabled={scanning || checkingRelation || !inputPath.trim()}
              onClick={() => handleAddPath()}
              title="将输入框中的路径加入扫描列表"
            >
              + 添加
            </button>
            <button
              type="button"
              className={`${btnGhost} shrink-0`}
              disabled={scanning || checkingRelation}
              onClick={() => setPickerOpen(true)}
              title="弹窗浏览本地目录并直接加入列表"
            >
              浏览...
            </button>
          </div>

          {/* 已选多路径列表 */}
          {repoPaths.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-[11px] text-muted">
                <span>已添加待扫描的代码库目录（{repoPaths.length} 个）：</span>
                {!scanning && !checkingRelation && (
                  <button
                    type="button"
                    onClick={handleClearPaths}
                    className="text-faint hover:text-accent transition-colors"
                  >
                    清空全部
                  </button>
                )}
              </div>
              <div className="max-h-36 overflow-y-auto space-y-1.5 pr-0.5">
                {repoPaths.map((p, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border border-line bg-surface-2 text-xs font-mono group"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="h-4 w-4 rounded-full bg-primary/10 text-primary text-[10px] flex items-center justify-center shrink-0">
                        {idx + 1}
                      </span>
                      <span className="truncate text-ink" title={p}>
                        {p}
                      </span>
                    </div>
                    {!scanning && !checkingRelation && (
                      <button
                        type="button"
                        onClick={() => handleRemovePath(idx)}
                        className="text-faint hover:text-accent p-0.5 text-xs transition-colors shrink-0"
                        title="移除此路径"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[11px] text-muted">
            支持多个路径（如前端 + 后端或微服务群）。当选择多个路径时，AI 将自动分析各工程关联性并合并提炼统一的项目亮点。
          </p>
        </div>

        {/* 引擎选择 */}
        <div className="space-y-1.5">
          <span className={labelCls}>执行工具选择</span>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <button
              type="button"
              disabled={scanning || checkingRelation}
              onClick={() => setCliType("auto")}
              className={`rounded-xl border p-2.5 text-left transition-all ${
                cliType === "auto"
                  ? "border-primary bg-primary/5 text-ink font-medium shadow-sm"
                  : "border-line bg-card hover:bg-subtle text-muted"
              }`}
            >
              <div className="font-medium text-ink">智能推荐 (Auto)</div>
              <div className="text-[10px] text-muted mt-0.5">优先使用环境可用 CLI</div>
            </button>

            <button
              type="button"
              disabled={scanning || checkingRelation || (cliInfo !== null && !cliInfo.claude.available)}
              onClick={() => setCliType("claude")}
              className={`rounded-xl border p-2.5 text-left transition-all ${
                cliType === "claude"
                  ? "border-primary bg-primary/5 text-ink font-medium shadow-sm"
                  : "border-line bg-card hover:bg-subtle text-muted"
              } ${cliInfo !== null && !cliInfo.claude.available ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-ink">Claude Code</span>
                {cliInfo?.claude.available && (
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" title="已安装" />
                )}
              </div>
              <div className="text-[10px] text-muted mt-0.5">
                {cliInfo?.claude.available ? "claude -p 只读探索" : detecting ? "检测中..." : "未检测到"}
              </div>
            </button>

            <button
              type="button"
              disabled={scanning || checkingRelation || (cliInfo !== null && !cliInfo.codex.available)}
              onClick={() => setCliType("codex")}
              className={`rounded-xl border p-2.5 text-left transition-all ${
                cliType === "codex"
                  ? "border-primary bg-primary/5 text-ink font-medium shadow-sm"
                  : "border-line bg-card hover:bg-subtle text-muted"
              } ${cliInfo !== null && !cliInfo.codex.available ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-ink">Codex CLI</span>
                {cliInfo?.codex.available && (
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" title="已安装" />
                )}
              </div>
              <div className="text-[10px] text-muted mt-0.5">
                {cliInfo?.codex.available ? "codex exec 只读沙盒" : detecting ? "检测中..." : "未检测到"}
              </div>
            </button>
          </div>
        </div>

        {/* 错误提示 */}
        {errorMsg && (
          <div className="rounded-xl border border-accent/30 bg-accent-wash/60 p-3 text-xs text-accent whitespace-pre-line">
            ⚠️ {errorMsg}
          </div>
        )}

        {/* 终端日志与执行状态窗口 */}
        {(scanning || checkingRelation || logs.length > 0) && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono text-muted flex items-center gap-1.5">
                {(scanning || checkingRelation) && (
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                )}
                <span className={scanning || checkingRelation ? "text-ink font-medium" : "text-muted"}>
                  {statusText || "终端实时日志"}
                </span>
              </span>
              <span className="text-[11px] text-faint font-mono">{logs.length} 条记录</span>
            </div>
            {/* 终端风格的固定深色日志区为刻意设计（logs 恒为深底浅字，不随明暗主题切换），DESIGN.md 令牌禁令豁免 */}
            <div
              ref={logContainerRef}
              className="h-44 overflow-y-auto rounded-xl border border-line bg-neutral-950 p-3 font-mono text-[11px] text-neutral-200 leading-relaxed space-y-1 select-text shadow-inner"
            >
              {logs.map((log, i) => (
                <div key={i} className="break-all whitespace-pre-wrap">
                  <span className="text-neutral-500 mr-2">[{i + 1}]</span>
                  {log}
                </div>
              ))}
              {(scanning || checkingRelation) && (
                <div className="mt-2 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/50 px-2.5 py-1.5 text-emerald-300 text-xs shadow-sm">
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                  </span>
                  <span className="font-bold text-emerald-400 select-none">&gt;</span>
                  <span className="animate-pulse font-medium">
                    {checkingRelation ? "AI 正在跨工程分析代码库关联度..." : "正在自主扫描与理解多模块工程源码结构中..."}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-line">
          <button
            type="button"
            className={btnGhost}
            onClick={handleCancel}
          >
            {scanning || checkingRelation ? "取消" : "取消"}
          </button>
          <button
            type="button"
            className={btnPrimary}
            onClick={handleStartScan}
            disabled={scanning || checkingRelation || (repoPaths.length === 0 && !inputPath.trim())}
          >
            {checkingRelation
              ? "AI 关联性研判中…"
              : scanning
              ? "正在扫描代码中…"
              : repoPaths.length > 1
              ? `合并扫描 ${repoPaths.length} 个代码库`
              : "开始扫描并提炼"}
          </button>
        </div>
      </div>

      <DirectoryPickerDialog
        open={pickerOpen}
        projectId={projectId}
        initialPath={inputPath.trim() || (repoPaths.length > 0 ? repoPaths[repoPaths.length - 1] : undefined)}
        onClose={() => setPickerOpen(false)}
        onSelect={(selectedPath) => {
          handleAddPath(selectedPath);
        }}
      />
    </Modal>
  );
}
