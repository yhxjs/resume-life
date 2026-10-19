import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DATA_DIR, getDb, inTransaction } from "@/lib/db";
import { logServerEvent } from "@/lib/server-errors";

export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

/** 头像 URL 前缀。UUID 文件名不可枚举，且文件本身不公开可读，因此走带 Host 校验的 API 路由。 */
export const UPLOAD_URL_PREFIX = "/api/uploads/";

/** 只允许单段文件名：拒绝分隔符、盘符与 .. ，杜绝路径穿越 */
const SAFE_FILENAME = /^[A-Za-z0-9._-]{1,128}$/;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function isSafeFilename(name: string): boolean {
  return SAFE_FILENAME.test(name) && name !== "." && name !== "..";
}

/** 头像 URL → 磁盘绝对路径；URL 不属于本机上传目录（外链、data URI）时返回 null */
export function uploadPathFromUrl(url: string): string | null {
  if (!url.startsWith(UPLOAD_URL_PREFIX)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url, "http://localhost");
  } catch {
    return null;
  }
  if (parsed.origin !== "http://localhost" || url !== `${parsed.pathname}${parsed.search}` ||
      (parsed.search && !/^\?v=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parsed.search))) return null;
  const name = parsed.pathname.slice(UPLOAD_URL_PREFIX.length);
  if (!isSafeFilename(name)) return null;
  const resolved = path.resolve(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, name));
  // 双重保险：文件名已由正则限死，这里再确认解析结果确实落在目录内
  return path.dirname(resolved) === path.resolve(UPLOADS_DIR) ? resolved : null;
}

/** 落盘一张头像，返回可直接存进 resume_modules.content.avatar 的 URL */
export async function saveUploadFile(bytes: Buffer, extension: string): Promise<{ filename: string; url: string }> {
  await fs.promises.mkdir(UPLOADS_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.promises.chmod(UPLOADS_DIR, 0o700);
  const filename = `${randomUUID()}${extension}`;
  const target = uploadPathFromUrl(`${UPLOAD_URL_PREFIX}${filename}`);
  if (!target) throw new Error("非法存储路径");
  await fs.promises.writeFile(target, bytes, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") await fs.promises.chmod(target, 0o600);
  return { filename, url: `${UPLOAD_URL_PREFIX}${filename}` };
}

/**
 * 删除一张已不再被引用的头像。
 * 失败只记 warn 不上抛：调用方此刻已经完成数据库提交，为一次文件清理失败回滚用户操作得不偿失。
 */
export function removeUploadByUrl(url: string): void {
  const target = uploadPathFromUrl(url);
  if (!target) return;
  try {
    fs.rmSync(target, { force: true });
  } catch {
    logServerEvent("warn", "upload.remove", {
      context: { resource: "avatar-file" },
    });
  }
}

export function removeUnreferencedUploadByUrl(url: string): void {
  const target = uploadPathFromUrl(url);
  if (!target) return;
  try {
    inTransaction(() => {
      const filename = path.basename(target);
      if (hasReferencedUploadFilename(getDb(), filename)) return;
      removeUploadByUrl(url);
    });
  } catch {
    logServerEvent("warn", "upload.remove", { context: { resource: "avatar-reference-check" } });
  }
}

/** 同一事务内只枚举一次引用，避免逐个历史头像重复扫描简历快照。 */
export function removeUnreferencedUploadsByUrls(urls: string[]): void {
  const targets = new Map<string, string>();
  for (const url of urls) {
    const target = uploadPathFromUrl(url);
    if (target) targets.set(path.basename(target), url);
  }
  if (!targets.size) return;
  try {
    inTransaction(() => {
      const referenced = referencedUploadFilenames(getDb());
      for (const [filename, url] of targets) {
        if (!referenced.has(filename)) removeUploadByUrl(url);
      }
    });
  } catch {
    logServerEvent("warn", "upload.remove", { context: { resource: "avatar-reference-check" } });
  }
}

export function readUploadFile(name: string): { bytes: Uint8Array; contentType: string } | null {
  const target = uploadPathFromUrl(`${UPLOAD_URL_PREFIX}${name}`);
  if (!target) return null;
  try {
    if (!fs.lstatSync(/*turbopackIgnore: true*/ target).isFile()) throw new Error("头像不是普通文件");
    return {
      bytes: new Uint8Array(fs.readFileSync(/*turbopackIgnore: true*/ target)),
      contentType: CONTENT_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function readUploadFileForSnapshot(name: string): { bytes: Uint8Array; contentType: string } | null {
  if (!uploadPathFromUrl(`${UPLOAD_URL_PREFIX}${name}`)) throw new Error("非法存储路径");
  return readUploadFile(name);
}

/** 备份用：列出全部头像文件名（排序保证导出可复现，只含合法单段文件名） */
export function listUploadFilenames(): string[] {
  try {
    return fs
      .readdirSync(UPLOADS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isSafeFilename(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const AVATAR_URLS_SQL = `
    WITH avatar_urls AS (
      SELECT resume_id, json_extract(CASE WHEN json_valid(content) THEN content ELSE '{}' END, '$.avatar') AS url
      FROM resume_modules
      WHERE type = 'basic' AND json_type(CASE WHEN json_valid(content) THEN content ELSE '{}' END) = 'object'
      UNION ALL
      SELECT resume_id, json_extract(CASE WHEN json_valid(item.value) THEN item.value ELSE '{}' END, '$.content.avatar')
      FROM resume_versions,
        json_each(CASE WHEN json_valid(snapshot) THEN snapshot ELSE '{}' END, '$.modules') AS item
      WHERE json_type(CASE WHEN json_valid(snapshot) THEN snapshot ELSE '{}' END, '$.modules') = 'array'
        AND item.type = 'object'
        AND json_type(CASE WHEN json_valid(item.value) THEN item.value ELSE '{}' END, '$.content') = 'object'
        AND json_extract(CASE WHEN json_valid(item.value) THEN item.value ELSE '{}' END, '$.type') = 'basic'
    )`;

/** HTTP 和单文件清理用：只返回指定头像是否被引用，不把全部历史快照读入 JavaScript。 */
export function hasReferencedUploadFilename(database: Pick<DatabaseSync, "prepare">, name: string): boolean {
  const url = `${UPLOAD_URL_PREFIX}${name}`;
  if (!uploadPathFromUrl(url)) return false;
  const uuidPattern = [8, 4, 4, 4, 12].map((length) => "[0-9a-f]".repeat(length)).join("-");
  const row = database.prepare(`${AVATAR_URLS_SQL}
    SELECT EXISTS (SELECT 1 FROM avatar_urls WHERE url = ? OR url GLOB ?) AS referenced
  `).get(url, `${url}[?]v=${uuidPattern}`) as { referenced: number };
  return row.referenced === 1;
}

/** 删除候选只读取本简历当前及历史头像标量；损坏内容不产生可删除的路径。 */
export function listResumeAvatarUrls(database: Pick<DatabaseSync, "prepare">, resumeId: number): string[] {
  const rows = database.prepare(`${AVATAR_URLS_SQL}
    SELECT DISTINCT url FROM avatar_urls WHERE resume_id = ? AND typeof(url) = 'text'
  `).all(resumeId) as { url: string }[];
  return rows.map((row) => row.url).filter((url) => uploadPathFromUrl(url) !== null);
}

/** 备份和清理用：枚举当前简历及历史版本引用的全部本机头像。 */
export function listReferencedUploadFilenames(database: { prepare: (sql: string) => { all: () => unknown[] } }): Set<string> {
  // 损坏历史快照必须中止备份/清扫，不能静默遗漏文件；只把错误标量传回 JS。
  const invalid = database.prepare(`
    SELECT 1 AS invalid FROM resume_versions
    WHERE NOT json_valid(snapshot)
      OR json_type(CASE WHEN json_valid(snapshot) THEN snapshot ELSE '{}' END, '$.modules') IS NOT 'array'
      OR EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(snapshot) THEN snapshot ELSE '{}' END, '$.modules')
        WHERE type = 'null'
      )
    LIMIT 1
  `).all();
  if (invalid.length) throw new Error("历史简历快照损坏，无法枚举头像引用");
  return referencedUploadFilenames(database);
}

function referencedUploadFilenames(database: { prepare: (sql: string) => { all: () => unknown[] } }): Set<string> {
  const rows = database.prepare(`${AVATAR_URLS_SQL}
    SELECT DISTINCT url FROM avatar_urls WHERE typeof(url) = 'text'
  `).all() as { url: string }[];
  const names = new Set<string>();
  for (const row of rows) {
    const target = uploadPathFromUrl(row.url);
    if (target) names.add(path.basename(target));
  }
  return names;
}

/**
 * 备份用：读取头像原始字节。
 *
 * HTTP 读取允许全部候选位置都不存在时返回 null；备份里读不到却返回 null
 * 会变成「静默少备份一个文件」，用户直到恢复后头像裂开才发现。
 * 因此这里一律抛错，让导出整体失败。
 */
export function readUploadBytes(name: string): Buffer {
  const target = uploadPathFromUrl(`${UPLOAD_URL_PREFIX}${name}`);
  if (!target) throw new Error("非法存储路径");
  return fs.readFileSync(/*turbopackIgnore: true*/ target);
}

/** 备份用：头像文件字节数。清单要写在流的最前面，此时不该把内容整份读进内存 */
export function uploadFileSize(name: string): number {
  const target = uploadPathFromUrl(`${UPLOAD_URL_PREFIX}${name}`);
  if (!target) throw new Error("非法存储路径");
  return fs.statSync(/*turbopackIgnore: true*/ target).size;
}

/** 从 resume_modules.content 原文里取出 avatar 指针；解析失败按「没有头像」处理 */
export function avatarUrlFromContent(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const avatar = (parsed as { avatar?: unknown }).avatar;
      if (typeof avatar === "string") return avatar;
    }
  } catch {
    // 损坏的模块内容由 loadResume 另行提示，这里只关心有没有可删的文件
  }
  return "";
}

/**
 * 清理孤儿头像：写新删旧只覆盖「同一简历换头像」这一条路径，进程崩溃、
 * 简历删除和进程中断
 * 都会留下无人指向的文件，而该目录既无配额也无监控。
 *
 * 两条保守约束，宁可漏删也不误删：
 * - 库里一条简历都没有时直接返回。数据目录被指错到空库时，全盘清理会把用户头像删光。
 * - 只删修改时间超过 GRACE_MS 的文件。刚落盘、尚未写进数据库的文件不能被当成孤儿。
 *
 * 调用点在保存头像之后：那里数据库必然已打开（不在启动钩子里碰库是本仓库的既有约定）。
 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export function sweepOrphanUploads(database: { prepare: (sql: string) => { all: () => unknown[] } }): void {
  try {
    const resumes = database.prepare("SELECT id FROM resumes").all();
    if (resumes.length === 0) return;

    const referenced = listReferencedUploadFilenames(database);

    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    for (const name of listStoredFilenames()) {
      if (referenced.has(name)) continue;
      const target = uploadPathFromUrl(`${UPLOAD_URL_PREFIX}${name}`);
      if (!target) continue;
      try {
        if (fs.statSync(/*turbopackIgnore: true*/ target).mtimeMs > cutoff) continue;
        fs.rmSync(target, { force: true });
      } catch {
        // 单个文件失败不影响其余清理
      }
    }
  } catch {
    logServerEvent("warn", "upload.sweep", { context: { resource: "avatar-orphans" } });
  }
}

function listStoredFilenames(): string[] {
  try {
    return fs
      .readdirSync(UPLOADS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isSafeFilename(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
