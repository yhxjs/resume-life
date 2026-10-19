import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { NextRequest } from "next/server";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-proxy-auth-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-proxy-auth-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const COOKIE_NAME = "resume_life_session";

function requestFor(url: string, token?: string): NextRequest {
  return new NextRequest(url, token ? { headers: { cookie: `${COOKIE_NAME}=${token}` } } : {});
}

function isNextCall(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

describe("proxy 网络层职责", () => {
  it("未携带会话 cookie 的页面访问重定向到 /login，并保留回跳路径与查询串", async () => {
    const { proxy } = await import("../../proxy");
    const root = proxy(requestFor("http://localhost:3000/"));
    expect(root.status).toBe(307);
    expect(root.headers.get("location")).toBe("http://localhost:3000/login");

    const deep = proxy(requestFor("http://localhost:3000/resumes?page=2"));
    expect(deep.status).toBe(307);
    expect(deep.headers.get("location")).toBe("http://localhost:3000/login?next=%2Fresumes%3Fpage%3D2");
  });

  it("携带会话 cookie（即使可能已过期）的页面访问透传，真实校验交给路由包装器", async () => {
    const { proxy } = await import("../../proxy");
    expect(isNextCall(proxy(requestFor("http://localhost:3000/resumes", "any-token-value")))).toBe(true);
  });

  it("API 请求全部透传，会话鉴权由路由统一包装器负责", async () => {
    const { proxy } = await import("../../proxy");
    expect(isNextCall(proxy(requestFor("http://localhost:3000/api/applications")))).toBe(true);
    expect(isNextCall(proxy(requestFor("http://localhost:3000/api/auth/status")))).toBe(true);
    expect(isNextCall(proxy(requestFor("http://localhost:3000/api/health")))).toBe(true);
  });

  it("/login 页面公开透传", async () => {
    const { proxy } = await import("../../proxy");
    expect(isNextCall(proxy(requestFor("http://localhost:3000/login")))).toBe(true);
  });

  it("uploads 路径维持 404 封禁", async () => {
    const { proxy } = await import("../../proxy");
    expect(proxy(requestFor("http://localhost:3000/uploads/avatar.png")).status).toBe(404);
  });

  it("Host 白名单校验先于页面重定向", async () => {
    const { proxy } = await import("../../proxy");
    expect(proxy(requestFor("http://evil.com:3000/resumes")).status).toBe(403);
  });

  it("middleware 产物不引入数据库模块：proxy 只依赖网络层与纯常量", async () => {
    const proxySource = fs.readFileSync("src/proxy.ts", "utf8");
    expect(proxySource).not.toMatch(/from "\.\/db"|from "@\/lib\/db"|from "\.\/auth"|from "@\/lib\/auth"/);
  });
});
