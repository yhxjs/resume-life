// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSummaryHistory } from "../project-summary-history";
import { jsonFetch } from "@/lib/fetcher";
import { emptySummary } from "@/lib/summary";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const overview = " 历史原文 <T> &amp;\n内部  空格 ";
const item = (id: number) => ({ id, source: "manual", createdAt: "旧时间字面量", summary: { ...emptySummary(), overview: `${overview}${id}`, achievements: ["", " 原成果 <T>\n内部  空格 "] }, aiBaseline: {} });
const first = { projectId: 1, items: Array.from({ length: 10 }, (_, index) => item(30 - index)), nextCursor: "21" };

describe("项目总结历史整页读取与恢复", () => {
  it("首页失败可单独重读历史，不能要求用户刷新整个编辑页", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("历史暂时不可读")).mockResolvedValueOnce({ projectId: 1, items: [item(30)], nextCursor: null });
    render(<ProjectSummaryHistory projectId={1} revisionId={30} />);
    await screen.findByText(/历史暂时不可读/);
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await screen.findByText("#30"); expect(jsonFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText("旧时间字面量").textContent).toBe("旧时间字面量");
  });

  it("其他项目的成功回包整页拒绝，不展示为当前项目历史", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ ...first, projectId: 2 });
    render(<ProjectSummaryHistory projectId={1} revisionId={30} />);
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(screen.queryByText("#30")).toBeNull(); expect(screen.getByRole("alert").textContent).toContain("总结历史响应不完整");
  });

  it("重复边界不靠去重吞掉，保留全文和原游标供修复后重试", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(first).mockResolvedValueOnce({ projectId: 1, items: [item(21)], nextCursor: null }).mockResolvedValueOnce({ projectId: 1, items: [item(20)], nextCursor: null });
    render(<ProjectSummaryHistory projectId={1} revisionId={30} />);
    await screen.findByText("#30"); fireEvent.click(screen.getByRole("button", { name: "加载更早的总结" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("总结历史响应不完整"));
    const region = screen.getByRole("region", { name: "总结历史" }); expect(region.querySelectorAll("details")).toHaveLength(10);
    fireEvent.click(within(region).getByRole("button", { name: "重试加载更早的总结" }));
    await screen.findByText("#20"); expect(region.querySelectorAll("details")).toHaveLength(11);
    expect(vi.mocked(jsonFetch).mock.calls.slice(1).map(([url]) => new URL(url, "http://localhost").searchParams.get("cursor"))).toEqual(["21", "21"]);
    expect(region.textContent).toContain(`${overview}30`);
  });

  it("项目或版本切换取消旧页，迟到结果不能认作新项目历史", async () => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ projectId: 2, items: [item(40)], nextCursor: null });
    const view = render(<ProjectSummaryHistory projectId={1} revisionId={30} />);
    await screen.findByText("#30"); fireEvent.click(screen.getByRole("button", { name: "加载更早的总结" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    view.rerender(<ProjectSummaryHistory projectId={2} revisionId={40} />);
    expect(screen.queryByText("#30")).toBeNull(); await screen.findByText("#40");
    await act(async () => pending.resolve({ projectId: 1, items: [item(20)], nextCursor: null }));
    expect(screen.queryByText("#20")).toBeNull(); expect(screen.getByText("#40")).not.toBeNull();
    expect(vi.mocked(jsonFetch).mock.calls[1]![1]?.signal?.aborted).toBe(true);
  });
});
