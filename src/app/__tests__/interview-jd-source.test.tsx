// @vitest-environment jsdom
import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InterviewsPage from "../interviews/page";
import JdPortraitPage from "../tools/jd/[id]/page";
import { useInterviewsPage } from "@/hooks/use-interviews-page";
import { jsonFetch } from "@/lib/fetcher";
import { fetchSse } from "@/lib/fetch-sse";

const navigation = vi.hoisted(() => ({ query: new URLSearchParams(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.query,
  useParams: () => ({ id: "17" }),
  useRouter: () => ({ push: navigation.push }),
}));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
vi.mock("@/hooks/use-interviews-page", () => ({ useInterviewsPage: vi.fn() }));
vi.mock("@/hooks/use-typewriter", () => ({
  useTypewriter: () => ({ displayedText: "", isTyping: false, reset: vi.fn(), appendDelta: vi.fn(), flush: vi.fn() }),
}));
vi.mock("@/components/interviews/interview-history", () => ({ InterviewHistory: () => null }));
vi.mock("@/components/application/preparation-return-link", () => ({ PreparationReturnLink: () => null }));

const jd = `${"负责接口校验与联调。".repeat(160)}\nGo 或 Python 掌握一种即可；不要求架构选型；C++ & <SQL> 经验为加分项。`;
const portrait = { id: 17, jd, result: null, created_at: "2026-10-26" };
const jdLabel = "目标岗位要求（JD / 职位描述）";

beforeEach(() => {
  navigation.query = new URLSearchParams("portraitId=17");
  navigation.push.mockReset();
  vi.mocked(jsonFetch).mockReset().mockResolvedValue(portrait);
  vi.mocked(fetchSse).mockReset().mockResolvedValue(undefined);
  vi.mocked(useInterviewsPage).mockReset().mockReturnValue({
    resumes: [{ id: 4, title: "测试简历", updated_at: "", versions: [{ id: 41, version: 1, name: "发布版" }] }],
    resumesError: "", items: [], seriesItems: [], totalCount: 0, resumeId: 4, resumeVersionId: 41,
    keyword: "", loadError: "",
    reloadResumes: vi.fn(), retryLoad: vi.fn(), reloadHistory: vi.fn(),
    itemsHasMore: false, itemsLoadingMore: false, itemsLoadFailed: false, loadMoreItems: vi.fn(),
    seriesHasMore: false, seriesLoadingMore: false, seriesLoadFailed: false, loadMoreSeries: vi.fn(),
    setResumeId: vi.fn(), setResumeVersionId: vi.fn(), setKeyword: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined), removeSeries: vi.fn().mockResolvedValue(undefined),
    deletion: { busy: false, canStart: () => true,
      single: { phase: "idle", target: null, error: "", notice: "", deletedIds: new Set<number>(), busy: false, canStart: () => true, remove: vi.fn(), retryCheck: vi.fn() },
      series: { phase: "idle", target: null, error: "", notice: "", deletedIds: new Set<number>(), busy: false, canStart: () => true, remove: vi.fn(), retryCheck: vi.fn() },
    },
  });
});
afterEach(cleanup);

describe("JD 画像到模拟面试的完整材料", () => {
  it("画像表单提交到 DOM 后立即开场，不因尚未运行普通 effect 丢失点击", async () => {
    let clicked = false;
    render(<Profiler id="source-ready" onRender={() => {
      if (clicked) return;
      const button = screen.queryByRole("button", { name: "立即开启模拟实战" });
      if (!button) return;
      clicked = true;
      button.click();
    }}><InterviewsPage /></Profiler>);
    await screen.findByRole("textbox", { name: jdLabel });
    expect(clicked).toBe(true);
    expect(fetchSse).toHaveBeenCalledExactlyOnceWith("/api/interviews", expect.objectContaining({
      body: expect.objectContaining({ jd, mode: "single", resume_id: 4, resume_version_id: 41 }),
    }));
  });

  it("用画像 ID 跳转，完整 JD 不塞入 URL 或截成前 1000 字", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...portrait, result: {
      role: "测试岗位", mustSkills: [], followups: [], companyStyle: { style: "信息不足", signals: [] },
    } });
    render(<JdPortraitPage />);
    const link = await screen.findByRole("link", { name: "带着该 JD 开启模拟面试 →" });
    expect(link.getAttribute("href")).toBe("/interviews?portraitId=17");
  });

  it.each(["single", "series"])("%s 模式从画像读取完整 JD，包含末尾限定并原样提交", async (mode) => {
    render(<InterviewsPage />);
    const editor = await screen.findByRole("textbox", { name: jdLabel }) as HTMLTextAreaElement;
    expect(editor.value).toBe(jd);
    expect(editor.readOnly).toBe(false);
    expect(jsonFetch).toHaveBeenCalledWith("/api/tools/jd-portraits/17", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    if (mode === "series") fireEvent.click(screen.getByRole("button", { name: "进阶三轮连打" }));
    fireEvent.click(screen.getByRole("button", { name: mode === "single" ? "立即开启模拟实战" : "开启进阶三轮连打" }));
    await waitFor(() => expect(fetchSse).toHaveBeenCalledWith("/api/interviews", expect.objectContaining({
      body: expect.objectContaining({ jd, mode, resume_id: 4, resume_version_id: 41 }),
    })));
  });

  it("读取后允许修改 JD，提交使用用户确认的当前内容", async () => {
    render(<InterviewsPage />);
    const editor = await screen.findByRole("textbox", { name: jdLabel });
    const edited = `${jd}\n本次仅练习接口联调。`;
    fireEvent.change(editor, { target: { value: edited } });
    fireEvent.click(screen.getByRole("button", { name: "立即开启模拟实战" }));
    expect(fetchSse).toHaveBeenCalledWith("/api/interviews", expect.objectContaining({ body: expect.objectContaining({ jd: edited }) }));
  });

  it.each(["读取失败", "空原文"])("%s时不回退到 URL 片段或开放开场，重试可恢复完整 JD", async (failure) => {
    navigation.query.set("jd", "旧 URL 片段");
    if (failure === "读取失败") vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("画像读取失败"));
    else vi.mocked(jsonFetch).mockResolvedValueOnce({ ...portrait, jd: " \n " });
    render(<InterviewsPage />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("textbox", { name: jdLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: "立即开启模拟实战" })).toBeNull();
    expect(fetchSse).not.toHaveBeenCalled();
    vi.mocked(jsonFetch).mockResolvedValueOnce(portrait);
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    const editor = await screen.findByRole("textbox", { name: jdLabel }) as HTMLTextAreaElement;
    expect(editor.value).toBe(jd);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["成功", "失败"])("切换画像时取消旧读取，旧请求%s回包不覆盖新 JD 与编辑", async (outcome) => {
    const pending = Promise.withResolvers<typeof portrait>();
    vi.mocked(jsonFetch).mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ ...portrait, id: 18, jd: "画像乙完整 JD" });
    const view = render(<InterviewsPage />);
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(1));
    const oldSignal = vi.mocked(jsonFetch).mock.calls[0]?.[1]?.signal;
    navigation.query = new URLSearchParams("portraitId=18");
    view.rerender(<InterviewsPage />);
    const editor = await screen.findByRole("textbox", { name: jdLabel });
    fireEvent.change(editor, { target: { value: "画像乙手动调整后的 JD" } });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === "成功") pending.resolve(portrait);
      else pending.reject(new Error("过期画像读取失败"));
    });
    expect((editor as HTMLTextAreaElement).value).toBe("画像乙手动调整后的 JD");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("投递入口优先使用投递绑定的 JD 和简历版本", async () => {
    navigation.query = new URLSearchParams("applicationId=9&portraitId=17&jd=旧片段");
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 9, company: "公司", role: "岗位", jd: "投递完整 JD", resume_id: 4, resume_version_id: 41 });
    render(<InterviewsPage />);
    const editor = await screen.findByRole("textbox", { name: jdLabel }) as HTMLTextAreaElement;
    expect(editor.value).toBe("投递完整 JD");
    expect(editor.readOnly).toBe(true);
    expect(jsonFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(jsonFetch).mock.calls[0]?.[0]).toBe("/api/applications/9");
    fireEvent.click(screen.getByRole("button", { name: "立即开启模拟实战" }));
    expect(fetchSse).toHaveBeenCalledWith("/api/interviews", expect.objectContaining({ body: expect.objectContaining({ jd: "投递完整 JD", application_id: 9 }) }));
  });

  it("旧 jd 查询参数仍可带入完整文本，不额外请求画像", async () => {
    navigation.query = new URLSearchParams({ jd });
    render(<InterviewsPage />);
    expect((screen.getByRole("textbox", { name: jdLabel }) as HTMLTextAreaElement).value).toBe(jd);
    expect(jsonFetch).not.toHaveBeenCalled();
  });

  it.each([null, {}, { ...portrait, id: 18 }, { ...portrait, id: "17" }, { ...portrait, jd: 17 }])("画像来源响应异常 %j 时关闭开场，重读后恢复", async (response) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    render(<InterviewsPage />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("textbox", { name: jdLabel })).toBeNull();
    expect(fetchSse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    expect((await screen.findByRole("textbox", { name: jdLabel }) as HTMLTextAreaElement).value).toBe(jd);
  });

  const application = { id: 9, company: "公司", role: "岗位", jd: "投递完整 JD", resume_id: 4, resume_version_id: 41 };
  it.each([null, {}, { ...application, id: 10 }, { ...application, jd: null }, { ...application, resume_version_id: "41" }])("投递来源响应异常 %j 时不回退到其他来源", async (response) => {
    navigation.query = new URLSearchParams("applicationId=9&portraitId=17&jd=旧片段");
    vi.mocked(jsonFetch).mockResolvedValueOnce(response).mockResolvedValueOnce(application);
    render(<InterviewsPage />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("textbox", { name: jdLabel })).toBeNull();
    expect(fetchSse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect((await screen.findByRole("textbox", { name: jdLabel }) as HTMLTextAreaElement).value).toBe(application.jd);
    expect(vi.mocked(jsonFetch).mock.calls.map(([url]) => url)).toEqual(["/api/applications/9", "/api/applications/9"]);
  });

  it("未绑定发布版时显示准备指引，不使用 URL 简历替代", async () => {
    navigation.query = new URLSearchParams("applicationId=9&resumeId=4&resumeVersionId=41");
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...application, resume_version_id: null });
    render(<InterviewsPage />);
    await screen.findByText("请先在投递准备页选择已发布的简历版本，并补充岗位 JD。");
    expect(screen.queryByRole("textbox", { name: jdLabel })).toBeNull();
    expect(fetchSse).not.toHaveBeenCalled();
  });

  it.each(["错简历", "错版本", "缺少版本"])("投递绑定材料与列表选择不一致（%s）时禁用创建并提供重读", async (scenario) => {
    navigation.query = new URLSearchParams("applicationId=9");
    vi.mocked(jsonFetch).mockResolvedValueOnce(application);
    const original = vi.mocked(useInterviewsPage).getMockImplementation()!;
    const values = original(null);
    vi.mocked(useInterviewsPage).mockReturnValue({ ...values,
      resumeId: scenario === "错简历" ? 99 : 4,
      resumeVersionId: scenario === "错版本" ? 42 : scenario === "缺少版本" ? "" : 41,
    });
    render(<InterviewsPage />);
    await screen.findByText(/投递绑定的简历或发布版不在当前列表中/);
    const start = screen.getByRole("button", { name: "立即开启模拟实战" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    expect(fetchSse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重新读取简历列表" }));
    expect(values.reloadResumes).toHaveBeenCalledOnce();
  });
});
