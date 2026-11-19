// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Page from "../page";
import { PRESET_REMEDIES } from "@/lib/career-gap-remedy";
import { HttpError, jsonFetch } from "@/lib/fetcher";

const record = { id: 7, scenario_type: "gap", raw_story: "历史原稿 <T> &amp;", target_role: "旧岗位", persona_style: "pragmatic", result: "{}", created_at: "2026-10-29" };
const state = vi.hoisted(() => ({ push: vi.fn(), reload: vi.fn(), confirm: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: state.confirm }));
vi.mock("@/hooks/use-cursor-list", () => ({ useCursorList: () => ({ items: [record], total: 1, nextCursor: null,
  loading: false, loadingMore: false, listError: "", failedCursor: undefined, reload: state.reload, loadMore: vi.fn() }) }));
beforeEach(() => { vi.mocked(jsonFetch).mockReset(); state.confirm.mockReset().mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("生成等待时禁用所有改写与历史删除入口，示例仍可阅读，成功导航前保持锁", async () => {
  const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  render(<Page />);
  const input = screen.getByRole("textbox", { name: "真实经历与希望说明的问题" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "  没有学习或项目。<T> &amp;\n到岗时间未定。  " } });
  fireEvent.change(screen.getByRole("textbox", { name: "目标应聘岗位 / 业务方向（选填）" }), { target: { value: "C++ / C#" } });
  fireEvent.click(screen.getByRole("button", { name: new RegExp(PRESET_REMEDIES[0]!.title) }));
  const submit = screen.getByRole("button", { name: "生成沟通方案 →" });
  act(() => { fireEvent.click(submit); fireEvent.click(submit); });
  expect(jsonFetch).toHaveBeenCalledOnce();
  for (const control of screen.getAllByRole("textbox")) expect((control as HTMLInputElement).disabled).toBe(true);
  for (const name of ["加班内耗", "休整学习4个月", "业务被裁+待业", "清空内容", "+ 填入示例后修改", "删除"]) {
    const button = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); fireEvent.click(button);
  }
  for (const name of ["沟通场景", "表达风格（仅调整语气与组织）"]) {
    for (const button of within(screen.getByRole("group", { name })).getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
  }
  expect(input.value).toBe("  没有学习或项目。<T> &amp;\n到岗时间未定。  "); expect(state.confirm).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "收起 ✕" }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { pending.resolve({ id: 18 }); });
  expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/gap/18");
  expect(input.disabled).toBe(true); fireEvent.click(submit); expect(jsonFetch).toHaveBeenCalledOnce();
});

it("损坏完成响应就地显示可访问错误，保留原文和历史，显式重试成功", async () => {
  vi.mocked(jsonFetch).mockResolvedValueOnce({ id: "wrong" }).mockResolvedValueOnce({ id: 19 });
  render(<Page />);
  const input = screen.getByRole("textbox", { name: "真实经历与希望说明的问题" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "真实经历 <T> &amp;\n尚未确认到岗" } });
  fireEvent.click(screen.getByRole("button", { name: "生成沟通方案 →" }));
  expect((await screen.findByRole("alert", { name: "空窗方案生成状态" })).textContent).toContain("核对历史记录");
  expect(state.push).not.toHaveBeenCalled(); expect(state.reload).toHaveBeenCalledOnce();
  expect(input.value).toBe("真实经历 <T> &amp;\n尚未确认到岗"); expect(input.disabled).toBe(false);
  expect(screen.getByRole("group", { name: "空窗沟通报告 #7" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "生成沟通方案 →" }));
  await waitFor(() => expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/gap/19"));
  expect(jsonFetch).toHaveBeenCalledTimes(2);
});

it("删除未确认锁住全部删除和生成，重读 404 后旧列表也不能复活已删卡片", async () => {
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new HttpError("暂不可用", 503))
    .mockRejectedValueOnce(new HttpError("不存在", 404));
  render(<Page />);
  const input = screen.getByRole("textbox", { name: "真实经历与希望说明的问题" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "保留未提交草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  expect((await screen.findByRole("alert")).textContent).toContain("删除结果尚未确认");
  expect((screen.getByRole("button", { name: "删除" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "生成沟通方案 →" }) as HTMLButtonElement).disabled).toBe(true);
  expect(state.confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining("#7「历史原稿 <T> &amp;」") }));
  fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" }));
  await waitFor(() => expect(screen.queryByRole("group", { name: "空窗沟通报告 #7" })).toBeNull());
  expect(state.reload).toHaveBeenCalledOnce(); expect(input.value).toBe("保留未提交草稿");
  expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
});
