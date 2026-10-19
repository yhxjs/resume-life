import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { validateMutationOrigin } from "../api-origin";
import { config, proxy } from "../../proxy";

afterEach(() => vi.unstubAllEnvs());

it("非本机 Host 一律 403；本机未登录访问页面重定向到登录页（无 cookie 时不触数据库）", () => {
  expect(config.matcher).toEqual(["/((?!_next/|favicon.ico|logo.png|icon.png).*)"]);
  expect(proxy(new NextRequest("http://attacker.invalid/")).status).toBe(403);
  const loopback = proxy(new NextRequest("http://127.0.0.1:3000/"));
  expect(loopback.status).toBe(307);
  expect(loopback.headers.get("location")).toBe("http://localhost:3000/login");
});

describe("validateMutationOrigin", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("拒绝跨站 %s 请求", (method) => {
    const request = new Request("http://127.0.0.1:3000/api/projects", {
      method,
      headers: { Origin: "https://attacker.invalid" },
    });

    expect(validateMutationOrigin(request)).toEqual({ ok: false, status: 403 });
  });

  it("拒绝不透明来源的写请求", () => {
    const request = new Request("http://127.0.0.1:3000/api/projects", {
      method: "POST",
      headers: { Origin: "null" },
    });

    expect(validateMutationOrigin(request)).toEqual({ ok: false, status: 403 });
  });

  it("允许同源写请求", () => {
    const request = new Request("http://127.0.0.1:3000/api/projects", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:3000" },
    });

    expect(validateMutationOrigin(request)).toEqual({ ok: true });
  });

  it("按公开 Host 判断 Next 生产代理中的同源写请求", () => {
    const request = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:3319",
        Origin: "http://127.0.0.1:3319",
      },
    });

    expect(validateMutationOrigin(request)).toEqual({ ok: true });
  });

  it("DNS rebinding：Origin 与 Host 同为攻击者域名时拒绝", () => {
    const request = new Request("http://evil.com:3000/api/resumes", {
      method: "POST",
      headers: { Host: "evil.com:3000", Origin: "http://evil.com:3000" },
    });

    expect(validateMutationOrigin(request)).toEqual({ ok: false, status: 403 });
  });

  it("伪造 X-Forwarded-Host 不能绕过白名单", () => {
    const request = new Request("http://evil.com:3000/api/resumes", {
      method: "POST",
      headers: {
        Host: "evil.com:3000",
        Origin: "http://evil.com:3000",
        "X-Forwarded-Host": "127.0.0.1:3000",
      },
    });

    expect(validateMutationOrigin(request)).toEqual({ ok: false, status: 403 });
  });

  it("显式配置的对外主机名在反向代理下放行", () => {
    vi.stubEnv("RESUME_LIFE_ALLOWED_HOSTS", "resume.example.com");
    const request = new Request("http://127.0.0.1:3000/api/projects", {
      method: "POST",
      headers: { Host: "resume.example.com", Origin: "https://resume.example.com" },
    });

    expect(validateMutationOrigin(request)).toEqual({ ok: true });
  });

  it("未配置的对外主机名默认拒绝", () => {
    const request = new Request("http://127.0.0.1:3000/api/projects", {
      method: "POST",
      headers: { Host: "resume.example.com", Origin: "https://resume.example.com" },
    });

    expect(validateMutationOrigin(request)).toEqual({ ok: false, status: 403 });
  });

  it("X-Forwarded-Host 与来源不符时不回退到 Host", () => {
    const request = new Request("https://resume.example.com/api/projects", {
      method: "POST",
      headers: {
        Host: "resume.example.com",
        Origin: "https://resume.example.com",
        "X-Forwarded-Host": "attacker.invalid",
      },
    });

    expect(validateMutationOrigin(request)).toEqual({ ok: false, status: 403 });
  });

  it("允许没有 Origin 的本地脚本", () => {
    const request = new Request("http://127.0.0.1:3000/api/projects", { method: "POST" });

    expect(validateMutationOrigin(request)).toEqual({ ok: true });
  });

  it("只读请求同样校验 Host 白名单", () => {
    const request = new Request("http://evil.com:3000/api/resumes", {
      headers: { Host: "evil.com:3000" },
    });

    expect(validateMutationOrigin(request)).toEqual({ ok: false, status: 403 });
  });

  it("只读请求允许回环 Host", () => {
    const request = new Request("http://127.0.0.1:3000/api/resumes", {
      headers: { Host: "127.0.0.1:3000" },
    });

    expect(validateMutationOrigin(request)).toEqual({ ok: true });
  });

  it("局域网地址默认拒绝", () => {
    const request = new Request("http://192.168.1.5:3000/api/resumes", {
      headers: { Host: "192.168.1.5:3000" },
    });

    expect(validateMutationOrigin(request)).toEqual({ ok: false, status: 403 });
  });
});

describe("RESUME_LIFE_ALLOWED_HOSTS 条目归一化", () => {
  const requestFor = (host: string) =>
    new Request(`http://${host}/api/resumes`, { headers: { Host: host } });

  it.each([
    ["裸域名", "resume.example.com"],
    ["带端口的写法", "resume.example.com:8443"],
    ["带协议的写法", "https://resume.example.com"],
  ])("%s 都能匹配剥出主机名后的 Host", (_label, entry) => {
    // 而请求侧比较的是 hostnameOf() 剥出的裸主机名，于是永远匹配不上：
    // 现象是「域名明明配了，整个应用还是全站 403」，与「忘记配置」无法区分。
    vi.stubEnv("RESUME_LIFE_ALLOWED_HOSTS", entry);
    expect(validateMutationOrigin(requestFor("resume.example.com"))).toEqual({ ok: true });
  });

  it("带协议的条目不会把协议当成主机名放行", () => {
    vi.stubEnv("RESUME_LIFE_ALLOWED_HOSTS", "https://resume.example.com");
    // new URL("http://https://…").hostname 会解析出 "https"；若不先剥协议，
    // 白名单里就会混进一个永不匹配的 "https"，同时掩盖掉真正的解析失败。
    expect(validateMutationOrigin(requestFor("https"))).toEqual({ ok: false, status: 403 });
  });

  it("无法解析的条目被丢弃并记一条 warn，其余条目照常生效", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("RESUME_LIFE_ALLOWED_HOSTS", "bad host, resume.example.com");

    expect(validateMutationOrigin(requestFor("resume.example.com"))).toEqual({ ok: true });
    expect(warn.mock.calls.flat().join(" ")).toContain("origin.allowedHosts");
  });
});
