// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteNav } from "../site-nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/interviews/1" }));
vi.mock("@/components/layout/command-palette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/common/confirm-dialog", () => ({ alertDialog: vi.fn(async () => {}) }));

const assign = vi.fn();
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  assign.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  const originalWindow = window;
  vi.stubGlobal("window", new Proxy(originalWindow, {
    get(target, property) {
      if (property === "location") return { ...target.location, assign };
      const value = Reflect.get(target, property);
      return typeof value === "function" && /^(add|remove)EventListener$/.test(String(property))
        ? value.bind(target) : value;
    },
  }));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("退出登录的结果", () => {
  it("取消草稿退出选择不会撤销会话或删除副本", () => {
    sessionStorage.setItem("resume-life:draft:1", '{"title":"合成草稿"}');
    render(<SiteNav />);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("resume-life:draft:1")).not.toBeNull();
  });
  it("本机存储禁止读取时仍可选择退出并撤销会话", async () => {
    vi.spyOn(Storage.prototype, "key").mockImplementation(() => { throw new Error("存储被禁止"); });
    sessionStorage.setItem("synthetic", "value");
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    render(<SiteNav />);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保留草稿并退出" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("撤销成功但本机清理失败时提示残留并继续退出", async () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("存储被禁止"); });
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    render(<SiteNav />);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    const { alertDialog } = await import("@/components/common/confirm-dialog");
    expect(alertDialog).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("本机副本清除未完成") }));
  });
  it("无草稿时退出会清理脱敏原词，并保留其他应用存储", async () => {
    localStorage.setItem("resume_life_anonymize_config", '{"customRules":[{"source":"合成保密名称"}]}');
    localStorage.setItem("other-app", "keep");
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    render(<SiteNav />);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(localStorage.getItem("resume_life_anonymize_config")).toBeNull();
    expect(localStorage.getItem("other-app")).toBe("keep");
  });
  it.each([true, false])("有未保存草稿时明确选择清除=%s 后退出", async (clear) => {
    sessionStorage.setItem("resume-life:draft:1", '{"title":"合成草稿"}');
    sessionStorage.setItem("other-app", "keep");
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    render(<SiteNav />);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: clear ? "清除草稿并退出" : "保留草稿并退出" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(sessionStorage.getItem("resume-life:draft:1")).toBe(clear ? null : '{"title":"合成草稿"}');
    expect(sessionStorage.getItem("other-app")).toBe("keep");
  });
  it.each(["network", "server"])("%s 失败保留页面并允许重试", async (failure) => {
    if (failure === "network") fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    else fetchMock.mockResolvedValueOnce(Response.json({ error: "撤销会话失败" }, { status: 500 }));
    render(<SiteNav />);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("退出失败"));
    expect(assign).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "退出登录" }) as HTMLButtonElement).disabled).toBe(false);

    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    fireEvent.click(screen.getByRole("button", { name: "重试退出" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("成功撤销后整页跳转登录页", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    render(<SiteNav />);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("桌面导航 disclosure", () => {
  it("保留原生链接语义、展开状态和默认 Tab 行为", () => {
    render(<SiteNav />);
    const trigger = screen.getByRole("button", { name: "简历中心" });
    expect(trigger.getAttribute("aria-haspopup")).toBeNull();
    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
    const link = screen.getByRole("link", { name: /简历管理/ });
    expect(link.getAttribute("href")).toBe("/resumes");
    expect(link.tabIndex).toBe(0);
    expect(fireEvent.keyDown(trigger, { key: "Tab" })).toBe(true);
  });

  it("从展开链接按 Escape 收起并归还触发按钮焦点", () => {
    render(<SiteNav />);
    const trigger = screen.getByRole("button", { name: "简历中心" });
    fireEvent.click(trigger);
    screen.getByText("简历管理").closest("a")!.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
});
