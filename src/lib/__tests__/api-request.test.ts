import { describe, expect, it } from "vitest";
import { parseApiJson } from "../api-request";
import { MAX_JSON_REQUEST_BYTES } from "../request-limits";

function jsonRequest(body?: BodyInit | null, headers: HeadersInit = {}) {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    body,
  });
}

describe("parseApiJson", () => {
  it("解析带 charset 的 JSON 请求", async () => {
    const result = await parseApiJson<{ name: string }>(jsonRequest('{"name":"项目"}'));

    expect(result).toEqual({ ok: true, data: { name: "项目" } });
  });

  it.each([undefined, "text/plain", "application/x-www-form-urlencoded"])(
    "拒绝非 JSON 媒体类型：%s",
    async (contentType) => {
      const headers = new Headers();
      if (contentType) headers.set("Content-Type", contentType);
      const result = await parseApiJson(new Request("http://localhost/api/test", {
        method: "POST",
        headers,
        body: "{}",
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(415);
    },
  );

  it("将畸形 JSON 映射为 400", async () => {
    const result = await parseApiJson(jsonRequest("{broken"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it("在读取前拒绝声明超限的请求", async () => {
    const result = await parseApiJson(jsonRequest("{}", {
      "Content-Length": String(MAX_JSON_REQUEST_BYTES + 1),
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("拒绝没有 Content-Length 的实际超限流", async () => {
    const bytes = new Uint8Array(MAX_JSON_REQUEST_BYTES + 1).fill(32);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const result = await parseApiJson(request);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("在显式允许时把空请求映射为给定值", async () => {
    const result = await parseApiJson<Record<string, unknown>>(jsonRequest(undefined), {
      allowEmpty: true,
      emptyValue: {},
    });

    expect(result).toEqual({ ok: true, data: {} });
  });
});
