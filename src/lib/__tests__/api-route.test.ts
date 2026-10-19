import { beforeEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => ({ calls: [] as { operation: string; requestId?: string }[] }));

vi.mock("../server-errors", async (original) => ({
  ...await original<typeof import("../server-errors")>(),
  logServerError: (operation: string, _error: unknown, options: { requestId?: string }) => {
    logged.calls.push({ operation, requestId: options.requestId });
    return "log-generated-id";
  },
  requestIdFrom: (request?: Request) => request?.headers.get("x-request-id") ?? "generated-from-request",
}));

import { withRouteErrorHandling } from "../api-route";
import { DataGenerationConflictError } from "../data-generation";

const CONTEXT = { params: Promise.resolve({}) };

beforeEach(() => { logged.calls.length = 0; });

describe("withRouteErrorHandling", () => {
  it("保留头像接口已有的 private, no-store 约定", async () => {
    const handler = withRouteErrorHandling("GET /api/uploads/demo", () => new Response("avatar", {
      headers: { "Cache-Control": "private, no-store" },
    }));
    expect((await handler(new Request("http://localhost/api/uploads/demo"))).headers.get("cache-control")).toBe("private, no-store");
  });

  it.each([200, 400, 404, 502])("HTTP %s 响应明确禁止缓存且保留响应正文", async (status) => {
    const handler = withRouteErrorHandling("GET /api/demo", () => new Response("private", {
      status, headers: { "Cache-Control": "public, max-age=3600" },
    }));
    const response = await handler(new Request("http://localhost/api/demo"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("private");
  });

  it("世代冲突响应也禁止缓存", async () => {
    const handler = withRouteErrorHandling("GET /api/demo", () => { throw new DataGenerationConflictError(); });
    const response = await handler(new Request("http://localhost/api/demo"));
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("SSE 禁止缓存并保留流正文和 cookie", async () => {
    const handler = withRouteErrorHandling("POST /api/demo", () => new Response("event: done\ndata: {}\n\n", {
      headers: { "Content-Type": "text/event-stream", "Set-Cookie": "synthetic=value; HttpOnly" },
    }));
    const response = await handler(new Request("http://localhost/api/demo"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("set-cookie")).toContain("synthetic=value");
    expect(await response.text()).toContain("event: done");
  });

  it("成功路径原样返回处理结果，不做任何包装", async () => {
    const response = new Response("ok", { status: 200 });
    const handler = withRouteErrorHandling("GET /api/demo", async () => response);

    await expect(handler(new Request("http://127.0.0.1:3000/api/demo"), CONTEXT)).resolves.toBe(response);
    expect(logged.calls).toEqual([]);
  });

  it("抛错时返回带 requestId 的 500，而不是让异常穿透成裸 500", async () => {
    const handler = withRouteErrorHandling("GET /api/demo", async () => {
      throw new Error("数据库炸了");
    });

    const response = await handler(new Request("http://127.0.0.1:3000/api/demo"), CONTEXT);

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "服务器内部错误，请稍后重试",
      requestId: "log-generated-id",
    });
    expect(logged.calls).toEqual([
      { operation: "GET /api/demo", requestId: "generated-from-request" },
    ]);
  });

  it("沿用请求带来的 x-request-id，便于客户端与服务端日志对齐", async () => {
    const handler = withRouteErrorHandling("POST /api/demo", async () => {
      throw new Error("上游挂了");
    });

    await handler(
      new Request("http://127.0.0.1:3000/api/demo", {
        method: "POST",
        headers: { "x-request-id": "client-trace-1" },
      }),
      CONTEXT
    );

    expect(logged.calls[0]!.requestId).toBe("client-trace-1");
  });

  it("把上下文透传给处理函数", async () => {
    const handler = withRouteErrorHandling<{ params: Promise<{ id: string }> }>(
      "PATCH /api/demo/[id]",
      async (_request, { params }) => new Response((await params).id)
    );

    const response = await handler(new Request("http://127.0.0.1:3000/api/demo/7"), {
      params: Promise.resolve({ id: "7" }),
    });

    await expect(response.text()).resolves.toBe("7");
  });
});
