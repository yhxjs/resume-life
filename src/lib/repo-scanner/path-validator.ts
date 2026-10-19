import type { Stats } from "node:fs";
import { isSafeRepoSourceText } from "./source-snapshot";
import { repoRootPathError } from "./path-policy";

const fs = process.getBuiltinModule("fs");
const path = process.getBuiltinModule("path");

export interface PathValidationResult {
  valid: boolean;
  normalizedPath?: string;
  projectName?: string;
  error?: string;
  features?: string[];
  readmeSnippet?: string;
  packageMetadata?: Record<string, unknown>;
}

export interface MultiPathValidationResult {
  valid: boolean;
  paths: PathValidationResult[];
  error?: string;
}

/** 常见工程构建清单或仓库标识文件 */
const REPO_MARKERS = [
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
  "Gemfile",
  "CMakeLists.txt",
  "Makefile",
  "solution.sln",
  "tsconfig.json",
  "README.md",
  "readme.md",
];

/** 元数据同样只读普通文件；拒绝链接和身份变化，并在读取前限制预算。 */
function readRepoMetadata(directory: string, name: string): string {
  const root = fs.realpathSync(directory);
  const filename = path.join(root, name);
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || path.dirname(fs.realpathSync(filename)) !== root) return "";
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const current = fs.fstatSync(descriptor);
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino) return "";
    const bytes = Buffer.alloc(Math.min(current.size, 32_000));
    const read = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    const content = bytes.subarray(0, read).toString("utf8");
    return isSafeRepoSourceText(content) ? content : "";
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * 校验本地源码目录的合法性与安全性
 */
export function validateRepoPath(inputPath: string): PathValidationResult {
  if (!inputPath || typeof inputPath !== "string") {
    return { valid: false, error: "仓库路径不能为空" };
  }

  const trimmed = inputPath.trim();
  if (!trimmed) {
    return { valid: false, error: "仓库路径不能为空" };
  }

  if (trimmed.includes("\0")) {
    return { valid: false, error: "路径包含非法字符" };
  }

  let normalized: string;
  try {
    normalized = path.resolve(trimmed);
  } catch {
    return { valid: false, error: "无效的路径格式" };
  }

  const pathError = repoRootPathError(normalized);
  if (pathError) return { valid: false, error: pathError };

  // 存在性与目录类型检查
  if (!fs.existsSync(normalized)) {
    return { valid: false, error: `路径不存在: ${normalized}` };
  }

  try {
    normalized = fs.realpathSync(normalized);
  } catch {
    return { valid: false, error: "无法访问目标路径" };
  }
  const realPathError = repoRootPathError(normalized);
  if (realPathError) return { valid: false, error: realPathError };

  let stat: Stats;
  try {
    stat = fs.statSync(normalized);
  } catch {
    return { valid: false, error: "无法访问目标路径" };
  }

  if (!stat.isDirectory()) {
    return { valid: false, error: "目标路径必须是一个文件夹目录" };
  }

  // 探测仓库或代码工程特征
  const features: string[] = [];
  try {
    const entries = fs.readdirSync(normalized);
    for (const marker of REPO_MARKERS) {
      if (entries.includes(marker)) {
        features.push(marker);
      }
    }
  } catch {
    return { valid: false, error: "无法读取目标目录下的文件" };
  }

  if (features.length === 0) {
    return {
      valid: false,
      error: "目标目录下未检测到常见的代码工程清单（如 package.json / pom.xml / go.mod / .git 等），请确认路径是否正确",
    };
  }

  const projectName = path.basename(normalized) || "未知项目";

  // 读取轻量级工程元数据（用于 AI 关联性判断）
  let readmeSnippet: string | undefined;
  for (const rm of ["README.md", "readme.md", "README", "readme"]) {
    const rmPath = path.join(normalized, rm);
    if (fs.existsSync(rmPath)) {
      try {
        const content = readRepoMetadata(normalized, rm);
        if (!content) continue;
        readmeSnippet = content.slice(0, 1000).trim();
        break;
      } catch {
        // 忽略读取错误
      }
    }
  }

  let packageMetadata: Record<string, unknown> | undefined;
  const pkgPath = path.join(normalized, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const raw = readRepoMetadata(normalized, "package.json");
      const parsed = JSON.parse(raw);
      packageMetadata = {
        type: "node",
        name: parsed.name,
        description: parsed.description,
        dependencies: Object.keys(parsed.dependencies || {}).slice(0, 15),
      };
    } catch {
      // 忽略
    }
  } else {
    // 检查 pom.xml
    const pomPath = path.join(normalized, "pom.xml");
    if (fs.existsSync(pomPath)) {
      try {
        const raw = readRepoMetadata(normalized, "pom.xml");
        const artifactMatch = raw.match(/<artifactId>([^<]+)<\/artifactId>/);
        const nameMatch = raw.match(/<name>([^<]+)<\/name>/);
        const descMatch = raw.match(/<description>([^<]+)<\/description>/);
        packageMetadata = {
          type: "java-maven",
          name: nameMatch ? nameMatch[1] : (artifactMatch ? artifactMatch[1] : undefined),
          description: descMatch ? descMatch[1] : undefined,
        };
      } catch {
        // 忽略
      }
    } else {
      // 检查 go.mod
      const goModPath = path.join(normalized, "go.mod");
      if (fs.existsSync(goModPath)) {
        try {
          const raw = readRepoMetadata(normalized, "go.mod");
          const modLine = raw.split(/\r?\n/).find((l) => l.startsWith("module "));
          packageMetadata = {
            type: "go",
            module: modLine ? modLine.replace("module ", "").trim() : undefined,
          };
        } catch {
          // 忽略
        }
      }
    }
  }

  return {
    valid: true,
    normalizedPath: normalized,
    projectName,
    features,
    readmeSnippet,
    packageMetadata,
  };
}

/**
 * 校验多个本地源码目录的合法性与安全性，自动去重与排查
 */
export function validateRepoPaths(inputPaths: string[]): MultiPathValidationResult {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    return { valid: false, paths: [], error: "至少需要提供一个本地代码仓库路径" };
  }
  if (inputPaths.length > 32) {
    return { valid: false, paths: [], error: "一次最多提供 32 个代码仓库路径" };
  }

  const inputSeen = new Set<string>();
  const normalizedSeen = new Set<string>();
  const validatedList: PathValidationResult[] = [];

  for (const raw of inputPaths) {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) continue;

    const resolved = path.resolve(trimmed);
    const inputKey = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (inputSeen.has(inputKey)) continue;
    inputSeen.add(inputKey);

    const res = validateRepoPath(trimmed);
    if (!res.valid || !res.normalizedPath) {
      return { valid: false, paths: [], error: res.error || `路径「${trimmed}」校验未通过` };
    }

    const key = process.platform === "win32" ? res.normalizedPath.toLowerCase() : res.normalizedPath;
    if (normalizedSeen.has(key)) {
      continue; // 重复路径跳过
    }
    normalizedSeen.add(key);
    validatedList.push(res);
  }

  if (validatedList.length === 0) {
    return { valid: false, paths: [], error: "未提供有效的本地代码仓库路径" };
  }

  return {
    valid: true,
    paths: validatedList,
  };
}
