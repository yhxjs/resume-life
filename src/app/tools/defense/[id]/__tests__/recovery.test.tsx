// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { confirmDialog } from "@/components/common/confirm-dialog";

const navigation = vi.hoisted(() => ({ id: "1", push: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: navigation.id }), useRouter: () => ({ push: navigation.push }) }));
vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));

beforeEach(() => { navigation.id = "1"; vi.mocked(confirmDialog).mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function detail(id = 1) {
  return { report: { id, resumeId: null, title: `报告${id}`, sourceContent: `报告${id}原文 <T> &amp;\n尚未上线`, targetRole: "接口工程师",
    riskLevel: "medium", overallRoast: `报告${id}建议`, createdAt: "2026-10-29", items: [{
      id: "item_1", originalText: `报告${id}引用 <T> &amp;`, sectionHint: "项目", riskLevel: "medium", riskType: "scope_ambiguity",
      interviewerRoast: "核对分工", deadlyQuestions: ["分工？"],
      defensePlan: { interviewerIntent: "核对", standardDefense: "仅说明事实", tabooMistakes: ["编造经历"] },
    }] }, drills: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const remove = () => screen.getByRole("button", { name: "删除报告" });

describe("排雷详情读取与记录隔离", () => {
  it("切换立即移除旧正文和演练草稿；新报告读取失败仅重试新记录", async () => {
    const next = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockReturnValueOnce(next.promise).mockResolvedValueOnce(detail(2));
    const view = render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "即刻防御演练" }));
    fireEvent.change(screen.getByRole("textbox", { name: "你的练习回答：" }), { target: { value: "旧报告未提交草稿" } });
    navigation.id = "2"; view.rerender(<Page />);
    expect(screen.queryByRole("heading", { name: "报告1" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.queryByDisplayValue("旧报告未提交草稿")).toBeNull();
    expect(vi.mocked(jsonFetch).mock.calls[0]![1]!.signal!.aborted).toBe(true);
    await act(async () => next.reject(new Error("读取第二份失败")));
    expect(screen.getByRole("alert").textContent).toContain("读取第二份失败");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await screen.findByRole("heading", { name: "报告2" });
    expect(jsonFetch).toHaveBeenLastCalledWith("/api/tools/resume-defenses/2", expect.objectContaining({ cache: "no-store" }));
  });

  it.each(["success", "failure"])("切换后旧读取 %s 不覆盖新页", async (outcome) => {
    const old = deferred<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockResolvedValueOnce(detail(2));
    const view = render(<Page />); navigation.id = "2"; view.rerender(<Page />);
    await screen.findByRole("heading", { name: "报告2" });
    await act(async () => { if (outcome === "success") old.resolve(detail()); else old.reject(new Error("旧错误")); });
    expect(screen.queryByRole("heading", { name: "报告1" })).toBeNull(); expect(screen.queryByText("旧错误")).toBeNull();
  });

  it("StrictMode 旧请求不能覆盖当前报告", async () => {
    const old = deferred<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockResolvedValueOnce(detail());
    render(<StrictMode><Page /></StrictMode>);
    await screen.findByRole("heading", { name: "报告1" });
    await act(async () => old.reject(new Error("StrictMode 旧错误")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(vi.mocked(jsonFetch).mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it.each([{ report: detail(2).report, drills: [] }, { report: { ...detail().report, items: [null] }, drills: [] }, { report: detail().report }])("无效或串记录不能开放删除和演练，可只读重试 %#", async (value) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(value).mockResolvedValueOnce(detail());
    render(<Page />); expect((await screen.findByRole("alert")).textContent).toContain("排雷报告响应不完整");
    expect(screen.queryByRole("button", { name: "删除报告" })).toBeNull();
    expect(screen.queryByRole("button", { name: "即刻防御演练" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await screen.findByRole("heading", { name: "报告1" }); expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it("切换后旧演练成功不能把分数和回答带到新报告", async () => {
    const old = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockReturnValueOnce(old.promise).mockResolvedValueOnce(detail(2));
    const view = render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "即刻防御演练" }));
    fireEvent.change(screen.getByRole("textbox", { name: "你的练习回答：" }), { target: { value: "旧回答" } });
    fireEvent.click(screen.getByRole("button", { name: "提交练习回答" }));
    navigation.id = "2"; view.rerender(<Page />);
    await screen.findByRole("heading", { name: "报告2" });
    await act(async () => old.resolve({ id: 10, defenseId: 1, itemId: "item_1", question: "分工？", userAnswer: "旧回答", defenseScore: 85 }));
    expect(screen.queryByText("85分")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "即刻防御演练" }));
    expect((screen.getByRole("textbox", { name: "你的练习回答：" }) as HTMLTextAreaElement).value).toBe("");
  });
});

describe("演练存档与报告计数", () => {
  it("演练异常后读到空存档，同步移除已完成计数和旧分数，不改写当前草稿", async () => {
    const original = { id: 10, defenseId: 1, itemId: "item_1", question: "分工？", userAnswer: "之前的原答", defenseScore: 85,
      interviewerRoast: "旧点评", defenseCritique: "待补充", improvedAnswer: "旧参考", createdAt: "2026-10-29", updatedAt: "2026-10-29" };
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...detail(), drills: [original] })
      .mockRejectedValueOnce(new Error("写入响应丢失")).mockResolvedValueOnce(detail());
    render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "查看/重做对练" }));
    expect(screen.getByText(/已完成演练:/).textContent).toContain("1 / 1");
    fireEvent.change(screen.getByRole("textbox", { name: "你的练习回答：" }), { target: { value: "未提交原稿 <T> &amp;" } });
    fireEvent.click(screen.getByRole("button", { name: "提交练习回答" }));
    await screen.findByText(/当前存档未找到/);
    expect(screen.getByText(/已完成演练:/).textContent).toContain("0 / 1");
    expect(screen.queryByText("85分")).toBeNull(); expect(screen.queryByText("旧点评")).toBeNull();
    expect((screen.getByRole("textbox", { name: "你的练习回答：" }) as HTMLTextAreaElement).value).toBe("未提交原稿 <T> &amp;");
  });
});

describe("排雷详情删除核对", () => {
  it("从确认同步互斥，取消无写入，确认包含身份和关联演练提示", async () => {
    const confirm = deferred<boolean>();
    vi.mocked(confirmDialog).mockReturnValueOnce(confirm.promise);
    vi.mocked(jsonFetch).mockResolvedValue(detail()); render(<Page />);
    await screen.findByRole("heading", { name: "报告1" });
    act(() => { fireEvent.click(remove()); fireEvent.click(remove()); });
    expect(confirmDialog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "确定删除简历排雷报告 #1「报告1」？删除后相关防御演练记录将一并清除。" }));
    expect((remove() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "即刻防御演练" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => confirm.resolve(false));
    expect((remove() as HTMLButtonElement).disabled).toBe(false); expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it.each([{ ok: true }, new HttpError("已删除", 404)])("明确不存在后只导航一次，等待导航时不再展示报告或写入口 %#", async (value) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail());
    if (value instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(value); else vi.mocked(jsonFetch).mockResolvedValueOnce(value);
    render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "删除报告" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledExactlyOnceWith("/tools/defense"));
    expect(screen.getByRole("status").textContent).toContain("报告已不存在");
    expect(screen.queryByRole("button", { name: "删除报告" })).toBeNull(); expect(screen.queryByRole("heading", { name: "报告1" })).toBeNull();
    expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it("坏响应与串报告保持锁，只读重试仍存在后才允许显式再次确认", async () => {
    const read = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(detail(2))
      .mockReturnValueOnce(read.promise).mockResolvedValueOnce({ ok: true });
    render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "删除报告" }));
    await screen.findByText(/删除结果尚未确认/);
    expect((remove() as HTMLButtonElement).disabled).toBe(true); expect(navigation.push).not.toHaveBeenCalled();
    const retry = screen.getByRole("button", { name: "重新读取删除状态" });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(jsonFetch).toHaveBeenCalledTimes(4);
    await act(async () => read.resolve(detail()));
    await screen.findByText(/目前仍存在/); expect((remove() as HTMLButtonElement).disabled).toBe(false);
    expect(confirmDialog).toHaveBeenCalledOnce(); expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.click(remove());
    await waitFor(() => expect(navigation.push).toHaveBeenCalledOnce()); expect(confirmDialog).toHaveBeenCalledTimes(2);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(2);
  });

  it("删除后连续读取失败只能 GET，404 才导航", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockRejectedValueOnce(new Error("网络失败"))
      .mockRejectedValueOnce(new HttpError("状态读取失败", 503)).mockRejectedValueOnce(new HttpError("状态仍失败", 503))
      .mockRejectedValueOnce(new HttpError("已删除", 404));
    render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "删除报告" }));
    await screen.findByText(/状态读取失败/);
    fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" }));
    await screen.findByText(/状态仍失败/); expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledOnce());
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(1);
  });

  it("明确拒绝直接提示，不核对或自动重写", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockRejectedValueOnce(new HttpError("无权删除", 403));
    render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "删除报告" }));
    await screen.findByText(/无权删除/); expect((remove() as HTMLButtonElement).disabled).toBe(false);
    expect(jsonFetch).toHaveBeenCalledTimes(2); expect(navigation.push).not.toHaveBeenCalled();
  });

  it.each(["confirm", "delete-success", "delete-failure", "check-404", "check-existing", "check-failure"])("切换后旧 %s 不导航或污染新报告", async (phase) => {
    const old = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail());
    if (phase === "confirm") vi.mocked(confirmDialog).mockReturnValueOnce(old.promise as Promise<boolean>);
    else if (phase.startsWith("delete")) vi.mocked(jsonFetch).mockReturnValueOnce(old.promise);
    else vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("写入异常")).mockReturnValueOnce(old.promise);
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail(2));
    const view = render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "删除报告" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(phase === "confirm" ? 1 : phase.startsWith("delete") ? 2 : 3));
    navigation.id = "2"; view.rerender(<Page />); await screen.findByRole("heading", { name: "报告2" });
    await act(async () => {
      if (phase === "confirm") old.resolve(true);
      else if (phase === "delete-success") old.resolve({ ok: true });
      else if (phase === "check-existing") old.resolve(detail());
      else old.reject(phase === "check-404" ? new HttpError("已删除", 404) : new Error("旧操作失败"));
    });
    expect(navigation.push).not.toHaveBeenCalled(); expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/删除结果尚未确认/)).toBeNull(); expect((remove() as HTMLButtonElement).disabled).toBe(false);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(phase === "confirm" ? 0 : 1);
  });

  it("未知历史评级不解释为低风险，范围外分数不显示成有效得分", async () => {
    const value = detail(); value.report.riskLevel = "legacy";
    vi.mocked(jsonFetch).mockResolvedValue({ ...value, drills: [{ id: 10, defenseId: 1, itemId: "item_1", question: "分工？", userAnswer: "原答", defenseScore: 101,
      interviewerRoast: "点评", defenseCritique: "待补充", improvedAnswer: "参考", createdAt: "2026-10-29", updatedAt: "2026-10-29" }] });
    render(<Page />); await screen.findByText("未提供有效风险评级");
    expect(screen.getByText("未提供有效演练分数")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看/重做对练" }));
    expect(within(screen.getByRole("dialog")).getByText("未提供有效演练分数")).toBeTruthy();
  });
});
