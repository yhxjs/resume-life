// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import Page from "../page";
import { SALARY_CREATION_STORAGE_KEY, savePendingSalaryCreation } from "@/lib/salary-creation-storage";
import { COMPANY_TIER_OPTIONS, HR_STYLE_OPTIONS } from "@/lib/salary-negotiation";

const list = vi.hoisted(() => ({ items: [] as Record<string, unknown>[] | null, loading: false, error: "", reload: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: list.push }) }));
vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
vi.mock("@/hooks/use-cursor-list", () => ({ useCursorList: () => ({ items: list.items, total: list.items?.length ?? null, loading: list.loading,
  nextCursor: null, loadingMore: false, listError: list.error, failedCursor: null, loadMore: vi.fn(), reload: list.reload }) }));

beforeEach(() => { list.items = []; list.loading = false; list.error = ""; });
afterEach(() => { cleanup(); sessionStorage.clear(); vi.resetAllMocks(); });

function saved(id = 7) {
  return { id, revision: "a".repeat(64), target_company_tier: "top_tech", target_role: "接口工程师", expected_salary: "税前30k，薪数待确认", current_or_competing_offer: "口头条件 <T> &amp;\n奖金未确认",
    hr_style: "standard", status: "ongoing", initial_offer: "模拟开价，未确认", final_package: "", report: null, created_at: "2026-10-29", finished_at: "", turns_count: 1,
    turns: [{ id: id * 10, negotiation_id: id, turn_no: 1, user_message: "", hr_response: "模拟开场，先核对薪数", hr_tactics: "澄清",
      hr_mindset: { looseness: 20, current_attitude: "模拟态度", estimated_package: "模拟方案", tactics_label: "核实", internal_pressure: "模拟预算" },
      mentor_analysis: { user_argument_score: 5, strengths: ["已提供期望"], vulnerabilities: ["保证薪数未知"], tactical_tips: "先核对保证现金",
        suggested_replies: [{ title: "核对", content: "请确认保证薪数", rationale: "区分保证与浮动" }] }, created_at: "2026-10-29" }] };
}
function fill() {
  fireEvent.change(screen.getByRole("textbox", { name: "目标岗位与职级（必填）" }), { target: { value: "  接口工程师  " } });
  fireEvent.change(screen.getByRole("textbox", { name: "期望薪资目标（必填）" }), { target: { value: "  税前30k，薪数待确认  " } });
  fireEvent.change(screen.getByRole("textbox", { name: "已有竞品 Offer 或当前薪资（谈判底牌 / 筹码）" }), { target: { value: "  口头条件 <T> &amp;\n奖金未确认  " } });
}
function start() { return screen.getByRole("button", { name: "开局！进入薪资博弈对决" }); }
function requestReceipt(id = 7) {
  const { requestId } = JSON.parse(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)!);
  return { request_id: requestId, status: "succeeded", id };
}

describe("谈薪创建与历史操作", () => {
  it("企业与 HR 卡片展示共用练习描述，三种风格仍可选择", () => {
    render(<Page />);
    for (const tier of COMPANY_TIER_OPTIONS) expect(screen.getByText(tier.desc)).toBeTruthy();
    expect(screen.getAllByText("练习重点：")).toHaveLength(3);
    for (const style of HR_STYLE_OPTIONS) {
      expect(screen.getByText(style.persona)).toBeTruthy();
      expect(screen.getByText(style.practiceFocus)).toBeTruthy();
      const radio = screen.getByRole("radio", { name: style.label }) as HTMLInputElement;
      fireEvent.click(radio);
      expect(radio.checked).toBe(true);
    }
  });

  it("相同背景的旧演练不能因创建响应串 ID 被认领，核对请求回执后仅进入实际新记录", async () => {
    list.items = [saved(8)];
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 8 }).mockImplementationOnce(async () => requestReceipt())
      .mockImplementationOnce(async () => requestReceipt()).mockResolvedValueOnce(saved());
    render(<Page />); fill(); fireEvent.click(start());
    await screen.findByText(/创建响应与请求回执记录不符/);
    expect(list.push).not.toHaveBeenCalled(); expect((start() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "删除" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "目标岗位与职级（必填）" }) as HTMLInputElement).value).toBe("  接口工程师  ");
    expect(vi.mocked(jsonFetch).mock.calls.some(([url]) => url.endsWith("/8"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "重新读取创建结果" }));
    await waitFor(() => expect(list.push).toHaveBeenCalledExactlyOnceWith("/tools/salary/7"));
    expect(list.items).toEqual([saved(8)]);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([url]) => url.includes("/requests/"))).toHaveLength(2);
  });

  it("刷新恢复提交背景与选项，保留锁，仅按请求编号读取后导航", async () => {
    const requestId = crypto.randomUUID();
    const snapshot = { target_company_tier: "自定义企业 <T>", target_role: "接口工程师", expected_salary: "税前30k，薪数待确认",
      current_or_competing_offer: "口头条件 <T> &amp;\n奖金未确认", hr_style: "pressure" as const };
    savePendingSalaryCreation({ requestId, snapshot }); render(<Page />);
    await screen.findByText(/已恢复上次创建请求/);
    expect((screen.getByRole("textbox", { name: "自定义公司类型或特点" }) as HTMLInputElement).value).toBe(snapshot.target_company_tier);
    expect((screen.getByRole("textbox", { name: "目标岗位与职级（必填）" }) as HTMLInputElement).value).toBe(snapshot.target_role);
    expect((screen.getByRole("radio", { name: "施压挑刺型" }) as HTMLInputElement).checked).toBe(true);
    expect((start() as HTMLButtonElement).disabled).toBe(true); expect(jsonFetch).not.toHaveBeenCalled();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ request_id: requestId, status: "succeeded", id: 7 }).mockResolvedValueOnce({ ...saved(), ...snapshot });
    fireEvent.click(screen.getByRole("button", { name: "重新读取创建结果" }));
    await waitFor(() => expect(list.push).toHaveBeenCalledExactlyOnceWith("/tools/salary/7"));
    expect(vi.mocked(jsonFetch).mock.calls.every(([, init]) => init?.method === undefined)).toBe(true);
  });

  it("薪酬谈判校验必填项，按清理后的自定义公司、原始条件和风格提交，核对存档后才导航", async () => {
    render(<Page />); fireEvent.click(start());
    expect(screen.getByRole("alert", { name: "谈薪创建状态" }).textContent).toContain("请填写目标岗位与期望薪资"); expect(jsonFetch).not.toHaveBeenCalled();
    fill(); fireEvent.click(screen.getByRole("button", { name: /^自定义企业/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "自定义公司类型或特点" }), { target: { value: "  民营独角兽 <T>  " } });
    fireEvent.click(screen.getByRole("radio", { name: "施压挑刺型" }));
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 7 }).mockImplementationOnce(async () => requestReceipt()).mockResolvedValueOnce({ ...saved(), target_company_tier: "民营独角兽 <T>", hr_style: "pressure" });
    fireEvent.click(start()); await waitFor(() => expect(list.push).toHaveBeenCalledExactlyOnceWith("/tools/salary/7"));
    expect(vi.mocked(jsonFetch).mock.calls[0]).toEqual(["/api/tools/salary-negotiations", expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal), body: JSON.stringify({
      target_company_tier: "民营独角兽 <T>", target_role: "接口工程师", expected_salary: "税前30k，薪数待确认", current_or_competing_offer: "口头条件 <T> &amp;\n奖金未确认", hr_style: "pressure",
    }) })]);
    expect(vi.mocked(jsonFetch).mock.calls[1]).toEqual([expect.stringMatching(/\/requests\//), expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) })]);
    expect(vi.mocked(jsonFetch).mock.calls[2]).toEqual(["/api/tools/salary-negotiations/7", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) })]);
    expect((start() as HTMLButtonElement).disabled).toBe(true); expect(jsonFetch).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/也不保证涨薪/)).toBeTruthy(); expect(screen.queryByText(/谈出最优 Package/)).toBeNull();
  });

  it("创建与核对期间锁定完整表单和删除入口，重复点击只 POST 一次", async () => {
    list.items = [saved(8)]; const write = Promise.withResolvers<unknown>(); const read = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(write.promise).mockImplementationOnce(async () => requestReceipt()).mockReturnValueOnce(read.promise);
    render(<Page />); fill(); fireEvent.click(start());
    fireEvent.click(screen.getByRole("button", { name: "正在推演 HR 初始出招与首轮解盘…" }));
    expect(jsonFetch).toHaveBeenCalledOnce();
    for (const input of screen.getAllByRole("textbox")) expect((input as HTMLInputElement).disabled).toBe(true);
    for (const radio of screen.getAllByRole("radio")) expect((radio as HTMLInputElement).disabled).toBe(true);
    for (const button of screen.getAllByRole("button").filter((item) => item.getAttribute("aria-pressed") !== null)) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "删除" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { write.resolve({ id: 7 }); });
    expect(screen.getByRole("status").textContent).toContain("正在核对已保存的创建结果");
    expect(list.push).not.toHaveBeenCalled();
    await act(async () => { read.resolve(saved()); }); expect(list.push).toHaveBeenCalledExactlyOnceWith("/tools/salary/7");
  });

  it("有效 ID 却串背景不导航；每次重试回执和详情，不丢失完整表单或再次 POST", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 7 }).mockImplementationOnce(async () => requestReceipt()).mockResolvedValueOnce({ ...saved(), expected_salary: "另一份薪资" })
      .mockImplementationOnce(async () => requestReceipt()).mockResolvedValueOnce(saved());
    render(<Page />); fill(); fireEvent.click(start());
    await screen.findByRole("button", { name: "重新读取创建结果" }); expect(list.push).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("背景不符"); expect((start() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "目标岗位与职级（必填）" }) as HTMLInputElement).value).toBe("  接口工程师  ");
    fireEvent.click(screen.getByRole("button", { name: "重新读取创建结果" }));
    await waitFor(() => expect(list.push).toHaveBeenCalledExactlyOnceWith("/tools/salary/7"));
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(vi.mocked(jsonFetch).mock.calls.slice(1).every(([url, init]) => (url.includes("/requests/") || url === "/api/tools/salary-negotiations/7") && init?.cache === "no-store" && !init.method)).toBe(true);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([url]) => url.includes("/requests/"))).toHaveLength(2);
  });

  it.each([null, { id: "7" }, new Error("断连"), new HttpError("暂不可用", 503)])("缺少创建 ID 的结果 %# 保留表单；历史失败不能放开重建，恢复后仍需显式确认", async (response) => {
    if (response instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(response); else vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    list.reload.mockImplementation(() => { list.items = null; list.loading = true; });
    const view = render(<Page />); fill(); fireEvent.click(start());
    const acknowledge = await screen.findByRole("button", { name: "已核对历史，允许再次创建" });
    expect((acknowledge as HTMLButtonElement).disabled).toBe(true); expect((start() as HTMLButtonElement).disabled).toBe(true);
    expect(list.reload).toHaveBeenCalledOnce(); expect(list.push).not.toHaveBeenCalled();
    list.loading = false; list.error = "历史读取失败"; view.rerender(<Page />);
    expect((acknowledge as HTMLButtonElement).disabled).toBe(true); fireEvent.click(acknowledge); expect(jsonFetch).toHaveBeenCalledOnce();
    list.error = ""; list.items = [saved()]; view.rerender(<Page />);
    expect((acknowledge as HTMLButtonElement).disabled).toBe(false); expect((start() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("link", { name: "继续谈判" }).getAttribute("href")).toBe("/tools/salary/7");
    fireEvent.click(acknowledge); expect((start() as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("textbox", { name: "已有竞品 Offer 或当前薪资（谈判底牌 / 筹码）" }) as HTMLTextAreaElement).value).toBe("  口头条件 <T> &amp;\n奖金未确认  ");
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it("明确的输入拒绝保留表单并允许修正，不自动刷新历史", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("背景超预算", 400)); render(<Page />); fill(); fireEvent.click(start());
    await screen.findByText("背景超预算"); expect((start() as HTMLButtonElement).disabled).toBe(false); expect(list.reload).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "期望薪资目标（必填）" }) as HTMLInputElement).value).toBe("  税前30k，薪数待确认  ");
  });

  it("删除确认等待即互斥所有删除和创建；取消不发请求，保留输入", async () => {
    list.items = [saved(), saved(8)]; const pending = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(pending.promise);
    render(<Page />); fill(); fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]!);
    for (const button of screen.getAllByRole("button", { name: "删除" })) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((start() as HTMLButtonElement).disabled).toBe(true); fireEvent.click(start()); expect(jsonFetch).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(false); }); expect((start() as HTMLButtonElement).disabled).toBe(false); expect(jsonFetch).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "目标岗位与职级（必填）" }) as HTMLInputElement).value).toBe("  接口工程师  ");
    expect(confirmDialog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "确定删除谈薪演练 #7「接口工程师」？删除后所有谈判回合及复盘将一并清除。" }));
  });

  it("删除损坏响应和串记录只读恢复；确认不存在后旧列表也不能复活或重删该记录", async () => {
    list.items = [saved(), { ...saved(8), target_role: "另一条演练" }]; vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(saved(8)).mockRejectedValueOnce(new HttpError("不存在", 404));
    render(<Page />); fill(); fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]!);
    await screen.findByRole("button", { name: "重新读取删除状态" }); expect((start() as HTMLButtonElement).disabled).toBe(true);
    expect(list.reload).not.toHaveBeenCalled(); expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" }));
    await waitFor(() => expect(list.reload).toHaveBeenCalledOnce());
    expect(screen.queryByRole("link", { name: "接口工程师" })).toBeNull(); expect(screen.getByRole("link", { name: "另一条演练" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(1); expect((start() as HTMLButtonElement).disabled).toBe(false);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    expect((screen.getByRole("textbox", { name: "目标岗位与职级（必填）" }) as HTMLInputElement).value).toBe("  接口工程师  ");
  });
});
