import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settingsState = vi.hoisted(() => ({ writeSettings: vi.fn() }));
vi.mock("../settings", () => ({
  API_KEY_MASK_PREFIX: "masked_",
  SETTINGS_FIELDS: ["base_url", "api_key", "api_format", "model_parse", "model_summary", "model_question", "model_evaluate"],
  maskApiKey: (value: string) => value ? `masked_${value.slice(-4)}` : "",
  resolveIncomingApiKey: (incoming: string, saved: string) => incoming.startsWith("masked_") ? saved : incoming,
  readSettings: () => ({ base_url: "https://model.invalid/v1", api_key: "synthetic", model_parse: "fake", api_format: "openai_chat" }),
  writeSettings: settingsState.writeSettings,
}));
import { PUT as saveSettings } from "../../app/api/settings/route";
import { POST as models } from "../../app/api/settings/models/route";
import { POST as testModel } from "../../app/api/settings/test/route";
import { assertTrustedSettingsRequest } from "../settings-request";

const upstream = vi.fn();
beforeEach(() => {
  upstream.mockReset();
  settingsState.writeSettings.mockReset();
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("反向代理下按显式配置的对外主机名接受同源请求", () => {
  vi.stubEnv("RESUME_LIFE_ALLOWED_HOSTS", "resume.example.com");
  const request = new Request("http://127.0.0.1:3000/settings", {
    method: "POST",
    headers: {
      Host: "resume.example.com",
      Origin: "https://resume.example.com",
    },
  });

  expect(() => assertTrustedSettingsRequest(request)).not.toThrow();
});

it("仅伪造 X-Forwarded-Host 不能通过设置请求校验", () => {
  const request = new Request("http://127.0.0.1:3000/settings", {
    method: "POST",
    headers: {
      Host: "127.0.0.1:3000",
      Origin: "https://resume.example.com",
      "X-Forwarded-Host": "resume.example.com",
    },
  });

  expect(() => assertTrustedSettingsRequest(request)).toThrow();
});

describe.each([{ name: "models", route: models }, { name: "test", route: testModel }])("settings/$name request validation", ({ route }) => {
  const request = (body?: string, headers: Record<string, string> = {}) => new Request("http://localhost/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });

  it("拒绝公网 HTTP 网关而保留本地回环 HTTP", async () => {
    expect((await route(request(JSON.stringify({ base_url: "http://public.example/v1", api_key: "fresh" })))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    upstream.mockResolvedValueOnce(Response.json({ data: [{ id: "local" }], choices: [{ message: { content: "ok" } }] }));
    expect((await route(request(JSON.stringify({ base_url: "http://127.0.0.1:12345/v1", api_key: "fresh" })))).status).toBe(200);
  });

  it("不自动跟随模型网关重定向", async () => {
    upstream.mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: "https://attacker.invalid/" } }));
    const response = await route(request("{}"));
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
    expect((await response.json()).ok).toBe(false);
  });

  it.each([null, [], 7, "text", { base_url: 42 }, { api_key: null }, { model: [] }, { api_format: 7 }, { api_format: "unsupported" }, { base_url: "file:///tmp/test" }, { base_url: "not a URL" }])("rejects invalid input without an upstream request: %j", async (body) => {
    const response = await route(request(JSON.stringify(body)));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON instead of silently using saved settings", async () => {
    const response = await route(request("{broken"));
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "{}"])("allows an empty request to reuse saved settings: %s", async (body) => {
    upstream.mockImplementation(async () => Response.json({ data: [{ id: "fake" }], choices: [{ message: { content: "ok" } }] }));
    const response = await route(request(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0]![0]).toMatch(/^https:\/\/model.invalid\/v1\//);
  });

  it.each([
    { headers: { Origin: "https://attacker.invalid" }, contentType: "application/json", status: 400 },
    { headers: { Origin: "null" }, contentType: "application/json", status: 400 },
    { headers: {}, contentType: "text/plain", status: 415 },
    { headers: {}, contentType: "application/x-www-form-urlencoded", status: 415 },
  ])("rejects untrusted browser boundary before fetch: %j", async ({ headers, contentType, status }) => {
    const requestHeaders = new Headers();
    if (headers.Origin) requestHeaders.set("Origin", headers.Origin);
    requestHeaders.set("Content-Type", contentType);
    const response = await route(new Request("http://localhost/settings", {
      method: "POST",
      headers: requestHeaders,
      body: "{}",
    }));
    expect(response.status).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not reuse a saved key when the target service changes", async () => {
    const response = await route(request(JSON.stringify({ base_url: "https://other.invalid/v1", api_key: "masked_etic" })));
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("模型连通测试把上游 HTTP 错误映射为 502", async () => {
    if (route !== testModel) return;
    upstream.mockResolvedValueOnce(new Response("upstream failed", { status: 503 }));
    const response = await route(request("{}"));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, error: "HTTP 503" });
  });

  it("模型连通测试把超时映射为 504", async () => {
    if (route !== testModel) return;
    upstream.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    const response = await route(request("{}"));
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining("连接超时") });
  });

  it("上游 JSON 超过字节预算时取消响应流并返回错误", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1).fill(120)); },
      cancel,
    });
    upstream.mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "application/json" } }));

    const response = await route(request("{}"));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining("字节上限") });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("settings/models HTTP 错误合同", () => {
  it.each([401, 429, 500])("把上游 HTTP %i 映射为本地 502", async (upstreamStatus) => {
    upstream.mockResolvedValue(new Response("upstream failed", { status: upstreamStatus }));
    const response = await models(new Request("http://localhost/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("does not return an upstream response body", async () => {
    upstream.mockResolvedValue(new Response("SYNTHETIC_PRIVATE_MARKER", { status: 401 }));
    const response = await models(new Request("http://localhost/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }));
    expect(JSON.stringify(await response.json())).not.toContain("SYNTHETIC_PRIVATE_MARKER");
  });

  it("把模型列表请求超时映射为 504", async () => {
    upstream.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const response = await models(new Request("http://localhost/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
  });
});

const baseUrlCases = [
  { baseUrl: "https://model.invalid/v1", accepted: true },
  { baseUrl: "http://127.0.0.1:11434/v1", accepted: true },
  { baseUrl: "file:///tmp/model", accepted: false },
  { baseUrl: "ftp://model.invalid/v1", accepted: false },
  { baseUrl: "not a URL", accepted: false },
  { baseUrl: "https://synthetic-user@model.invalid/v1", accepted: false },
  { baseUrl: "https://synthetic-user:synthetic-pass@model.invalid/v1", accepted: false },
];

describe.each([
  { name: "settings PUT", route: saveSettings },
  { name: "settings/models", route: models },
  { name: "settings/test", route: testModel },
])("$name Base URL 协议合同", ({ name, route }) => {
  it.each(baseUrlCases)("校验 $baseUrl", async ({ baseUrl, accepted }) => {
    upstream.mockResolvedValue(Response.json({
      data: [{ id: "fake" }],
      choices: [{ message: { content: "ok" } }],
    }));
    const response = await route(new Request("http://localhost/settings", {
      method: name === "settings PUT" ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: "new-secret",
        api_format: "openai_chat",
        model: "fake",
      }),
    }));

    expect(response.status).toBe(accepted ? 200 : 400);
    if (!accepted) {
      expect(settingsState.writeSettings).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    }
  });
});
