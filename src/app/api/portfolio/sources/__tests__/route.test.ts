import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";

const { loadSources } = vi.hoisted(() => ({ loadSources: vi.fn() }));
vi.mock("@/lib/portfolio", () => ({ loadPortfolioSources: loadSources }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/portfolio/sources", () => {
  it("返回领域模块的数据源，不改变结构", async () => {
    const sources = { resumes: [{ id: 1, title: "演示简历", versions: [] }], projects: [] };
    loadSources.mockReturnValue(sources);
    const response = await GET(new Request("http://127.0.0.1/api/portfolio/sources"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(sources);
  });

  it("未知异常返回带 requestId 的统一 500，不泄漏领域错误", async () => {
    loadSources.mockImplementation(() => { throw new Error("private-source-data"); });
    const response = await GET(new Request("http://127.0.0.1/api/portfolio/sources", {
      headers: { "x-request-id": "portfolio-sources-test" },
    }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "服务器内部错误，请稍后重试", requestId: "portfolio-sources-test" });
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("private-source-data"));
  });
});
