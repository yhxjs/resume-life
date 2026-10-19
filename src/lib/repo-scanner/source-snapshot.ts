import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { RepoTarget } from "./prompts";
import { repoRootPathError } from "./path-policy";

const MAX_SNAPSHOT_CHARS = 180_000;
const MAX_FILE_BYTES = 32_000;
const EXCLUDED_DIRS = new Set(["node_modules", "vendor", "data", "coverage", "dist", "build", "target", "out", "test-results"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".py", ".go", ".rs", ".java", ".kt", ".cs", ".c", ".cpp", ".h", ".css", ".html", ".sql", ".toml", ".xml", ".yaml", ".yml"]);

/** 排除明显的明文凭证；未知业务格式仍需用户在扫描前清理。 */
export function isSafeRepoSourceText(content: string): boolean {
  return !content.includes("\0")
    && !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)
    && !/["']?\b[a-z0-9_-]*?(?:api[_-]?key|password|passwd|secret|token|access[_-]?key[_-]?id|secret[_-]?access[_-]?key|secret[_-]?key)\b["']?\s*[:=]\s*(?:["'][^"'\r\n]+(?:["']|$)|[A-Za-z0-9_+/=-]+)/i.test(content)
    && !/\bauthorization\b["']?\s*[:=,]\s*["']?Bearer[ \t]+[A-Za-z0-9._~+/-]+=*/i.test(content)
    && !/\b(?:password|pwd|accountkey|accesskey)\s*=\s*[^;\s"']+/i.test(content)
    && !/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis(?:s)?|amqp(?:s)?):\/\/[^\s/@:]*:[^\s/@]+@/i.test(content);
}

function eligible(name: string): boolean {
  const lower = name.toLowerCase();
  return !lower.startsWith(".") && !/^(?:agents|claude|gemini)\.md$/.test(lower)
    && !/(?:secret|credential|password|token|private[-_]?key)/.test(lower)
    && !/(?:lock\.(?:json|yaml)|\.lock)$/.test(lower) && SOURCE_EXTENSIONS.has(path.extname(lower));
}

/** 只由应用读取白名单源码；CLI 消费这份文本，不获得宿主文件工具。 */
export async function collectRepoSourceSnapshot(targets: readonly RepoTarget[], signal?: AbortSignal): Promise<string> {
  const parts: string[] = [];
  let used = 0;
  let inspected = 0;
  const append = (value: string): boolean => {
    const remaining = MAX_SNAPSHOT_CHARS - used;
    if (remaining <= 0) return false;
    parts.push(value.slice(0, remaining));
    used += Math.min(value.length, remaining);
    return value.length <= remaining;
  };
  for (const [index, target] of targets.entries()) {
    signal?.throwIfAborted();
    const root = await fs.realpath(target.path);
    const rootError = repoRootPathError(root);
    if (rootError) throw new Error(rootError);
    const directories = [{ directory: root, depth: 0 }];
    append(`\n[代码库 ${index + 1}]\n`);
    while (directories.length && used < MAX_SNAPSHOT_CHARS && inspected < 10_000) {
      signal?.throwIfAborted();
      const current = directories.shift()!;
      const entries = await fs.readdir(current.directory, { withFileTypes: true });
      entries.sort((a, b) => Number(b.name.toLowerCase().startsWith("readme")) - Number(a.name.toLowerCase().startsWith("readme")) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (++inspected > 10_000 || used >= MAX_SNAPSHOT_CHARS) break;
        if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
        const filename = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < 12 && !EXCLUDED_DIRS.has(entry.name.toLowerCase())) directories.push({ directory: filename, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile() || !eligible(entry.name)) continue;
        const real = await fs.realpath(filename);
        const relative = path.relative(root, real);
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
        const file = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const stat = await file.stat();
          if (!stat.isFile()) continue;
          const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const content = buffer.subarray(0, bytesRead).toString("utf8");
          if (!isSafeRepoSourceText(content)) continue;
          append(`\n[文件 ${relative.replaceAll(path.sep, "/")}]\n${content}${stat.size > bytesRead ? "\n[文件已截断]" : ""}\n`);
        } finally {
          await file.close();
        }
      }
    }
  }
  if (used >= MAX_SNAPSHOT_CHARS || inspected >= 10_000) parts.push("\n[材料预算已达上限，余下文件已截断]\n");
  return parts.join("");
}
