import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb, inTransaction, now } from "./db";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, SESSION_TTL_SECONDS, REINIT_ENV_KEY } from "./auth-constants";
import { acquireAuthPasswordCheck, completeAuthPasswordCheck } from "./shared-budgets";

export { SESSION_COOKIE_NAME, SESSION_TTL_MS, SESSION_TTL_SECONDS, REINIT_ENV_KEY };

/**
 * 登录鉴权域：单用户凭证（auth_users）+ 不透明会话令牌（auth_sessions）。
 *
 * - 密码只存 scrypt 哈希（salt 随机、比对用 timingSafeEqual）；
 * - 会话令牌只存 SHA-256 哈希，明文令牌仅存在于浏览器 httpOnly cookie；
 * - 会话滑动续期：距上次续期满一小时的已登录请求推进过期时间与 cookie；窗口内跳过续期写入；
 * - 凭证属于机器本地运行时状态（同 runtime_state），不进用户备份；
 *   重新初始化只覆写 auth_users 并清空 auth_sessions，其余业务数据不动。
 */

const USERNAME_MAX_LENGTH = 40;
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 128;
const SCRYPT_KEY_LENGTH = 64;

/** 用户输入不合法：route 层收口为 400（与 ApplicationInputError 同一约定） */
export class AuthInputError extends Error {}

export class AuthAlreadyInitializedError extends Error {}

export class AuthRateLimitError extends Error {
  constructor(message: string, readonly retryAfter = 60) { super(message); }
}

/** 读取逃生门开关：接受 1 / true / yes / on（大小写不敏感） */
export function reinitAllowed(): boolean {
  const value = (process.env[REINIT_ENV_KEY] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/** 逃生门只为当前成功的初始化请求提供一次性进程内开关。 */
export function clearReinitFlag(): void {
  delete process.env[REINIT_ENV_KEY];
}

export function isInitialized(): boolean {
  const row = getDb().prepare("SELECT 1 AS ok FROM auth_users WHERE id = 1").get();
  return row !== undefined;
}

export type AuthStatus = {
  initialized: boolean;
  allowReinit: boolean;
};

export function authStatus(): AuthStatus {
  return { initialized: isInitialized(), allowReinit: reinitAllowed() };
}

function validateCredentials(username: string, password: string): { username: string } {
  const trimmed = username.trim();
  if (trimmed.length < 1 || trimmed.length > USERNAME_MAX_LENGTH) {
    throw new AuthInputError(`用户名需要 1-${USERNAME_MAX_LENGTH} 个字符`);
  }
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new AuthInputError(`密码长度需要在 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 个字符之间`);
  }
  return { username: trimmed };
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, "hex");
    const actual = await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, Buffer.from(saltHex, "hex"), expected.length, (error, value) => {
        if (error) reject(error);
        else resolve(value);
      });
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 用户不存在时也对固定哈希跑一次 scrypt，让「用户名错误」与「密码错误」耗时一致 */
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(16).toString("hex"));

/**
 * 初始化或重新初始化用户名和密码。
 * 事务内校验「未初始化，或逃生门已开启」，不能用路由读取正文前的状态授权；
 * 重新初始化会清空全部会话，迫使所有已登录端重新登录。
 */
export function initializeCredentials(username: string, password: string): boolean {
  const { username: name } = validateCredentials(username, password);
  const hash = hashPassword(password);
  const timestamp = now();
  return inTransaction(() => {
    const initialized = isInitialized();
    if (initialized && !reinitAllowed()) {
      throw new AuthAlreadyInitializedError("已初始化过用户名和密码");
    }
    getDb()
      .prepare(
        `INSERT INTO auth_users (id, username, password_hash, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
      )
      .run(name, hash, timestamp, timestamp);
    getDb().prepare("DELETE FROM auth_sessions").run();
    return initialized;
  });
}

const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_MAX_ACTIVE_CHECKS = 2;
const LOGIN_CHECK_LEASE_MS = 120_000;

/** 单用户共用固定窗口与有界异步校验，不依赖可伪造的代理 IP。 */
export async function verifyCredentials(username: string, password: string): Promise<boolean> {
  if (!password) return false;
  validateCredentials(username, password);
  const row = getDb()
    .prepare("SELECT username, password_hash FROM auth_users WHERE id = 1")
    .get() as { username: string; password_hash: string } | undefined;
  if (!row) return false;
  const budget = acquireAuthPasswordCheck({
    windowMs: LOGIN_WINDOW_MS,
    maxFailures: LOGIN_MAX_FAILURES,
    maxActive: LOGIN_MAX_ACTIVE_CHECKS,
    leaseMs: LOGIN_CHECK_LEASE_MS,
  });
  if (budget.kind === "rate-limited") {
    throw new AuthRateLimitError("登录尝试过多，请稍后重试", budget.retryAfter);
  }
  if (budget.kind === "busy") throw new AuthRateLimitError("密码验证繁忙，请稍后重试", budget.retryAfter);
  let completed = false;
  const complete = (success: boolean) => {
    if (completed) return;
    completeAuthPasswordCheck(budget.token, success);
    completed = true;
  };
  try {
    const usernameMatches = row.username === username.trim();
    const passwordMatches = await verifyPassword(password, usernameMatches ? row.password_hash : DUMMY_PASSWORD_HASH);
    if (usernameMatches && passwordMatches) {
      const current = getDb().prepare("SELECT username, password_hash FROM auth_users WHERE id = 1").get() as
        { username: string; password_hash: string } | undefined;
      if (!current || current.username !== row.username || current.password_hash !== row.password_hash) {
        complete(false);
        return false;
      }
      complete(true);
      return true;
    }
    complete(false);
    return false;
  } finally {
    // completeAuthPasswordCheck 已在结果分支执行；异常路径也必须归还 lease。
    complete(false);
  }
}

export type IssuedSession = {
  token: string;
  expiresAt: string;
};

/** 密码派生期间可发生重置；签发前在写事务里复核凭证快照。 */
export async function loginSession(username: string, password: string): Promise<IssuedSession | null> {
  const before = getDb().prepare("SELECT username, password_hash FROM auth_users WHERE id = 1").get() as
    { username: string; password_hash: string } | undefined;
  if (!await verifyCredentials(username, password) || !before) return null;
  return inTransaction(() => {
    const current = getDb().prepare("SELECT username, password_hash FROM auth_users WHERE id = 1").get() as
      { username: string; password_hash: string } | undefined;
    if (!current || current.username !== before.username || current.password_hash !== before.password_hash) return null;
    return createSession();
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionExpiry(): string {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
}

/** 签发新会话；顺手清理已过期会话，避免表无限增长 */
export function createSession(): IssuedSession {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = sessionExpiry();
  const db = getDb();
  db.prepare("INSERT INTO auth_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), now(), expiresAt);
  db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now());
  return { token, expiresAt };
}

export type ResolvedSession = {
  tokenHash: string;
  expiresAt: string;
};

/**
 * 校验请求携带的会话令牌；无效或已过期返回 null。
 * 过期令牌在此处删除（懒清理），防止持续收到过期请求时表里留垃圾。
 */
export function resolveSession(token: string | undefined | null): ResolvedSession | null {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = getDb()
    .prepare("SELECT token_hash, expires_at FROM auth_sessions WHERE token_hash = ?")
    .get(tokenHash) as { token_hash: string; expires_at: string } | undefined;
  if (!row) return null;
  if (row.expires_at <= now()) {
    getDb().prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  return { tokenHash: row.token_hash, expiresAt: row.expires_at };
}

/** 滑动续期：把会话过期时间推进到当前时刻 + TTL；会话已被撤销时是无害的空操作 */
export function renewSession(tokenHash: string): void {
  getDb()
    .prepare("UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?")
    .run(sessionExpiry(), tokenHash);
}

/** 续期节流窗口：距上次续期不足该时长时跳过写库与 cookie 刷新 */
export const SESSION_RENEW_THROTTLE_MS = 60 * 60 * 1000;

/**
 * 带节流的滑动续期：距上次续期不足 SESSION_RENEW_THROTTLE_MS 时跳过，
 * 把「每个请求一次写事务 + fsync」降到「每小时最多一次」。
 * 上次续期时间可由 expires_at - TTL 推出，无需额外状态；节流使
 * 非活动容忍度从整 7 天变为 7 天 - 节流窗口，对单用户本地工具无感知。
 * 返回是否真的续了期，调用方据此决定是否刷新浏览器 cookie。
 */
export function renewSessionThrottled(session: ResolvedSession): boolean {
  const lastRenewedAt = new Date(session.expiresAt).getTime() - SESSION_TTL_MS;
  if (Date.now() - lastRenewedAt < SESSION_RENEW_THROTTLE_MS) return false;
  renewSession(session.tokenHash);
  return true;
}

export function revokeSession(token: string | undefined | null): void {
  if (!token) return;
  getDb().prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashToken(token));
}

/** 从普通 Request 的 Cookie 头解析会话令牌（route 包装器不依赖 NextRequest） */
export function sessionTokenFromRequest(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch (error) {
        if (error instanceof URIError) return undefined;
        throw error;
      }
    }
  }
  return undefined;
}

/** 滑动续期后刷新浏览器侧 cookie 有效期用的 Set-Cookie 值 */
export function sessionCookieHeaderValue(token: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${sessionCookieOptions().secure ? "; Secure" : ""}`;
}

/** TLS 由部署者显式声明，不信任客户端的转发头；本机 HTTP 默认仍可用。 */
export function sessionCookieOptions(maxAge = SESSION_TTL_SECONDS) {
  return { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge,
    secure: process.env.RESUME_LIFE_SECURE_COOKIES === "true" };
}
