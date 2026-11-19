import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "path";
import os from "os";
import { execFile } from "node:child_process";

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  hasMarkers?: boolean;
}

export interface BrowseDirectoryResult {
  currentPath: string;
  parentPath: string | null;
  drives?: string[];
  entries: DirectoryEntry[];
  truncated: boolean;
}

export const MAX_DIRECTORY_ENTRIES = 200;
const MARKER_READ_CONCURRENCY = 4;

export class DirectoryBrowseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DirectoryBrowseError";
  }
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DirectoryBrowseError("请求已取消", 499);
}

function rethrowDirectoryError(error: unknown): never {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ENOENT") throw new DirectoryBrowseError("目录不存在，请检查路径后重试", 404);
  if (code === "ENOTDIR") throw new DirectoryBrowseError("目标路径不是文件夹，请选择目录", 400);
  if (code === "EACCES" || code === "EPERM") throw new DirectoryBrowseError("无权读取此目录，请选择有访问权限的文件夹", 403);
  throw error;
}

const REPO_MARKERS = new Set([
  ".git",
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "go.mod",
  "Cargo.toml",
  "requirements.txt",
  "pyproject.toml",
  "setup.py",
  "composer.json",
  "solution.sln",
  "tsconfig.json",
  "README.md",
  "readme.md",
]);

/**
 * 获取 Windows 所有盘符，例如 ["C:\\", "D:\\"]
 */
export async function getAvailableDrives(signal?: AbortSignal): Promise<string[]> {
  checkCancelled(signal);
  if (process.platform !== "win32") {
    return ["/"];
  }

  // 枚举逻辑盘符，不逐一访问根目录：离线映射盘的同步探测会阻塞整个服务。
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[System.IO.Directory]::GetLogicalDrives()"],
      { windowsHide: true, timeout: 5_000, maxBuffer: 4_096, encoding: "utf8", ...(signal ? { signal } : {}) }, (error, stdout) => {
        if (signal?.aborted) { reject(new DirectoryBrowseError("请求已取消", 499)); return; }
        const drives = error ? [] : [...new Set(stdout.split(/\r?\n/).map((line) => line.trim().toUpperCase()).filter((line) => /^[A-Z]:\\$/.test(line)))].sort();
        resolve(drives.length > 0 ? drives : [path.parse(os.homedir()).root]);
      });
  });
}

async function containsRepoMarker(directory: string, signal?: AbortSignal): Promise<boolean> {
  checkCancelled(signal);
  try {
    const handle = await fs.opendir(directory);
    try {
      // 逐批读取名称，发现标识立即结束，避免为每个子目录分配完整文件名列表。
      while (true) {
        checkCancelled(signal);
        const entry = await handle.read();
        checkCancelled(signal);
        if (!entry) return false;
        if (REPO_MARKERS.has(entry.name)) return true;
      }
    } finally {
      await handle.close();
    }
  } catch {
    checkCancelled(signal);
    // 子目录的标识仅作提示，无法读取时仍保留父目录中的条目。
    return false;
  }
}

/**
 * 浏览指定目录下的子目录列表
 */
export async function listDirectory(targetPath?: string, signal?: AbortSignal): Promise<BrowseDirectoryResult> {
  checkCancelled(signal);
  if (targetPath?.includes("\0")) throw new DirectoryBrowseError("目录路径包含非法字符，请检查后重试", 400);
  // 只有未指定路径时使用主目录；指定目标不可读时必须明确失败，不能换成其他目录。
  const resolved = path.resolve(targetPath?.trim() || os.homedir());

  const parsed = path.parse(resolved);
  const isRoot = resolved === parsed.root;
  const parentPath = isRoot ? null : path.dirname(resolved);

  let dirEntries: Dirent[] = [];
  try {
    const stat = await fs.stat(resolved);
    checkCancelled(signal);
    if (!stat.isDirectory()) throw new DirectoryBrowseError("目标路径不是文件夹，请选择目录", 400);
    dirEntries = await fs.readdir(resolved, { withFileTypes: true });
  } catch (error) {
    checkCancelled(signal);
    rethrowDirectoryError(error);
  }
  checkCancelled(signal);

  // 检查当前目录下是否有工程 marker
  const entries: DirectoryEntry[] = [];
  const candidateEntries = dirEntries
    .filter((ent) => !(ent.name.startsWith(".") && ent.name !== ".git") && ent.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const truncated = candidateEntries.length > MAX_DIRECTORY_ENTRIES;
  const selected = candidateEntries.slice(0, MAX_DIRECTORY_ENTRIES);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(MARKER_READ_CONCURRENCY, selected.length) }, async () => {
    while (nextIndex < selected.length) {
      checkCancelled(signal);
      const index = nextIndex++;
      const ent = selected[index]!;
      const fullPath = path.join(resolved, ent.name);
      const hasMarkers = await containsRepoMarker(fullPath, signal);
      entries[index] = { name: ent.name, path: fullPath, isDirectory: true, hasMarkers };
    }
  });
  // 取消时等待已打开的句柄清理完毕，不再启动余下子目录的探测。
  const completed = await Promise.allSettled(workers);
  for (const result of completed) if (result.status === "rejected") throw result.reason;
  checkCancelled(signal);
  const drives = await getAvailableDrives(signal);
  checkCancelled(signal);

  // 按名称排序，带仓库标识的排在前面
  entries.sort((a, b) => {
    if (a.hasMarkers && !b.hasMarkers) return -1;
    if (!a.hasMarkers && b.hasMarkers) return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });

  return {
    currentPath: resolved,
    parentPath,
    drives,
    entries,
    truncated,
  };
}
