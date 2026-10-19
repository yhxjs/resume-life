// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PortfolioWorkspacePage from "../page";

const fetchMock = vi.fn();
vi.mock("@/components/portfolio/portfolio-live-preview", () => ({
  PortfolioLivePreview: ({ options }: { options: unknown }) => <div data-testid="real-preview">{JSON.stringify(options)}</div>,
}));
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({
    resumes: [{ id: 1, title: "测试简历", versions: [{ id: 2, version: 1, name: "投递版" }] }],
    projects: [{ id: 3, name: "技术档案", summary: { architecture: "内部架构" } }],
  }) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); fetchMock.mockReset(); });

it("以简历版本作为真实预览来源，不默认附加项目库档案", async () => {
  render(<PortfolioWorkspacePage />);
  await screen.findByText("个人作品集与静态主页工作台");
  expect((screen.getByLabelText("选择简历") as HTMLSelectElement).value).toBe("1");
  expect((screen.getByLabelText("选择版本快照") as HTMLSelectElement).value).toBe("2");
  const preview = JSON.parse(screen.getByTestId("real-preview").textContent!);
  expect(preview).toMatchObject({ resumeId: 1, versionId: 2, selectedProjects: [], themeMode: "dark" });
  expect(screen.queryByText("技术档案")).toBeNull();
  expect(screen.getByRole("link", { name: /编辑简历内容/ }).getAttribute("href")).toBe("/resumes/1");
});

it("首屏介绍、颜色和主题同步传入真实预览", async () => {
  render(<PortfolioWorkspacePage />);
  await screen.findByText("个人作品集与静态主页工作台");
  fireEvent.change(screen.getByLabelText("首屏介绍"), { target: { value: "热爱创造" } });
  fireEvent.change(screen.getByLabelText("点缀色"), { target: { value: "#44bbcc" } });
  fireEvent.click(screen.getByRole("button", { name: "浅色" }));
  expect(JSON.parse(screen.getByTestId("real-preview").textContent!)).toMatchObject({ siteSubtitle: "热爱创造", accentColor: "#44bbcc", themeMode: "light" });
  expect(screen.getByRole("button", { name: "浅色", pressed: true })).toBeDefined();
});

it("提供四套主页模板，切换后同步真实预览", async () => {
  render(<PortfolioWorkspacePage />);
  await screen.findByText("个人作品集与静态主页工作台");
  const select = screen.getByLabelText("主页模板") as HTMLSelectElement;
  expect(select.options).toHaveLength(4);
  for (const siteTemplate of ["focus", "chronicle", "sidebar", "flow"]) {
    fireEvent.change(select, { target: { value: siteTemplate } });
    expect(JSON.parse(screen.getByTestId("real-preview").textContent!)).toMatchObject({ siteTemplate });
  }
});

it("预览与导出使用相同配置，导出失败保留当前编辑", async () => {
  render(<PortfolioWorkspacePage />);
  await screen.findByText("个人作品集与静态主页工作台");
  fireEvent.change(screen.getByLabelText("网页标题"), { target: { value: "我的动态简历" } });
  fireEvent.change(screen.getByLabelText("主页模板"), { target: { value: "sidebar" } });
  const preview = JSON.parse(screen.getByTestId("real-preview").textContent!);
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "请稍后重试" }) });
  fireEvent.click(screen.getByRole("button", { name: "生成并下载作品集" }));
  await screen.findByRole("alert");
  const call = fetchMock.mock.calls.find(([url]) => url === "/api/portfolio/export");
  expect(JSON.parse(call![1].body)).toEqual(preview);
  expect(screen.getByDisplayValue("我的动态简历")).toBeDefined();
});

it("无简历时提供创建入口并禁止下载", async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ resumes: [], projects: [] }) });
  render(<PortfolioWorkspacePage />);
  await screen.findByRole("link", { name: "创建简历" });
  expect((screen.getByRole("button", { name: "生成并下载作品集" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId("real-preview").textContent).toBe("null");
});
