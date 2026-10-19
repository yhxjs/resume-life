import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-auth-routes-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-auth-routes-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const jsonRequest = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:3000${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function sessionCookieOf(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /resume_life_session=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`响应缺少会话 cookie：${setCookie}`);
  return decodeURIComponent(match[1]!);
}

describe("GET /api/auth/status", () => {
  it("报告未初始化状态，逃生门开启时如实上报", async () => {
    const route = await import("@/app/api/auth/status/route");
    expect(await (await route.GET(jsonRequest("/api/auth/status"))).json())
      .toEqual({ initialized: false, allowReinit: false });

    vi.stubEnv("RESUME_LIFE_AUTH_REINIT", "true");
    expect(await (await route.GET(jsonRequest("/api/auth/status"))).json())
      .toEqual({ initialized: false, allowReinit: true });
  });
});

describe("POST /api/auth/init", () => {
  it("受信 HTTPS 部署配置在初始化、登录和退出中保持 Secure 属性", async () => {
    vi.stubEnv("RESUME_LIFE_SECURE_COOKIES", "true");
    const init = await import("@/app/api/auth/init/route");
    const login = await import("@/app/api/auth/login/route");
    const logout = await import("@/app/api/auth/logout/route");
    const body = { username: "admin", password: "secret123" };
    const initialized = await init.POST(jsonRequest("/api/auth/init", body));
    const loggedIn = await login.POST(jsonRequest("/api/auth/login", body));
    const loggedOut = await logout.POST(jsonRequest("/api/auth/logout", {}));
    for (const response of [initialized, loggedIn, loggedOut]) {
      expect(response.headers.get("set-cookie")).toMatch(/;\s*Secure(?:;|$)/i);
    }
  });
  it("延迟请求体不能覆写另一请求已经建立的凭证", async () => {
    const route = await import("@/app/api/auth/init/route");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const slow = new Request("http://127.0.0.1:3000/api/auth/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({ start(value) { controller = value; } }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = route.POST(slow);
    const first = await route.POST(jsonRequest("/api/auth/init", { username: "first", password: "first-password" }));
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ username: "late", password: "late-password" })));
    controller.close();
    const late = await pending;
    expect(first.status).toBe(200);
    expect(late.status).toBe(403);
    const auth = await import("@/lib/auth");
    expect(await auth.verifyCredentials("first", "first-password")).toBe(true);
    expect(await auth.verifyCredentials("late", "late-password")).toBe(false);
  });

  it.each([null, [], 1, "text"])("拒绝非对象 JSON 根值 %j", async (body) => {
    const route = await import("@/app/api/auth/init/route");
    expect((await route.POST(jsonRequest("/api/auth/init", body))).status).toBe(400);
  });
  it("首次初始化成功并直接下发会话 cookie", async () => {
    const route = await import("@/app/api/auth/init/route");
    const response = await route.POST(jsonRequest("/api/auth/init", { username: "admin", password: "secret123" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, reinitialized: false });

    const { resolveSession } = await import("@/lib/auth");
    expect(resolveSession(sessionCookieOf(response))).not.toBeNull();
  });

  it("未初始化时也拒绝远程 Host，回环请求仍可完成初始化", async () => {
    const route = await import("@/app/api/auth/init/route");
    const remote = await route.POST(
      jsonRequest("/api/auth/init", { username: "remote", password: "remote-pass" }, { host: "resume.example.com" }),
    );
    expect(remote.status).toBe(403);
    const local = await route.POST(jsonRequest("/api/auth/init", { username: "admin", password: "secret123" }));
    expect(local.status).toBe(200);
  });

  it("已初始化且未开启逃生门时拒绝重复初始化", async () => {
    const route = await import("@/app/api/auth/init/route");
    await route.POST(jsonRequest("/api/auth/init", { username: "admin", password: "secret123" }));
    const response = await route.POST(jsonRequest("/api/auth/init", { username: "hacker", password: "hacked99" }));
    expect(response.status).toBe(403);
  });

  it("开启逃生门后允许重新初始化，其他数据不受影响", async () => {
    db.exec("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '保留的简历', '', '')");
    const route = await import("@/app/api/auth/init/route");
    await route.POST(jsonRequest("/api/auth/init", { username: "admin", password: "secret123" }));
    vi.stubEnv("RESUME_LIFE_AUTH_REINIT", "true");

    const response = await route.POST(jsonRequest("/api/auth/init", { username: "root", password: "fresh123456" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, reinitialized: true });
    expect(process.env.RESUME_LIFE_AUTH_REINIT).toBeUndefined();
    const { verifyCredentials } = await import("@/lib/auth");
    expect(await verifyCredentials("root", "fresh123456")).toBe(true);
    expect(db.prepare("SELECT title FROM resumes").all()).toEqual([{ title: "保留的简历" }]);
    // 重新初始化会清空旧会话，响应里的新 cookie 是唯一有效凭证
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: 1 });
  });

  it("逃生门只接受回环 Host，远程请求不能重置现有凭证", async () => {
    const route = await import("@/app/api/auth/init/route");
    await route.POST(jsonRequest("/api/auth/init", { username: "admin", password: "secret123" }));
    vi.stubEnv("RESUME_LIFE_AUTH_REINIT", "true");

    const response = await route.POST(
      jsonRequest("/api/auth/init", { username: "remote", password: "remote-pass" }, { host: "resume.example.com" }),
    );

    expect(response.status).toBe(403);
    const { verifyCredentials } = await import("@/lib/auth");
    expect(await verifyCredentials("admin", "secret123")).toBe(true);
    expect(await verifyCredentials("remote", "remote-pass")).toBe(false);
  });

  it("凭证不合法返回 400，请求体非 JSON 返回对应错误", async () => {
    const route = await import("@/app/api/auth/init/route");
    const short = await route.POST(jsonRequest("/api/auth/init", { username: "admin", password: "12345" }));
    expect(short.status).toBe(400);
    const badType = await route.POST(jsonRequest("/api/auth/init", { username: 1, password: "secret123" }));
    expect(badType.status).toBe(400);
    const notJson = await new Request("http://127.0.0.1:3000/api/auth/init", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    expect((await route.POST(notJson)).status).toBe(415);
  });
});

describe("POST /api/auth/login", () => {
  it("凭证重置后不会为在途的旧登录签发新会话", async () => {
    const auth = await import("@/lib/auth");
    auth.initializeCredentials("admin", "old-password");
    const route = await import("@/app/api/auth/login/route");
    const pending = route.POST(jsonRequest("/api/auth/login", { username: "admin", password: "old-password" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.stubEnv("RESUME_LIFE_AUTH_REINIT", "true");
    auth.initializeCredentials("admin", "new-password");
    const response = await pending;
    expect(response.status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: 0 });
  });
  it("连续失败登录会被限速，等待窗口结束后可恢复", async () => {
    const auth = await import("@/lib/auth");
    auth.initializeCredentials("admin", "secret123");
    const route = await import("@/app/api/auth/login/route");
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await route.POST(jsonRequest("/api/auth/login", { username: "admin", password: "wrong-password" }))).status).toBe(401);
    }
    const blocked = await route.POST(jsonRequest("/api/auth/login", { username: "admin", password: "secret123" }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    expect((await route.POST(jsonRequest("/api/auth/login", { username: "admin", password: "secret123" }))).status).toBe(200);
  });

  it("过长密码在执行派生前返回 400", async () => {
    const auth = await import("@/lib/auth");
    auth.initializeCredentials("admin", "secret123");
    const route = await import("@/app/api/auth/login/route");
    expect((await route.POST(jsonRequest("/api/auth/login", { username: "admin", password: "p".repeat(129) }))).status).toBe(400);
  });
  it.each([null, [], 1, "text"])("拒绝非对象 JSON 根值 %j", async (body) => {
    const route = await import("@/app/api/auth/login/route");
    await import("@/lib/auth").then((auth) => auth.initializeCredentials("admin", "secret123"));
    expect((await route.POST(jsonRequest("/api/auth/login", body))).status).toBe(400);
  });
  it("未初始化时拒绝登录", async () => {
    const route = await import("@/app/api/auth/login/route");
    expect((await route.POST(jsonRequest("/api/auth/login", { username: "admin", password: "secret123" }))).status).toBe(400);
  });

  it("凭证错误返回 401，正确则下发会话", async () => {
    const route = await import("@/app/api/auth/login/route");
    await import("@/lib/auth").then((auth) => auth.initializeCredentials("admin", "secret123"));

    const wrong = await route.POST(jsonRequest("/api/auth/login", { username: "admin", password: "wrong-pass" }));
    expect(wrong.status).toBe(401);

    const ok = await route.POST(jsonRequest("/api/auth/login", { username: "admin", password: "secret123" }));
    expect(ok.status).toBe(200);
    const { resolveSession } = await import("@/lib/auth");
    expect(resolveSession(sessionCookieOf(ok))).not.toBeNull();
  });
});

describe("POST /api/auth/logout", () => {
  it("撤销服务端会话并下发清空 cookie", async () => {
    const initRoute = await import("@/app/api/auth/init/route");
    const logoutRoute = await import("@/app/api/auth/logout/route");
    const token = sessionCookieOf(await initRoute.POST(jsonRequest("/api/auth/init", { username: "admin", password: "secret123" })));

    const response = await logoutRoute.POST(
      jsonRequest("/api/auth/logout", undefined, { cookie: `resume_life_session=${token}` }),
    );

    expect(response.status).toBe(200);
    expect((response.headers.get("set-cookie") ?? "")).toMatch(/resume_life_session=;/);
    const { resolveSession } = await import("@/lib/auth");
    expect(resolveSession(token)).toBeNull();
  });

  it("没有会话时也幂等地返回 200", async () => {
    const logoutRoute = await import("@/app/api/auth/logout/route");
    expect((await logoutRoute.POST(jsonRequest("/api/auth/logout"))).status).toBe(200);
  });

  it("撤销写入失败返回 500，保留失败事实；重试成功后旧令牌失效", async () => {
    const initRoute = await import("@/app/api/auth/init/route");
    const logoutRoute = await import("@/app/api/auth/logout/route");
    const { resolveSession } = await import("@/lib/auth");
    const token = sessionCookieOf(await initRoute.POST(jsonRequest("/api/auth/init", { username: "admin", password: "secret123" })));
    db.exec("CREATE TRIGGER fail_logout BEFORE DELETE ON auth_sessions BEGIN SELECT RAISE(ABORT, 'temporary logout failure'); END");
    const failed = await logoutRoute.POST(jsonRequest("/api/auth/logout", {}, { cookie: `resume_life_session=${token}` }));
    expect(failed.status).toBe(500);
    expect(failed.headers.get("set-cookie")).toBeNull();
    expect(resolveSession(token)).not.toBeNull();

    db.exec("DROP TRIGGER fail_logout");
    const retried = await logoutRoute.POST(jsonRequest("/api/auth/logout", {}, { cookie: `resume_life_session=${token}` }));
    expect(retried.status).toBe(200);
    expect(retried.headers.get("set-cookie")).toMatch(/resume_life_session=;/);
    expect(resolveSession(token)).toBeNull();
  });

  it("过期会话仍可成功清理浏览器 cookie", async () => {
    const initRoute = await import("@/app/api/auth/init/route");
    const logoutRoute = await import("@/app/api/auth/logout/route");
    const token = sessionCookieOf(await initRoute.POST(jsonRequest("/api/auth/init", { username: "admin", password: "secret123" })));
    db.prepare("UPDATE auth_sessions SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    const response = await logoutRoute.POST(jsonRequest("/api/auth/logout", {}, { cookie: `resume_life_session=${token}` }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/resume_life_session=;/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: 0 });
  });
});
