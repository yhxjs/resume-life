"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/common/modal";
import { btnPrimary, btnGhost, badgePrimary } from "@/lib/ui";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";

interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  hasMarkers?: boolean;
}

interface BrowseDirectoryResponse {
  currentPath: string;
  parentPath: string | null;
  drives?: string[];
  entries: DirectoryEntry[];
  truncated?: boolean;
}

interface DirectoryPickerDialogProps {
  open: boolean;
  projectId: number;
  initialPath?: string;
  onClose: () => void;
  onSelect: (selectedPath: string) => void;
}

export function DirectoryPickerDialog(props: DirectoryPickerDialogProps) {
  // 每次打开／切换项目和初始目录均创建独立浏览会话，旧路径不能被直接确认。
  return props.open ? <DirectoryPickerSession key={JSON.stringify([props.projectId, props.initialPath])} {...props} /> : null;
}

function DirectoryPickerSession({
  open,
  projectId,
  initialPath,
  onClose,
  onSelect,
}: DirectoryPickerDialogProps) {
  const [currentPath, setCurrentPath] = useState("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [drives, setDrives] = useState<string[]>([]);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [requestedPath, setRequestedPath] = useState(initialPath);
  const activeRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const confirmedPathRef = useRef<string | null>(null);

  const loadPath = useCallback(async (targetPath?: string) => {
    if (!activeRef.current) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setRequestedPath(targetPath);
    confirmedPathRef.current = null;
    const isCurrent = () => activeRef.current && requestRef.current === controller && !controller.signal.aborted;
    setLoading(true);
    setErrorMsg("");
    try {
      const q = targetPath ? `?action=browse&path=${encodeURIComponent(targetPath)}` : "?action=browse";
      const res = await jsonFetch<BrowseDirectoryResponse>(`/api/projects/${projectId}/scan-repo${q}`, { signal: controller.signal });
      if (!isCurrent()) return;
      confirmedPathRef.current = res.currentPath;
      setCurrentPath(res.currentPath);
      setParentPath(res.parentPath);
      setDrives(res.drives || []);
      setEntries(res.entries);
      setTruncated(res.truncated === true);
    } catch (err) {
      if (isCurrent()) setErrorMsg(`读取目录失败: ${errorMessage(err)}`);
    } finally {
      if (isCurrent()) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    let active = true;
    activeRef.current = true;
    Promise.resolve().then(() => {
      if (active) void loadPath(initialPath);
    });
    return () => {
      active = false;
      activeRef.current = false;
      requestRef.current?.abort();
      requestRef.current = null;
      confirmedPathRef.current = null;
    };
  }, [initialPath, loadPath]);

  function close() {
    activeRef.current = false;
    requestRef.current?.abort();
    requestRef.current = null;
    confirmedPathRef.current = null;
    onClose();
  }
  const displayedPath = loading || errorMsg ? requestedPath ?? "" : currentPath;

  return (
    <Modal
      open={open}
      title={
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary text-sm">
            📁
          </span>
          <span className="font-serif text-lg font-bold text-ink">选择本地源码仓库目录</span>
        </div>
      }
      description="导航并选中包含代码工程或 Git 仓库的本地目录"
      onClose={close}
    >
      <div className="space-y-3 pt-1">
        {/* 盘符切换（Windows 下可用） */}
        {drives.length > 1 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
            <span className="text-muted text-[11px] shrink-0">盘符:</span>
            {drives.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => loadPath(d)}
                className={`px-2 py-1 rounded-md font-mono text-xs border transition-colors ${
                  currentPath.toLowerCase().startsWith(d.toLowerCase())
                    ? "bg-primary text-on-primary border-primary font-bold"
                    : "border-line bg-card hover:bg-subtle text-ink"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        )}

        {/* 当前路径与向上按钮 */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={`${btnGhost} !px-2.5 !py-1 text-xs shrink-0`}
            disabled={!parentPath || loading}
            onClick={() => parentPath && loadPath(parentPath)}
            title="返回上一级目录"
          >
            ⬆️ 上一级
          </button>
          <div
            className="flex-1 min-w-0 font-mono text-xs px-2.5 py-1.5 rounded-lg border border-line bg-surface-2 text-ink truncate"
            title={displayedPath}
          >
            {displayedPath || (errorMsg ? "目录未能读取" : "正在加载目录...")}
          </div>
        </div>

        {errorMsg && (
          <div role="alert" className="rounded-xl border border-accent/30 bg-accent-wash/60 p-2 text-xs text-accent">
            ⚠️ {errorMsg}
            <button type="button" className={`${btnGhost} ml-2`} onClick={() => { void loadPath(requestedPath); }}>重试读取目录</button>
          </div>
        )}

        {/* 目录列表 */}
        <div className="h-60 overflow-y-auto rounded-xl border border-line bg-card divide-y divide-line/60">
          {loading ? (
            <div className="p-8 text-center text-xs text-muted flex items-center justify-center gap-2">
              <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />
              <span>正在读取目录中...</span>
            </div>
          ) : errorMsg ? (
            <div className="p-8 text-center text-xs text-muted">目录尚未读取成功，请重试或切换路径。</div>
          ) : entries.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted">当前目录下没有子文件夹</div>
          ) : (
            entries.map((ent) => (
              <div
                key={ent.path}
                className="flex items-center justify-between px-3 py-2 text-xs hover:bg-subtle transition-colors group cursor-pointer"
                onClick={() => loadPath(ent.path)}
              >
                <div className="flex items-center gap-2 min-w-0 pr-2">
                  <span className="text-base select-none">📁</span>
                  <span className="font-mono text-ink truncate">{ent.name}</span>
                  {ent.hasMarkers && (
                    <span className={badgePrimary} title="包含代码工程清单或 .git 仓库标识">
                      代码工程
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="opacity-0 group-hover:opacity-100 text-[11px] text-primary hover:underline transition-opacity shrink-0 px-1.5 py-0.5"
                  onClick={(e) => {
                    e.stopPropagation();
                    loadPath(ent.path);
                  }}
                >
                  进入 &gt;
                </button>
              </div>
            ))
          )}
        </div>
        {!loading && !errorMsg && truncated && <p role="status" className="text-xs text-muted">
          仅显示前 {entries.length} 个子文件夹。可取消后输入完整路径，再重新浏览。
        </p>}

        {/* 底部操作区 */}
        <div className="flex items-center justify-between pt-2 border-t border-line">
          <div className="text-[11px] text-muted truncate max-w-[260px]">
            {loading || errorMsg ? "待确认:" : "选中:"} <span className="font-mono text-ink">{displayedPath}</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={btnGhost} onClick={close}>
              取消
            </button>
            <button
              type="button"
              className={btnPrimary}
              onClick={() => {
                const selected = confirmedPathRef.current;
                if (!activeRef.current || requestRef.current || !selected) return;
                onSelect(selected);
                close();
              }}
              disabled={loading || !!errorMsg || !currentPath}
            >
              确定选择当前目录
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
