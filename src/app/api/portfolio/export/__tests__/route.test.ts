import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PortfolioError } from "@/lib/portfolio";
import { MAX_JSON_REQUEST_BYTES } from "@/lib/request-limits";
import { POST } from "../route";

const mocks = vi.hoisted(() => ({
  assemble: vi.fn(),
  anonymize: vi.fn(),
  zip: vi.fn(),
}));

vi.mock("@/lib/portfolio", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/portfolio")>(),
  assemblePortfolioData: mocks.assemble,
}));
vi.mock("@/lib/portfolio-anonymize", () => ({ processPortfolioAnonymization: mocks.anonymize }));
vi.mock("@/lib/portfolio-generator", () => ({ createPortfolioZip: mocks.zip }));

function request(body: string, headers: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1/api/portfolio/export", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.assemble.mockReturnValue({ siteTitle: "演示作品集" });
  mocks.anonymize.mockReturnValue({ candidateName: "演示候选人" });
  mocks.zip.mockResolvedValue(Buffer.from("demo-zip"));
});

afterEach(() => vi.restoreAllMocks());

describe("POST /api/portfolio/export 请求与错误边界", () => {
  it("畸形 JSON 返回 400 且不进入领域模块", async () => {
    const response = await POST(request("{"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "请求体必须是有效 JSON" });
    expect(mocks.assemble).not.toHaveBeenCalled();
  });

  it("错误 Content-Type 返回 415", async () => {
    const response = await POST(request("{}", { "content-type": "text/plain" }));
    expect(response.status).toBe(415);
    expect(mocks.assemble).not.toHaveBeenCalled();
  });

  it("缺少 Content-Type 返回 415", async () => {
    const input = request("{}");
    input.headers.delete("content-type");
    expect((await POST(input)).status).toBe(415);
    expect(mocks.assemble).not.toHaveBeenCalled();
  });

  it("声明超过 1 MiB 的请求返回 413", async () => {
    const response = await POST(request("{}", { "content-length": String(MAX_JSON_REQUEST_BYTES + 1) }));
    expect(response.status).toBe(413);
    expect(mocks.assemble).not.toHaveBeenCalled();
  });

  it("无 Content-Length 的超大正文同样返回 413", async () => {
    const response = await POST(request(JSON.stringify({ text: "x".repeat(MAX_JSON_REQUEST_BYTES) })));
    expect(response.status).toBe(413);
    expect(mocks.assemble).not.toHaveBeenCalled();
  });

  it.each(["null", "[]", '"demo"', "1"])("无效 JSON 结构 %s 返回 400", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "请求体格式无效" });
    expect(mocks.assemble).not.toHaveBeenCalled();
  });

  it.each([400, 404])("保留 PortfolioError 的 %i 状态码", async (status) => {
    mocks.assemble.mockImplementation(() => { throw new PortfolioError("演示领域错误", status); });
    const response = await POST(request('{"resumeId":1}'));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "演示领域错误" });
  });

  it("未知异常返回统一 500 和关联 requestId，不泄漏异常内容", async () => {
    mocks.zip.mockRejectedValue(new Error("private-details-must-not-leak"));
    const response = await POST(request('{"resumeId":1}', { "x-request-id": "portfolio-export-test" }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "服务器内部错误，请稍后重试", requestId: "portfolio-export-test" });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"requestId":"portfolio-export-test"'));
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("private-details-must-not-leak"));
  });

  it("成功返回脱敏后的 ZIP 字节和下载头", async () => {
    const response = await POST(request('{"resumeId":1,"selectedProjects":[]}'));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain(encodeURIComponent("演示候选人"));
    expect(response.headers.get("content-length")).toBe("8");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("demo-zip");
    expect(mocks.zip).toHaveBeenCalledWith(mocks.anonymize.mock.results[0]?.value, expect.any(AbortSignal));
  });

  it("取消的请求返回 499 且不读取业务数据", async () => {
    const controller = new AbortController();
    controller.abort();
    const input = new Request("http://127.0.0.1/api/portfolio/export", { method: "POST", signal: controller.signal, body: "{}" });
    expect((await POST(input)).status).toBe(499);
    expect(mocks.assemble).not.toHaveBeenCalled();
    expect(mocks.zip).not.toHaveBeenCalled();
  });

  it("最多同时打包两份，取消后等待实际结束才释放名额", async () => {
    let release!: (value: Buffer) => void;
    const pending = new Promise<Buffer>((resolve) => { release = resolve; });
    mocks.zip.mockReturnValue(pending);
    const controller = new AbortController();
    const input = new Request("http://127.0.0.1/api/portfolio/export", { method: "POST", headers: { "content-type": "application/json" }, body: '{"resumeId":1}', signal: controller.signal });
    const first = POST(input);
    const second = POST(request('{"resumeId":1}'));
    await vi.waitFor(() => expect(mocks.zip).toHaveBeenCalledTimes(2));
    controller.abort();
    const busy = await POST(request('{"resumeId":1}'));
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("1");
    release(Buffer.from("zip"));
    expect((await first).status).toBe(499);
    expect((await second).status).toBe(200);
    mocks.zip.mockResolvedValue(Buffer.from("zip"));
    expect((await POST(request('{"resumeId":1}'))).status).toBe(200);
  });

  it("压缩异常后释放名额，后续请求仍可打包", async () => {
    mocks.zip.mockRejectedValueOnce(new Error("compress failed"));
    expect((await POST(request('{"resumeId":1}'))).status).toBe(500);
    expect((await POST(request('{"resumeId":1}'))).status).toBe(200);
  });
});
