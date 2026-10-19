import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

let tempDir: string;
let db: DatabaseSync;
let auth: typeof import("../auth");

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-auth-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  auth = await import("../auth");
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-auth-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("REINIT_ENV_KEY 逃生门开关", () => {
  it.each(["1", "true", "TRUE", "yes", "on", " Yes "])("放行真值 %s", (value) => {
    vi.stubEnv("RESUME_LIFE_AUTH_REINIT", value);
    expect(auth.reinitAllowed()).toBe(true);
  });

  it.each(["", "0", "false", "off", "随手写的值"])("拒绝非真值 %j", (value) => {
    vi.stubEnv("RESUME_LIFE_AUTH_REINIT", value);
    expect(auth.reinitAllowed()).toBe(false);
  });

  it("未设置时默认关闭", () => {
    expect(auth.reinitAllowed()).toBe(false);
  });
});

describe("初始化与登录校验", () => {
  it("全新库未初始化，初始化后可校验凭证", async () => {
    expect(auth.authStatus()).toEqual({ initialized: false, allowReinit: false });
    auth.initializeCredentials("  admin  ", "secret123");
    expect(auth.authStatus()).toEqual({ initialized: true, allowReinit: false });
    expect(await auth.verifyCredentials("admin", "secret123")).toBe(true);
    expect(await auth.verifyCredentials("admin", "wrong!password")).toBe(false);
    expect(await auth.verifyCredentials("someone", "secret123")).toBe(false);
  });

  it("密码存的是 scrypt 哈希，不含明文", () => {
    auth.initializeCredentials("admin", "secret123");
    const row = db.prepare("SELECT password_hash FROM auth_users WHERE id = 1").get() as { password_hash: string };
    expect(row.password_hash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(row.password_hash).not.toContain("secret123");
  });

  it("凭证输入不合法时抛 AuthInputError", () => {
    expect(() => auth.initializeCredentials("   ", "secret123")).toThrow(auth.AuthInputError);
    expect(() => auth.initializeCredentials("a".repeat(41), "secret123")).toThrow(auth.AuthInputError);
    expect(() => auth.initializeCredentials("admin", "12345")).toThrow(auth.AuthInputError);
    expect(() => auth.initializeCredentials("admin", "p".repeat(129))).toThrow(auth.AuthInputError);
  });

  it("未初始化时登录校验直接失败", async () => {
    expect(await auth.verifyCredentials("admin", "secret123")).toBe(false);
  });

  it("重新初始化覆写凭证并清空全部会话，旧令牌立即失效", async () => {
    auth.initializeCredentials("admin", "old-secret-1");
    const session = auth.createSession();
    expect(auth.resolveSession(session.token)).not.toBeNull();

    vi.stubEnv("RESUME_LIFE_AUTH_REINIT", "true");
    auth.initializeCredentials("root", "new-secret-2");

    expect(auth.resolveSession(session.token)).toBeNull();
    expect(await auth.verifyCredentials("root", "new-secret-2")).toBe(true);
    expect(await auth.verifyCredentials("root", "old-secret-1")).toBe(false);
    expect(await auth.verifyCredentials("admin", "new-secret-2")).toBe(false);
  });

  it("密码验证不会阻塞主线程，且并发超限时快速拒绝", async () => {
    auth.initializeCredentials("admin", "secret123");
    const running = [auth.verifyCredentials("admin", "secret123"), auth.verifyCredentials("admin", "secret123")];
    const completed = Promise.all(running);
    const rejected = Promise.resolve().then(() => auth.verifyCredentials("admin", "secret123"));
    await expect(rejected).rejects.toThrow(/繁忙|过多/);
    expect(await completed).toEqual([true, true]);
  });

  it("密码校验期间重置凭证会拒绝在途的旧登录", async () => {
    auth.initializeCredentials("admin", "old-password");
    const pending = auth.verifyCredentials("admin", "old-password");
    vi.stubEnv("RESUME_LIFE_AUTH_REINIT", "true");
    auth.initializeCredentials("admin", "new-password");
    expect(await pending).toBe(false);
  });
});

describe("会话生命周期", () => {
  beforeEach(() => {
    auth.initializeCredentials("admin", "secret123");
  });

  it("签发的会话可解析，过期时间为 7 天后", () => {
    const session = auth.createSession();
    const resolved = auth.resolveSession(session.token);
    expect(resolved).not.toBeNull();
    const expected = new Date(Date.now() + auth.SESSION_TTL_MS).toISOString();
    expect(Math.abs(new Date(expected).getTime() - new Date(resolved!.expiresAt).getTime())).toBeLessThan(5000);
  });

  it("滑动续期把过期时间向后推进", () => {
    const session = auth.createSession();
    const before = auth.resolveSession(session.token)!.expiresAt;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
    auth.renewSession(auth.resolveSession(session.token)!.tokenHash);
    const after = auth.resolveSession(session.token)!.expiresAt;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("节流续期：窗口内跳过写库，窗口外推进过期时间", () => {
    const session = auth.createSession();
    // 刚签发的会话上次续期就是现在，处于 1 小时节流窗口内
    expect(auth.renewSessionThrottled(auth.resolveSession(session.token)!)).toBe(false);
    // 回拨过期时间，模拟上次续期发生在 2 小时前
    db.prepare("UPDATE auth_sessions SET expires_at = ?").run(
      new Date(Date.now() + auth.SESSION_TTL_MS - 2 * 60 * 60 * 1000).toISOString(),
    );
    const stale = auth.resolveSession(session.token)!;
    expect(auth.renewSessionThrottled(stale)).toBe(true);
    const after = auth.resolveSession(session.token)!.expiresAt;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(stale.expiresAt).getTime());
  });

  it("过期会话解析返回 null 并被顺带清理", () => {
    const session = auth.createSession();
    db.prepare("UPDATE auth_sessions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE token_hash = ?")
      .run(auth.resolveSession(session.token)!.tokenHash);
    expect(auth.resolveSession(session.token)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: 0 });
  });

  it("撤销后的令牌不再有效", () => {
    const session = auth.createSession();
    expect(auth.resolveSession(session.token)).not.toBeNull();
    auth.revokeSession(session.token);
    expect(auth.resolveSession(session.token)).toBeNull();
  });

  it("签发新会话时清理历史过期会话", () => {
    db.prepare("INSERT INTO auth_sessions (token_hash, created_at, expires_at) VALUES ('stale', '', '2020-01-01T00:00:00.000Z')").run();
    auth.createSession();
    const rows = db.prepare("SELECT token_hash FROM auth_sessions").all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe("stale");
  });

  it("未知令牌与空令牌都解析为 null", () => {
    expect(auth.resolveSession("not-a-real-token")).toBeNull();
    expect(auth.resolveSession(undefined)).toBeNull();
    expect(auth.resolveSession(null)).toBeNull();
    expect(auth.resolveSession("")).toBeNull();
  });
});
