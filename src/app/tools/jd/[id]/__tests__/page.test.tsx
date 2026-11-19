// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { confirmDialog } from "@/components/common/confirm-dialog";

const navigation = vi.hoisted(() => ({ id: "1", push: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: navigation.id }), useRouter: () => ({ push: navigation.push }) }));
vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
vi.mock("@/components/application/preparation-return-link", () => ({ PreparationReturnLink: () => null }));

beforeEach(() => { navigation.id = "1"; vi.mocked(confirmDialog).mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("JD 画像的稀疏考点展示", () => {
  it("损坏画像可核对原 JD，不要求先删除记录，也不自动生成替代结果", async () => {
    const source = "原 JD <T> &amp;\n只负责已有平台维护，权限尚未说明。";
    vi.mocked(jsonFetch).mockResolvedValue({ id: 1, jd: source, result: null, created_at: "2026-10-28" });
    render(<Page />);
    await screen.findByText(/该画像内容无法解析/);
    fireEvent.click(screen.getByText("查看完整原始 JD 文本要求"));
    expect(screen.getByRole("region", { name: "原始 JD" }).textContent).toBe(source);
    expect(screen.getByRole("link", { name: "返回列表" }).getAttribute("href")).toBe("/tools/jd");
    expect(screen.queryByText(/可删除.*后重新生成/)).toBeNull();
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2, 3])("%i 个考点时展示真实数量，不用无效雷达补足", async (count) => {
    vi.mocked(jsonFetch).mockResolvedValue({
      id: 1, jd: "合成岗位要求", created_at: "2026-10-20",
      result: {
        role: "合成开发岗位",
        mustSkills: Array.from({ length: count }, (_, index) => ({ name: `技能${index + 1}`, weight: 8, why: "JD 要求" })),
        followups: [],
        companyStyle: { style: "信息不足", signals: [] },
      },
    });
    render(<Page />);
    await screen.findByText("技能准备优先级");
    expect(screen.queryAllByText(/^技能\d$/, { selector: "li span" })).toHaveLength(count);
    expect(screen.queryByRole("img", { name: "技能准备优先级雷达图" }) !== null).toBe(count >= 3);
    if (count === 0) expect(screen.getByText(/暂未提炼出明确考点/)).toBeTruthy();
    expect(screen.getByText("暂没有足够的岗位信息生成具体练习题。")).toBeTruthy();
  });
});

const portrait = (id = 1) => ({ id, jd: `原文${id}`, result: null, created_at: "2026-10-28" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const deleteButton = () => screen.getByRole("button", { name: "删除画像" });

describe("JD 详情记录与删除状态隔离", () => {
  it.each(["exists", "missing", "unreadable", "mismatched"])("408 删除超时后只读核对 %s，不直接允许再次删除", async mode => {
    const read = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(portrait()).mockRejectedValueOnce(new HttpError("等待删除超时", 408)).mockReturnValueOnce(read.promise);
    render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "删除画像" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(3));
    expect((deleteButton() as HTMLButtonElement).disabled).toBe(true); expect(navigation.push).not.toHaveBeenCalled();
    expect(jsonFetch).toHaveBeenLastCalledWith("/api/tools/jd-portraits/1", expect.objectContaining({ cache: "no-store" }));
    await act(async () => {
      if (mode === "missing") read.reject(new HttpError("已不存在", 404));
      else if (mode === "unreadable") read.reject(new Error("状态读取失败"));
      else read.resolve(portrait(mode === "mismatched" ? 2 : 1));
    });
    if (mode === "missing") expect(navigation.push).toHaveBeenCalledExactlyOnceWith("/tools/jd");
    else if (mode === "exists") { expect((deleteButton() as HTMLButtonElement).disabled).toBe(false); expect(screen.getByRole("alert").textContent).toContain("记录目前仍存在"); }
    else {
      expect((deleteButton() as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByRole("button", { name: "重新读取删除状态" })).toBeTruthy();
      expect(navigation.push).not.toHaveBeenCalled(); expect(screen.queryByText("画像 #2")).toBeNull();
    }
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("切换记录立即移除旧内容；新记录读取失败后只重试新记录", async () => {
    const next = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(portrait()).mockReturnValueOnce(next.promise).mockResolvedValueOnce(portrait(2));
    const view = render(<Page />);
    await screen.findByText("画像 #1");
    navigation.id = "2";
    view.rerender(<Page />);
    expect(screen.queryByText("画像 #1")).toBeNull();
    expect(screen.queryByRole("button", { name: "删除画像" })).toBeNull();
    await act(async () => next.reject(new Error("读取第二份失败")));
    expect(screen.getByRole("alert").textContent).toContain("读取第二份失败");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await screen.findByText("画像 #2");
    expect(jsonFetch).toHaveBeenLastCalledWith("/api/tools/jd-portraits/2", expect.anything());
  });

  it("旧读取迟到不覆盖新记录", async () => {
    const first = deferred<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(first.promise).mockResolvedValueOnce(portrait(2));
    const view = render(<Page />);
    navigation.id = "2";
    view.rerender(<Page />);
    await screen.findByText("画像 #2");
    await act(async () => first.resolve(portrait()));
    expect(screen.queryByText("画像 #1")).toBeNull();
  });

  it.each([
    { ...portrait(), id: 2 }, { ...portrait(), id: 1.5 }, { ...portrait(), jd: null },
    { ...portrait(), result: { role: "残缺画像" } },
  ])("拒绝不完整或串记录响应 %#", async (value) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(value);
    render(<Page />);
    expect((await screen.findByRole("alert")).textContent).toContain("画像响应不完整");
    expect(screen.queryByRole("button", { name: "删除画像" })).toBeNull();
  });

  it("确认等待同步互斥，取消后可重新确认", async () => {
    const confirm = deferred<boolean>();
    vi.mocked(jsonFetch).mockResolvedValue(portrait());
    vi.mocked(confirmDialog).mockReturnValueOnce(confirm.promise).mockResolvedValueOnce(false);
    render(<Page />);
    await screen.findByText("画像 #1");
    act(() => { fireEvent.click(deleteButton()); fireEvent.click(deleteButton()); });
    expect(confirmDialog).toHaveBeenCalledOnce();
    await act(async () => confirm.resolve(false));
    fireEvent.click(deleteButton());
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(2));
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it("切换后旧确认同意也不发送删除", async () => {
    const confirm = deferred<boolean>();
    vi.mocked(confirmDialog).mockReturnValueOnce(confirm.promise);
    vi.mocked(jsonFetch).mockResolvedValueOnce(portrait()).mockResolvedValueOnce(portrait(2));
    const view = render(<Page />);
    await screen.findByText("画像 #1");
    fireEvent.click(deleteButton());
    navigation.id = "2";
    view.rerender(<Page />);
    await screen.findByText("画像 #2");
    await act(async () => confirm.resolve(true));
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it.each([true, false])("旧删除成功/失败不导航也不污染新记录：%s", async (success) => {
    const write = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(portrait()).mockReturnValueOnce(write.promise).mockResolvedValueOnce(portrait(2));
    const view = render(<Page />);
    await screen.findByText("画像 #1");
    fireEvent.click(deleteButton());
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(jsonFetch).mock.calls[1]?.[1]?.signal;
    navigation.id = "2";
    view.rerender(<Page />);
    await screen.findByText("画像 #2");
    expect(signal?.aborted).toBe(true);
    await act(async () => success ? write.resolve({ ok: true }) : write.reject(new Error("旧失败")));
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(jsonFetch).toHaveBeenCalledTimes(3);
  });

  it.each([new Error("响应丢失"), new HttpError("暂时不可用", 503), null, { ok: false }])("删除异常后先读取，404 才确认不存在 %#", async (response) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(portrait());
    if (response instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(response);
    else vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("记录不存在", 404));
    render(<Page />);
    await screen.findByText("画像 #1");
    fireEvent.click(deleteButton());
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/tools/jd"));
    expect(jsonFetch).toHaveBeenNthCalledWith(3, "/api/tools/jd-portraits/1", expect.objectContaining({ cache: "no-store" }));
    expect((deleteButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("核对仍存在保留失败原因，允许显式再次删除", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(portrait()).mockRejectedValueOnce(new Error("删除响应损坏"))
      .mockResolvedValueOnce(portrait()).mockResolvedValueOnce({ ok: true });
    render(<Page />);
    await screen.findByText("画像 #1");
    fireEvent.click(deleteButton());
    expect((await screen.findByRole("alert")).textContent).toContain("删除响应损坏；已重新读取，记录目前仍存在");
    expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.click(deleteButton());
    await waitFor(() => expect(navigation.push).toHaveBeenCalledOnce());
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
  });

  it("连续核对失败或串记录时保持锁定，重读互斥且只读不重复删除", async () => {
    const read = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(portrait()).mockRejectedValueOnce(new Error("响应丢失"))
      .mockRejectedValueOnce(new Error("核对失败"))
      .mockReturnValueOnce(read.promise).mockRejectedValueOnce(new HttpError("记录不存在", 404));
    render(<Page />);
    await screen.findByText("画像 #1");
    fireEvent.click(deleteButton());
    await screen.findByRole("button", { name: "重新读取删除状态" });
    expect((deleteButton() as HTMLButtonElement).disabled).toBe(true);
    act(() => {
      const retry = screen.getByRole("button", { name: "重新读取删除状态" });
      fireEvent.click(retry); fireEvent.click(retry); fireEvent.click(deleteButton());
    });
    expect(jsonFetch).toHaveBeenCalledTimes(4);
    await act(async () => read.resolve(portrait(2)));
    expect(screen.queryByText("画像 #2")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("记录不符");
    expect((deleteButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledOnce());
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("明确拒绝删除直接展示错误，允许重新确认", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(portrait()).mockRejectedValueOnce(new HttpError("禁止删除", 403));
    render(<Page />);
    await screen.findByText("画像 #1");
    fireEvent.click(deleteButton());
    expect((await screen.findByRole("alert")).textContent).toBe("禁止删除");
    expect((deleteButton() as HTMLButtonElement).disabled).toBe(false);
    expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("切换后旧删除状态读取不导航、不覆盖新记录：%s", async (missing) => {
    const read = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(portrait()).mockRejectedValueOnce(new Error("响应丢失"))
      .mockReturnValueOnce(read.promise).mockResolvedValueOnce(portrait(2));
    const view = render(<Page />);
    await screen.findByText("画像 #1");
    fireEvent.click(deleteButton());
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(3));
    navigation.id = "2";
    view.rerender(<Page />);
    await screen.findByText("画像 #2");
    await act(async () => missing ? read.reject(new HttpError("记录不存在", 404)) : read.resolve(portrait()));
    expect(screen.queryByText("画像 #1")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(navigation.push).not.toHaveBeenCalled();
  });
});
