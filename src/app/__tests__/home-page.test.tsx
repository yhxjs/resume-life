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
  vi.mocked(getDatabaseStats).mockReturnValue({
    resumes: 2, projects: 1, interviews: 1, drills: 1,
    bank_entries: 0, notebook_entries: 0, intros: 0, templates: 0,
    totalRecords: 5, hasAiConfig: false, dbVersion: 1,
  });
  vi.mocked(getApplicationStats).mockReturnValue({
    counts: { interested: 0, applied: 2, interviewing: 1, interview: 1, reviewing: 0, offer: 0, rejected: 0 },
    totalActive: 3, upcomingInterviews: [],
    rates: { appliedRate: 100, interviewRate: 33, offerRate: 0 },
  });
  vi.mocked(getOverallScore).mockReturnValue(null);
  vi.mocked(resolveSession).mockReturnValue({ tokenHash: "hash", expiresAt: "2099-01-01T00:00:00.000Z" });
});

describe("首页行为", () => {
  it("会话无效时不渲染任何数据，重定向到登录页", async () => {
    vi.mocked(resolveSession).mockReturnValueOnce(null);
    await expect(HomePage()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(vi.mocked(getDatabaseStats)).not.toHaveBeenCalled();
  });

  it("统计读取失败时仍渲染排障提示，不将未知数量显示为零", async () => {
    vi.mocked(getDatabaseStats).mockImplementation(() => { throw new Error("database offline"); });
    vi.mocked(getApplicationStats).mockImplementation(() => { throw new Error("database offline"); });

    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain("统计数据暂不可用");
    expect(html).toContain("不可用项显示为“—”");
    expect(html).not.toContain("0 份已存");
    expect(html).toContain("查看简历");
    expect(html).not.toContain("database offline");
  });

  it.each([false, true])("没有评分与 AI 配置 %s 无关，不误称等待整场模考结束", async hasAiConfig => {
    vi.mocked(getDatabaseStats).mockReturnValue({ ...getDatabaseStats(), hasAiConfig });
    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain("暂无评分");
    expect(html).toContain("练习或模考评分后显示");
    expect(html).not.toContain("准备就绪");
    expect(html).not.toContain("完成首次模考");
    expect(html).not.toContain("统计数据暂不可用");
  });

  it("真实零分显示 0.0，历史均分不被表述为胜率或录用评级", async () => {
    vi.mocked(getOverallScore).mockReturnValue(0);
    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain(">0.0</span>");
    expect(html).toContain("历史四维均分");
    expect(html).not.toContain("胜率");
    expect(html).not.toContain("综合评级");
    expect(html).not.toContain("暂无评分");
  });

  it("读取成功的零记录仍显示真实零数量，不显示未知占位或异常提示", async () => {
    vi.mocked(getDatabaseStats).mockReturnValue({ ...getDatabaseStats(), resumes: 0, interviews: 0, drills: 0 });
    vi.mocked(getApplicationStats).mockReturnValue({ ...getApplicationStats(), totalActive: 0 });
    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain("0 份已存");
    expect(html).toContain("0 场模考 · 0 组练习");
    expect(html).toContain("暂无评分");
    expect(html).not.toContain("统计数据暂不可用");
    expect(html).not.toContain(">—</span>");
  });

  it("只有评分读取失败时保留其他统计，不冒充无评分且不泄露内部错误", async () => {
    vi.mocked(getOverallScore).mockImplementation(() => { throw new Error("private database path"); });
    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain("统计数据暂不可用");
    expect(html).toContain("评分读取失败，请刷新重试");
    expect(html).toContain("2 份已存");
    expect(html).toContain("3 条推进中");
    expect(html).not.toContain("暂无评分");
    expect(html).not.toContain("private database path");
  });

  it.each(["database", "applications"])("%s 读取失败只隐藏所属统计，其他真实值继续显示", async kind => {
    vi.mocked(getOverallScore).mockReturnValue(7.8);
    const fail = () => { throw new Error("private database path"); };
    if (kind === "database") vi.mocked(getDatabaseStats).mockImplementation(fail);
    else vi.mocked(getApplicationStats).mockImplementation(fail);
    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain("统计数据暂不可用");
    expect(html).toContain(">7.8</span>");
    expect(html).toContain(kind === "database" ? "简历统计读取失败" : "投递统计读取失败");
    expect(html).toContain(kind === "database" ? "3 条推进中" : "2 份已存");
    expect(html).not.toContain(kind === "database" ? "0 份已存" : "0 条推进中");
    expect(html).not.toContain("private database path");
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
