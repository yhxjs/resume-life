import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getDatabaseStats } from "@/lib/backup";
import { getApplicationStats } from "@/lib/applications";
import { getOverallScore } from "@/lib/overall-score";
import { resolveSession } from "@/lib/auth";
import HomePage from "../page";

vi.mock("@/lib/backup", () => ({ getDatabaseStats: vi.fn() }));
vi.mock("@/lib/applications", () => ({ getApplicationStats: vi.fn() }));
vi.mock("@/lib/overall-score", () => ({ getOverallScore: vi.fn() }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE_NAME: "resume_life_session", resolveSession: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
}) }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({
  get: (name: string) => name === "resume_life_session" ? { name, value: "test-token" } : undefined,
})) }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getOverallScore).mockReturnValue(null);
  vi.mocked(resolveSession).mockReturnValue({ tokenHash: "hash", expiresAt: "2099-01-01T00:00:00.000Z" });
});

describe("首页行为", () => {
  it("会话无效时不渲染任何数据，重定向到登录页", async () => {
    vi.mocked(resolveSession).mockReturnValueOnce(null);
    await expect(HomePage()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(vi.mocked(getDatabaseStats)).not.toHaveBeenCalled();
  });

  it("统计读取失败时仍渲染排障提示与安全的空数据", async () => {
    vi.mocked(getDatabaseStats).mockImplementation(() => { throw new Error("database offline"); });
    vi.mocked(getApplicationStats).mockImplementation(() => { throw new Error("database offline"); });

    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain("统计数据暂不可用");
    expect(html).toContain("数据库可能未就绪或初始化失败");
    expect(html).toContain("0 份已存");
    expect(html).not.toContain("database offline");
  });

  it("数据库可用时呈现真实统计且不显示降级提示", async () => {
    vi.mocked(getDatabaseStats).mockReturnValue({
      resumes: 2, projects: 1, interviews: 1, drills: 1,
      bank_entries: 0, notebook_entries: 0, intros: 0, templates: 0,
      totalRecords: 5, hasAiConfig: false, dbVersion: 1,
    });
    vi.mocked(getApplicationStats).mockReturnValue({
      counts: { interested: 0, applied: 0, interviewing: 0, interview: 0, reviewing: 0, offer: 0, rejected: 0 },
      totalActive: 0, upcomingInterviews: [],
      rates: { appliedRate: 0, interviewRate: 0, offerRate: 0 },
    });

    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain("2 份已存");
    expect(html).not.toContain("统计数据暂不可用");
  });
});
