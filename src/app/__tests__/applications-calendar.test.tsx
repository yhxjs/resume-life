// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ApplicationsPage from "../applications/page";
import { jsonFetch } from "@/lib/fetcher";
import type { Application } from "@/lib/applications-types";
import { getWeekDays, toDayKey } from "@/lib/application-calendar";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));

function application(id: number, scheduled = false): Application {
  return {
    id, company: `公司${id}`, role: "前端", stage: "interview", flow_status: "active",
    batch_name: "", hiring_stage: null, stage_changed_at: "", terminal_stage: null,
    terminal_reason: "", terminal_at: "", salary_range: "", resume_id: null, jd: "",
    interview_id: null, interview_series_id: null, notes: "", created_at: "", updated_at: "",
    next_interview_at: scheduled ? new Date().toISOString() : "",
  };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/applications?view=calendar");
  vi.mocked(jsonFetch).mockImplementation(async (url) => {
    if (url === "/api/applications/stats") return { counts: {}, rates: {}, totalActive: 0, upcomingInterviews: [] } as never;
    if (url === "/api/resumes") return [] as never;
    return { items: [], nextCursor: null } as never;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("投递日历分页和快捷日期", () => {
  it("防抖期间切换日历不拿新关键词拼旧游标", async () => {
    window.history.replaceState(null, "", "/applications");
    const fallback = vi.mocked(jsonFetch).getMockImplementation()!;
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (url === "/api/applications") return { items: [application(2)], nextCursor: "older" } as never;
      if (url === "/api/applications?q=new") return { items: [application(1, true)], nextCursor: null } as never;
      return fallback(url, init);
    });
    render(<ApplicationsPage />);
    await screen.findByText("公司2");
    fireEvent.change(screen.getByPlaceholderText("搜索公司、岗位或笔记..."), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("tab", { name: "日程日历" }));
    expect(screen.queryByRole("button", { name: /导出日历/ })).toBeNull();
    await screen.findByText("公司1");
    expect(vi.mocked(jsonFetch).mock.calls.some(([url]) => url.includes("q=new") && url.includes("cursor=older"))).toBe(false);
  });

  it("自动读取第二页，完整加载前不能导出，之后周历和议程都包含旧投递", async () => {
    const fallback = vi.mocked(jsonFetch).getMockImplementation()!;
    let finishPage!: (value: unknown) => void;
    vi.mocked(jsonFetch).mockImplementation((url, init) => {
      if (url === "/api/applications") return Promise.resolve({
        items: Array.from({ length: 50 }, (_, i) => application(51 - i, i === 0)), nextCursor: "older",
      }) as never;
      if (url === "/api/applications?cursor=older") return new Promise((resolve) => { finishPage = resolve; }) as never;
      return fallback(url, init);
    });
    render(<ApplicationsPage />);
    await waitFor(() => expect(finishPage).toBeTypeOf("function"));
    expect(screen.queryByRole("button", { name: /导出日历/ })).toBeNull();
    await act(async () => finishPage({ items: [application(1, true)], nextCursor: null }));
    expect(await screen.findByText("公司1")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /导出日历/ }));
    expect(screen.getByRole("button", { name: "导出全部日程 (2 场)" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /议程清单/ }));
    expect(screen.getByText("公司1")).toBeDefined();
  });

  it("后续页失败时停止自动请求并提供显式重试，不导出部分内容", async () => {
    const fallback = vi.mocked(jsonFetch).getMockImplementation()!;
    let attempts = 0;
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (url === "/api/applications") return { items: [application(2, true)], nextCursor: "older" } as never;
      if (url === "/api/applications?cursor=older") {
        attempts += 1;
        if (attempts === 1) throw new Error("下一页暂不可用");
        return { items: [application(1, true)], nextCursor: null } as never;
      }
      return fallback(url, init);
    });
    render(<ApplicationsPage />);
    expect(await screen.findByText(/下一页暂不可用/)).toBeDefined();
    expect(attempts).toBe(1);
    expect(screen.queryByRole("button", { name: /导出日历/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试加载日程" }));
    expect(await screen.findByText("公司1")).toBeDefined();
    expect(attempts).toBe(2);
  });

  it("保留所选周的快捷日期，确认时间后使用该日期，取消后普通创建不残留", async () => {
    render(<ApplicationsPage />);
    await screen.findByRole("button", { name: /导出日历/ });
    fireEvent.click(screen.getByTitle("查看下一周"));
    const target = new Date();
    target.setDate(target.getDate() + 7);
    const day = getWeekDays(target)[0]!;
    fireEvent.click(screen.getAllByRole("button", { name: /记排期/ })[0]!);
    const picker = screen.getByRole("button", { name: "下次面试时间 (约面/待面)" });
    expect(picker.textContent).toContain(toDayKey(day));
    expect(picker.textContent).toContain("请选择时间");
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("button", { name: "14 点" }));
    fireEvent.click(screen.getByRole("button", { name: "30 分" }));
    expect(picker.textContent).toContain(`${toDayKey(day)} 14:30`);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: /登记新投递/ }));
    expect(screen.getByText("选择下次面试时间...")).toBeDefined();
    await waitFor(() => expect(screen.queryByText("正在加载单轮面试...")).toBeNull());
  });
});
