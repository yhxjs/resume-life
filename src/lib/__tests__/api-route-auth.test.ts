import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-route-auth-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-route-auth-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const COOKIE_NAME = "resume_life_session";

const requestFor = (token?: string) =>
  new Request("http://127.0.0.1:3000/api/anything", token ? { headers: { cookie: `${COOKIE_NAME}=${token}` } } : {});

const okHandler = () => Response.json({ ok: true });

describe("withRouteErrorHandling 的会话鉴权", () => {
  beforeEach(async () => {
    const auth = await import("@/lib/auth");
    auth.initializeCredentials("admin", "secret123");
  });

  async function wrapped(options?: { public?: boolean }) {
    const { withRouteErrorHandling } = await import("@/lib/api-route");
    return withRouteErrorHandling("GET /api/anything", okHandler, options);
  }

  it("无 cookie 与伪造 cookie 一律 401，handler 不执行", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const route = await wrapped();

    const anonymous = await route(requestFor());
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    expect(await anonymous.json()).toEqual({ error: "未登录或登录已过期，请重新登录" });

    const forged = await route(requestFor("forged-token"));
    expect(forged.status).toBe(401);
  });

  it.each(["%", "%GG", "%E0%A4%A"])("畸形会话 Cookie %s 返回 401 且不执行 handler", async (token) => {
    vi.stubEnv("NODE_ENV", "production");
    const handler = vi.fn(okHandler);
    const { withRouteErrorHandling } = await import("@/lib/api-route");
    const route = withRouteErrorHandling("GET /api/anything", handler);
    const response = await route(requestFor(token));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "未登录或登录已过期，请重新登录" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("Cookie 解码只忽略 URIError，其他异常仍向上抛出", async () => {
    const { sessionTokenFromRequest } = await import("@/lib/auth");
    const request = requestFor("synthetic-token");
    vi.spyOn(globalThis, "decodeURIComponent").mockImplementation(() => { throw new TypeError("synthetic unexpected error"); });
    expect(() => sessionTokenFromRequest(request)).toThrow("synthetic unexpected error");
  });

  it("有效会话且处于节流窗口外时放行：滑动续期并刷新 cookie 有效期", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { createSession, SESSION_TTL_MS } = await import("@/lib/auth");
    const { token } = createSession();
    // 回拨过期时间，模拟上次续期发生在 2 小时前（节流窗口为 1 小时）
    db.prepare("UPDATE auth_sessions SET expires_at = ?").run(
      new Date(Date.now() + SESSION_TTL_MS - 2 * 60 * 60 * 1000).toISOString(),
    );
    const before = (db.prepare("SELECT expires_at FROM auth_sessions").get() as { expires_at: string }).expires_at;

    const route = await wrapped();
    vi.stubEnv("RESUME_LIFE_SECURE_COOKIES", "true");
    const response = await route(requestFor(token));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const after = (db.prepare("SELECT expires_at FROM auth_sessions").get() as { expires_at: string }).expires_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${COOKIE_NAME}=${encodeURIComponent(token)}`);
    expect(setCookie).toContain("Max-Age=604800");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
  });

  it("节流窗口内的请求跳过续期写库与 cookie 刷新", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { createSession } = await import("@/lib/auth");
    const { token } = createSession();
    const before = (db.prepare("SELECT expires_at FROM auth_sessions").get() as { expires_at: string }).expires_at;

    const route = await wrapped();
    const response = await route(requestFor(token));

    expect(response.status).toBe(200);
    const after = (db.prepare("SELECT expires_at FROM auth_sessions").get() as { expires_at: string }).expires_at;
    expect(after).toBe(before);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("public 选项豁免鉴权：未登录也可执行 handler", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const route = await wrapped({ public: true });
    const response = await route(requestFor());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("vitest 进程（NODE_ENV=test）默认跳过鉴权，既有集成测试无需补会话", async () => {
    const route = await wrapped();
    expect((await route(requestFor())).status).toBe(200);
  });
});
