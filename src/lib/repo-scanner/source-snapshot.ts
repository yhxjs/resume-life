import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { RepoTarget } from "./prompts";
import { repoRootPathError } from "./path-policy";
import { decodeRepoSourcePrefix, sliceRepoSourcePrefix } from "./source-text";
import { REPO_MANIFEST_NAMES } from "./project-files";
import { reportMcpProgress } from "../mcp-progress";

const MAX_SNAPSHOT_CHARS = 180_000;
const MAX_SNAPSHOT_ENTRIES = 10_000;
const MAX_SNAPSHOT_DEPTH = 12;
const MAX_FILE_BYTES = 32_000;
const SNAPSHOT_LIMIT_MARKER = "\n[本代码库采集预算已达上限，余下材料已截断；未提供的文件或后文不代表不存在]\n";
const SNAPSHOT_DEPTH_LIMIT_MARKER = SNAPSHOT_LIMIT_MARKER.replace("采集预算", "目录深度");
const SNAPSHOT_BOTH_LIMIT_MARKER = SNAPSHOT_LIMIT_MARKER.replace("采集预算", "采集预算与目录深度");
const EXCLUDED_DIRS = new Set(["node_modules", "vendor", "data", "coverage", "dist", "build", "target", "out", "test-results"]);
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro", ".json", ".md",
  ".py", ".php", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".groovy", ".scala", ".cs",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".css", ".html", ".sql", ".toml", ".xml", ".yaml", ".yml",
]);
// 路径预检认可的工程清单中，有些没有通用源码扩展名；只补充明确文件名，不放开全部 txt 等格式。
const SOURCE_FILENAMES = new Set(["readme", ...REPO_MANIFEST_NAMES]);
const PRIMARY_SOURCE_DIRS = new Set(["src", "app", "lib"]);
const DEFERRED_SOURCE_DIRS = new Set(["__tests__", "tests", "test", "__fixtures__", "fixtures", "docs", "examples"]);

type DirectoryTask = { directory: string; depth: number; priority: 0 | 1 | 2 };

function serializeRecord(record: object): string {
  return `${JSON.stringify(record)}\n`;
}

function filePriority(name: string): number {
  const lower = name.toLowerCase();
  return lower.startsWith("readme") ? 0 : REPO_MANIFEST_NAMES.has(lower) ? 1 : 2;
}

export class RepoSourceEmptyError extends Error {
  constructor() {
    super("未采集到可用的源码或文档，请确认所选目录包含非空、受支持且可安全读取的文件后重试");
    this.name = "RepoSourceEmptyError";
  }
}

/** 排除明显凭证与私钥材料；未知业务格式仍需用户在扫描前清理。 */
export function isSafeRepoSourceText(content: string, partial = false): boolean {
  return !content.includes("\0")
    && !/-----BEGIN (?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/.test(content)
    // URL 的 authority 可携带口令或仅含令牌的用户名。读到半个 authority 时也跳过整份文件。
    && !/\bhttps?:\/\/[^\s/?#]+@/i.test(content)
    && !(partial && /\bhttps?:\/\/[^\s/?#]*$/i.test(content))
    // PHP/Ruby 哈希箭头、字符串或符号下标赋值同样可能保存凭证；比较和读取不算赋值。
    && !/["']?\b[a-z0-9_-]*?(?:api[_-]?key|password|passwd|secret|token|access[_-]?key[_-]?id|secret[_-]?access[_-]?key|secret[_-]?key)\b["']?\s*(?:=>|:|(?:\]\s*)?(?:\?\?|\|\|)?=(?!=|>))\s*(?:["'][^"'\r\n]+(?:["']|$)|[A-Za-z0-9_+/=-]+)/i.test(content)
    && !/\bauthorization\b["']?\s*(?:=>|:|,|(?:\]\s*)?(?:\?\?|\|\|)?=(?!=|>))\s*["']?Bearer[ \t]+[A-Za-z0-9._~+/-]+=*/i.test(content)
    && !/\b(?:password|pwd|accountkey|accesskey)\s*=\s*[^;\s"']+/i.test(content)
    && !/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis(?:s)?|amqp(?:s)?):\/\/[^\s/@:]*:[^\s/@]+@/i.test(content);
}

function eligible(name: string): boolean {
  const lower = name.toLowerCase();
  return !lower.startsWith(".") && !/^(?:agents|claude|gemini)\.md$/.test(lower)
    && !/(?:secret|credential|password|token|private[-_]?key)/.test(lower)
    && !/(?:lock\.(?:json|yaml)|\.lock)$/.test(lower)
    && (SOURCE_FILENAMES.has(lower) || SOURCE_EXTENSIONS.has(path.extname(lower)));
}

/** 只由应用读取白名单源码；CLI 消费这份文本，不获得宿主文件工具。 */
export async function collectRepoSourceSnapshot(targets: readonly RepoTarget[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const parts: string[] = [];
  let used = 0;
  let inspected = 0;
  let hasSource = false;
  let collectedFiles = 0;
  let charLimit = MAX_SNAPSHOT_CHARS;
  const append = (value: string): boolean => {
    const remaining = charLimit - used;
    // 记录必须完整写入，不能把 JSON 键名、引号或转义序列切开。
    if (value.length > remaining) return false;
    parts.push(value);
    used += value.length;
    return true;
  };
  for (const [index, target] of targets.entries()) {
    signal?.throwIfAborted();
    // 给尚未采集的仓库预留字符和遍历额度；此前没用完的额度可继续分配。
    const remainingTargets = targets.length - index;
    const repoLimit = used + Math.floor((MAX_SNAPSHOT_CHARS - used) / remainingTargets);
    const entryLimit = inspected + Math.floor((MAX_SNAPSHOT_ENTRIES - inspected) / remainingTargets);
    const repoNumber = index + 1;
    // false 比 true 多一个字符，按最长说明和布尔值预留完整限制记录。
    const limitReserve = serializeRecord({ kind: "limit", repoNumber, budgetLimited: false, depthLimited: false, note: SNAPSHOT_BOTH_LIMIT_MARKER.trim() }).length;
    charLimit = Math.max(used, repoLimit - limitReserve);
    let depthLimited = false;
    const root = await fs.realpath(target.path);
    signal?.throwIfAborted();
    const rootError = repoRootPathError(root);
    if (rootError) throw new Error(rootError);
    // 三个队列保留同级广度优先；源码分支先于普通分支，测试/文档仍保留在后续采集。
    // 目录名只决定有限预算的采集顺序，不作为代码用途或业务已实现的证据。
    const directoryQueues: [DirectoryTask[], DirectoryTask[], DirectoryTask[]] = [[], [{ directory: root, depth: 0, priority: 1 }], []];
    if (!append(serializeRecord({ kind: "repository", repoNumber }))) charLimit = used;
    while (directoryQueues.some(queue => queue.length) && used < charLimit && inspected < entryLimit) {
      signal?.throwIfAborted();
      const current = directoryQueues.find(queue => queue.length)!.shift()!;
      const entries = await fs.readdir(current.directory, { withFileTypes: true });
      signal?.throwIfAborted();
      entries.sort((a, b) => filePriority(a.name) - filePriority(b.name) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (inspected >= entryLimit || used >= charLimit) break;
        inspected++;
        if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
        const filename = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          const lower = entry.name.toLowerCase();
          if (!EXCLUDED_DIRS.has(lower) && current.depth < MAX_SNAPSHOT_DEPTH) {
            const priority = current.priority === 2 || DEFERRED_SOURCE_DIRS.has(lower) ? 2
              : current.priority === 0 || PRIMARY_SOURCE_DIRS.has(lower) ? 0 : 1;
            directoryQueues[priority].push({ directory: filename, depth: current.depth + 1, priority });
          } else if (!EXCLUDED_DIRS.has(lower)) {
            depthLimited = true;
          }
          continue;
        }
        if (!entry.isFile() || !eligible(entry.name)) continue;
        // readdir 的类型与 realpath 的边界都可能已过时；打开后再核对文件身份。
        const before = await fs.lstat(filename);
        signal?.throwIfAborted();
        if (!before.isFile() || before.isSymbolicLink()) continue;
        const real = await fs.realpath(filename);
        signal?.throwIfAborted();
        const relative = path.relative(root, real);
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
        const file = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          // open 不能硬中断；取得句柄后先检查取消，仍由 finally 负责关闭。
          signal?.throwIfAborted();
          const stat = await file.stat();
          signal?.throwIfAborted();
          if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) continue;
          const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
          let bytesRead = 0;
          while (bytesRead < buffer.length) {
            const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            signal?.throwIfAborted();
            if (chunk.bytesRead === 0) break;
            bytesRead += chunk.bytesRead;
          }
          const content = decodeRepoSourcePrefix(buffer.subarray(0, bytesRead), stat.size > bytesRead);
          if (!content.trim() || !isSafeRepoSourceText(content, stat.size > bytesRead)) continue;
          const record = { kind: "file", repoNumber, path: relative.replaceAll(path.sep, "/"), content, truncated: stat.size > bytesRead };
          const remaining = charLimit - used;
          let serialized = serializeRecord(record);
          const budgetLimited = serialized.length > remaining;
          if (budgetLimited) {
            record.truncated = true;
            // 按 JSON 编码后的实际长度选完整码点前缀；文件读取预算仍为 32,000 字节。
            let lower = 0;
            // true 比 false 短一个字符；仍须实际移除正文，不能仅改标志来挤进预算。
            let upper = content.length - 1;
            while (lower < upper) {
              const middle = Math.ceil((lower + upper) / 2);
              record.content = sliceRepoSourcePrefix(content, middle);
              if (serializeRecord(record).length <= remaining) lower = middle;
              else upper = middle - 1;
            }
            record.content = sliceRepoSourcePrefix(content, lower);
            serialized = serializeRecord(record);
          }
          // 只有实际保留的非空白正文才算材料，元数据和截断状态不能充当源码。
          if (record.content && append(serialized)) {
            hasSource ||= record.content.trim().length > 0;
            reportMcpProgress("reading", ++collectedFiles, null, "files");
          }
          if (budgetLimited) charLimit = used;
        } finally {
          await file.close();
        }
      }
    }
    const budgetLimited = used >= charLimit || inspected >= entryLimit;
    if (budgetLimited || depthLimited) {
      charLimit = repoLimit;
      const note = depthLimited ? (budgetLimited ? SNAPSHOT_BOTH_LIMIT_MARKER : SNAPSHOT_DEPTH_LIMIT_MARKER) : SNAPSHOT_LIMIT_MARKER;
      append(serializeRecord({ kind: "limit", repoNumber, budgetLimited, depthLimited, note: note.trim() }));
    }
  }
  signal?.throwIfAborted();
  return hasSource ? parts.join("") : "";
}
