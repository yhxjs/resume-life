// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { fetchSse } from "@/lib/fetch-sse";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn(), alertDialog: vi.fn() }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/lib/fetch-sse", async original => ({ ...await original<typeof import("@/lib/fetch-sse")>(), fetchSse: vi.fn() }));
const resumes = [{ id: 1, title: "参考简历", versions: [{ id: 11, version: 1, name: "发布版" }] }];
vi.mock("@/hooks/use-resume-options", () => ({ useResumeOptions: () => ({ resumes, resumesError: "", reloadResumes: vi.fn() }) }));
const row = (id: number) => ({ id, jd: `岗位 ${id}`, created_at: "2026-10-29", resume_title: "参考简历", resume_version_id: 11, resume_version: 1, resume_version_name: "发布版" });
let failList: boolean;
let list: { items: ReturnType<typeof row>[]; nextCursor: string | null; total?: number };
const settle = async () => { await act(() => vi.advanceTimersByTimeAsync(1)); await act(() => vi.advanceTimersByTimeAsync(1)); };
beforeEach(() => {
  vi.useFakeTimers(); failList = false; list = { items: [row(60), row(59)], nextCursor: null, total: 2 };
  vi.mocked(confirmDialog).mockResolvedValue(true);
  vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
    if (url === "/api/intros/60") {
      if (init?.method === "DELETE") return { ok: true } as never;
      throw new HttpError("不存在", 404);
    }
    if (url.startsWith("/api/intros?")) { if (failList) throw new Error("历史刷新失败"); return list as never; }
    throw new Error(`Unexpected ${url}`);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
const history = () => screen.getByRole("region", { name: "自我介绍历史" });
const remove = () => within(history()).getAllByRole("button", { name: "删除" })[0]!;
const draft = "  未提交 <T> &amp;\n内部  空格  ";
function configure() {
  const input = screen.getByRole("textbox", { name: "目标岗位要求（JD / 职位描述）" });
  fireEvent.change(input, { target: { value: draft } });
  return { input: input as HTMLTextAreaElement, start: screen.getByRole("button", { name: "立即生成两版自我介绍" }) };
}

describe("自我介绍历史删除", () => {
  it("确认从同事件开始互斥，取消零写入且不改 JD", async () => {
    const decision = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(decision.promise);
    render(<Page />); await settle(); const { input, start } = configure(); const button = remove();
    act(() => { button.click(); button.click(); start.click(); });
    expect(confirmDialog).toHaveBeenCalledOnce(); expect(fetchSse).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "不应覆盖" } });
    expect(input.value).toBe(draft);
    await act(async () => { decision.resolve(false); });
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
    expect(input.value).toBe(draft); expect((start as HTMLButtonElement).disabled).toBe(false);
  });

  it("坏完成响应核对同 ID，未知时只读重试；旧首页不复活已删项", async () => {
    const original = vi.mocked(jsonFetch).getMockImplementation()!; let reads = 0;
    vi.mocked(jsonFetch).mockImplementation((url, init) => {
      if (url === "/api/intros/60") {
        if (init?.method === "DELETE") return Promise.resolve({}) as never;
        if (++reads === 1) return Promise.resolve({ id: 59 }) as never;
        return Promise.reject(new HttpError("不存在", 404));
      }
      return original(url, init);
    });
    render(<Page />); await settle(); const { input, start } = configure(); fireEvent.click(remove()); await settle();
    const retry = screen.getByRole("button", { name: "重新读取删除状态" });
    expect(screen.getByRole("alert").textContent).toContain("#60"); expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("link", { name: "岗位 60" })).toBeTruthy();
    act(() => { retry.click(); retry.click(); }); await settle();
    expect(reads).toBe(2); expect(screen.queryByRole("link", { name: "岗位 60" })).toBeNull();
    expect(screen.getByRole("link", { name: "岗位 59" })).toBeTruthy(); expect(input.value).toBe(draft);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("删除刷新失败可独立恢复，旧响应仍过滤已删 ID", async () => {
    render(<Page />); await settle(); const { input } = configure(); failList = true;
    fireEvent.click(remove()); await settle();
    expect(screen.queryByRole("link", { name: "岗位 60" })).toBeNull();
    expect(screen.getByText(/已确认自我介绍 #60 不存在/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("历史刷新失败");
    failList = false; fireEvent.click(screen.getByRole("button", { name: "重试加载" })); await settle();
    expect(screen.queryByRole("link", { name: "岗位 60" })).toBeNull(); expect(input.value).toBe(draft);
  });

  it("旧首页全为已删记录仍能加载更早记录", async () => {
    list = { items: Array.from({ length: 50 }, (_, index) => row(60 - index)), nextCursor: "11" };
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "DELETE") return { ok: true } as never;
      return (url.includes("cursor=11") ? { items: [row(10)], nextCursor: null } : list) as never;
    });
    render(<Page />); await settle();
    for (let index = 0; index < 50; index++) { fireEvent.click(remove()); await settle(); }
    expect(within(history()).queryAllByRole("link", { name: "查看演练" })).toHaveLength(0);
    expect(screen.getByText("本页记录已移除，可以继续加载更早的自我介绍。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" })); await settle();
    expect(screen.getByRole("link", { name: "岗位 10" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  }, 30_000);

  it("生成等待阻止同事件排队删除，失败后可重新确认", async () => {
    const pending = Promise.withResolvers<void>(); vi.mocked(fetchSse).mockReturnValueOnce(pending.promise);
    render(<Page />); await settle(); const { input, start } = configure(); const button = remove();
    act(() => { start.click(); start.click(); button.click(); });
    expect(fetchSse).toHaveBeenCalledOnce(); expect(confirmDialog).not.toHaveBeenCalled();
    await act(async () => { pending.reject(new Error("生成暂时失败")); await pending.promise.catch(() => {}); });
    await vi.waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    expect(input.value).toBe(draft);
    await vi.waitFor(() => expect(screen.getByRole("link", { name: "岗位 60" })).toBeTruthy());
    fireEvent.click(remove()); await settle();
    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
  });
});
