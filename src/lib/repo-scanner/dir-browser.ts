import fs from "fs";
import path from "path";
import os from "os";

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
export function getAvailableDrives(): string[] {
  if (process.platform !== "win32") {
    return ["/"];
  }

  const drives: string[] = [];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (let i = 0; i < letters.length; i++) {
    const drive = `${letters[i]}:\\`;
    try {
      if (fs.existsSync(drive)) {
        drives.push(drive);
      }
    } catch {
      // 驱动器未就绪或无权限
    }
  }
  return drives.length > 0 ? drives : ["C:\\"];
}

/**
 * 浏览指定目录下的子目录列表
 */
export function listDirectory(targetPath?: string): BrowseDirectoryResult {
  let resolved: string;

  if (!targetPath || !targetPath.trim()) {
    // 默认打开用户主目录或当前项目所在盘符
    resolved = path.resolve(os.homedir());
  } else {
    resolved = path.resolve(targetPath.trim());
  }

  // 必须存在且是目录
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    resolved = path.resolve(os.homedir());
  }

  const parsed = path.parse(resolved);
  const isRoot = resolved === parsed.root;
  const parentPath = isRoot ? null : path.dirname(resolved);

  const drives = process.platform === "win32" ? getAvailableDrives() : ["/"];

  let dirEntries: fs.Dirent[] = [];
  try {
    dirEntries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    // 无权读取
    return {
      currentPath: resolved,
      parentPath,
      drives,
      entries: [],
      truncated: false,
    };
  }

  // 检查当前目录下是否有工程 marker
  const entries: DirectoryEntry[] = [];
  const candidateEntries = dirEntries
    .filter((ent) => !(ent.name.startsWith(".") && ent.name !== ".git") && ent.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const truncated = candidateEntries.length > MAX_DIRECTORY_ENTRIES;
  for (const ent of candidateEntries.slice(0, MAX_DIRECTORY_ENTRIES)) {
    // 忽略隐藏的系统目录，但保留 .git 用于展示仓库标识
    if (ent.name.startsWith(".") && ent.name !== ".git") continue;

    const fullPath = path.join(resolved, ent.name);
    let hasMarkers = false;
    try {
      const subFiles = fs.readdirSync(fullPath);
      hasMarkers = subFiles.some((f) => REPO_MARKERS.has(f));
    } catch {
      // 无法读取子目录内容
    }

    entries.push({
      name: ent.name,
      path: fullPath,
      isDirectory: true,
      hasMarkers,
    });
  }

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
