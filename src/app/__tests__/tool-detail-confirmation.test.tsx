// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JdPage from "@/app/tools/jd/[id]/page";
import DecoderPage from "@/app/tools/decoder/[id]/page";
import GapPage from "@/app/tools/gap/[id]/page";
import SalaryPage from "@/app/tools/salary/[id]/page";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { jsonFetch } from "@/lib/fetcher";

const navigation = vi.hoisted(() => ({ id: "1", push: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: navigation.id }), useRouter: () => ({ push: navigation.push }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
const created = "2026-11-01T03:04:05.000Z";
const role = "原岗位 <T> &amp; " + "LongRole_".repeat(30);
const cases = [
  { name: "JD", Page: JdPage, button: "删除画像", title: "删除记录", scope: "原始 JD", data: (id: number) => ({ id, jd: "原始 JD <T> &amp;", result: null, created_at: created }) },
  { name: "解码", Page: DecoderPage, button: "删除报告", title: "删除记录", scope: "原始输入", data: (id: number) => ({ id, source_text: "原始输入 <T> &amp;", result: null, created_at: created }) },
  { name: "空窗", Page: GapPage, button: "删除报告", title: "删除报告", scope: "原始经历", data: (id: number) => ({ id, raw_story: "原始经历 <T> &amp;", target_role: role, persona_style: "composed", scenario_type: "gap", result: null, created_at: created }) },
  { name: "谈薪", Page: SalaryPage, button: "删除", title: "删除博弈记录", scope: "全部对话回合", data: (id: number) => ({ id, revision: "a".repeat(64), target_company_tier: "自定义类型", target_role: role, expected_salary: "30k，奖金待审批", current_or_competing_offer: "尚未签字", hr_style: "standard", status: "ongoing", initial_offer: "", final_package: "", report: null, created_at: created, finished_at: "", turns: [] }) },
] as const;
const deletes = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE");
beforeEach(() => {
  navigation.id = "1";
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); Reflect.deleteProperty(HTMLElement.prototype, "scrollTo"); });

describe.each(cases)("$name 详情删除确认归属", ({ Page, button, title, data, scope, name }) => {
  async function setup() {
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "DELETE") return { ok: true } as never;
      return data(Number(String(url).split("/").at(-1))) as never;
    });
    render(<ConfirmDialogHost />); const view = render(<Page />);
    const trigger = await screen.findByRole("button", { name: button });
    return { ...view, trigger };
  }
  it("离页关闭当前确认，旧入口不能删除或导航", async () => {
    const view = await setup(); fireEvent.click(view.trigger); expect(screen.getByRole("dialog", { name: title })).toBeTruthy();
    view.unmount(); expect(screen.queryByRole("dialog")).toBeNull(); fireEvent.click(view.trigger); await act(async () => {});
    expect(deletes()).toHaveLength(0); expect(navigation.push).not.toHaveBeenCalled();
  });
  it("离页移除排队确认，保留其他当前及后续确认", async () => {
    const view = await setup(); act(() => { void confirmDialog({ title: "当前有效", message: "其他工作" }); }); fireEvent.click(view.trigger);
    act(() => { void confirmDialog({ title: "后续有效", message: "后续工作" }); }); view.unmount(); fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("dialog").textContent).toContain("后续有效"); fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(deletes()).toHaveLength(0);
  });
  it("切换 ID 立即取消原确认，新记录可独立取消", async () => {
    const view = await setup(); fireEvent.click(view.trigger); navigation.id = "2"; view.rerender(<Page />); expect(screen.queryByRole("dialog")).toBeNull();
    const next = await screen.findByRole("button", { name: button }); fireEvent.click(next); fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(deletes()).toHaveLength(0); expect(navigation.push).not.toHaveBeenCalled();
  });
  it.each(["取消", "Escape"])("重复点击仅一次确认，%s 归还触发焦点且零写入", async cancel => {
    const view = await setup(); view.trigger.focus(); act(() => { view.trigger.click(); view.trigger.click(); });
    const dialog = screen.getByRole("dialog", { name: title });
    if (cancel === "Escape") fireEvent.keyDown(document, { key: "Escape" }); else fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(document.activeElement).toBe(view.trigger)); expect(screen.queryByRole("dialog")).toBeNull(); expect(deletes()).toHaveLength(0); expect(navigation.push).not.toHaveBeenCalled();
  });
  it("确认展示固定记录身份、保存时间及实际删除范围", async () => {
    const view = await setup(); fireEvent.click(view.trigger); const dialog = screen.getByRole("dialog", { name: title });
    expect(dialog.textContent).toContain("#1"); expect(dialog.textContent).toContain(created); expect(dialog.textContent).toContain(scope);
    if (name === "谈薪") { expect(dialog.textContent).toContain(role); expect(dialog.textContent).toContain("30k，奖金待审批"); expect(dialog.textContent).toContain("复盘"); }
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "取消" })); });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(deletes()).toHaveLength(0); expect(navigation.push).not.toHaveBeenCalled();
  });
  it("接受后同事件离页，不发送删除或改变下一实例", async () => {
    const view = await setup(); fireEvent.click(view.trigger); act(() => { within(screen.getByRole("dialog", { name: title })).getByRole("button", { name: "删除" }).click(); view.unmount(); });
    navigation.id = "2"; render(<Page />); await screen.findByRole("button", { name: button }); await act(async () => {});
    expect(deletes()).toHaveLength(0); expect(navigation.push).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog")).toBeNull();
  });
});
