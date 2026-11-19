// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnoseDialog } from "../diagnose-dialog";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { jsonFetch } from "@/lib/fetcher";
import type { ModuleData } from "@/lib/modules";
import type { DiagnosisHistoryResponse } from "@/lib/diagnosis";

const { flush } = vi.hoisted(() => ({ flush: vi.fn<() => Promise<void>>() }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/resume-save-queue", () => ({ getResumeSaveQueue: () => ({ flush, needsUnloadWarning: false }) }));
vi.mock("@/hooks/use-resume-options", () => ({ useResumeOptions: () => ({ resumes: [], resumesError: "", reloadResumes: vi.fn() }) }));
const modules: ModuleData[] = [{ key: "skills", type: "skills", label: "技术技能 <T> &amp;", sort: 1, content: { items: ["当前技能", "尚未上线"] } }];
const response: DiagnosisHistoryResponse = {
  current: { id: 7, job_id: "job-a", job_title: "历史岗位 <T> &amp; " + "LongRole_".repeat(30), jd: "JD", resume_version_id: 41, created_at: "2026-11-01T01:02:03.000Z", adoptions: [],
    resume_snapshot: { title: "简历", modules: [{ ...modules[0]!, content: { items: ["诊断时旧技能"] } }] },
    report: { match: 7, summary: "报告", modules: [{ moduleKey: "skills", label: "技术技能", scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "核对技能",
      suggestions: [{ itemId: "", field: "items", reason: "仅采纳属实内容", draft: ["React", "TypeScript"] }] }] } },
  previous: null, history: [],
};
beforeEach(() => {
  flush.mockReset().mockResolvedValue(undefined); vi.mocked(jsonFetch).mockReset().mockResolvedValue(response);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const writes = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method);
async function setup() {
  render(<ConfirmDialogHost />); const onApply = vi.fn(() => true);
  const view = render(<DiagnoseDialog resumeId="4" modules={modules} onApply={onApply} />);
  fireEvent.click(screen.getByRole("button", { name: "JD 诊断" })); const trigger = await screen.findByRole("button", { name: "采纳写入" });
  return { ...view, trigger, onApply };
}
async function start(trigger: HTMLElement) {
  trigger.focus(); fireEvent.click(trigger); return screen.findByRole("dialog", { name: "确认替换当前内容" });
}

describe("诊断覆盖确认的简历会话归属", () => {
  it.each(["卸载", "切换简历"])("%s 时立即关闭当前确认，旧入口不能再写入", async action => {
    const view = await setup(); await start(view.trigger);
    if (action === "卸载") view.unmount(); else view.rerender(<DiagnoseDialog resumeId="5" modules={modules} onApply={view.onApply} />);
    expect(screen.queryByRole("dialog", { name: "确认替换当前内容" })).toBeNull();
    fireEvent.click(view.trigger); await act(async () => {}); expect(view.onApply).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  });
  it.each(["卸载", "切换简历"])("%s 移除排队确认并保留其他操作", async action => {
    const view = await setup(); act(() => { void confirmDialog({ title: "其他当前操作", message: "当前" }); });
    fireEvent.click(view.trigger); await waitFor(() => expect(flush).toHaveBeenCalledOnce()); await act(async () => {});
    act(() => { void confirmDialog({ title: "其他后续操作", message: "后续" }); });
    if (action === "卸载") view.unmount(); else view.rerender(<DiagnoseDialog resumeId="5" modules={modules} onApply={view.onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "确定" })); expect(screen.getByRole("dialog").textContent).toContain("其他后续操作");
    fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(view.onApply).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  });
  it.each(["取消", "Escape"])("重复点击只一次确认，%s 返回采纳按钮焦点并保留草稿", async cancel => {
    const view = await setup(); const draft = screen.getByRole("textbox", { name: "改写草稿" }); fireEvent.change(draft, { target: { value: "待核实 <T> &amp;\n内部  空格" } });
    const dialog = await start(view.trigger); fireEvent.click(view.trigger);
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    if (cancel === "Escape") fireEvent.keyDown(document, { key: "Escape" }); else fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(view.trigger);
      expect(screen.queryByRole("dialog", { name: "确认替换当前内容" })).toBeNull();
    });
    expect((draft as HTMLTextAreaElement).value).toBe("待核实 <T> &amp;\n内部  空格");
    expect(view.onApply).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  });
  it("确认展示简历、报告、岗位和目标模块，且没有 AI 诊断遮罩", async () => {
    const view = await setup(); const dialog = await start(view.trigger);
    expect(dialog.textContent).toContain("简历 #4"); expect(dialog.textContent).toContain("诊断 #7"); expect(dialog.textContent).toContain(response.current!.job_title);
    expect(dialog.textContent).toContain(modules[0]!.label); expect(dialog.textContent).toContain("全部技能"); expect(screen.queryByText("AI 简历诊断中…")).toBeNull();
    expect(screen.queryByText("正在保存并同步诊断记录…")).toBeNull();
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "取消" })); });
    expect(view.trigger.hasAttribute("disabled")).toBe(false); expect(view.onApply).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  });
  it("接受与离页同事件时不写入简历或记录采纳", async () => {
    const view = await setup(); const dialog = await start(view.trigger);
    act(() => { within(dialog).getByRole("button", { name: "确认采纳" }).click(); view.unmount(); }); await act(async () => {});
    expect(view.onApply).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  });
  it("确认取消后可以独立重试，确认才写一次并记一次采纳", async () => {
    const view = await setup(); let dialog = await start(view.trigger); fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(view.trigger.hasAttribute("disabled")).toBe(false)); dialog = await start(view.trigger); fireEvent.click(within(dialog).getByRole("button", { name: "确认采纳" }));
    await waitFor(() => expect(writes()).toHaveLength(1)); expect(view.onApply).toHaveBeenCalledOnce(); expect(view.onApply).toHaveBeenCalledWith("skills", "", "items", ["React", "TypeScript"]);
  });
  it("空草稿提示也随页面取消，重复点击只排一项", async () => {
    const view = await setup(); fireEvent.change(screen.getByRole("textbox", { name: "改写草稿" }), { target: { value: "  " } });
    act(() => { view.trigger.click(); view.trigger.click(); }); expect(screen.getByRole("dialog", { name: "无法采纳" })).toBeTruthy(); view.unmount();
    expect(screen.queryByRole("dialog")).toBeNull(); expect(flush).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  });
  it("采纳排空草稿时提示保存，确认期间移除工作遮罩", async () => {
    const view = await setup(); const pending = Promise.withResolvers<void>(); flush.mockReturnValueOnce(pending.promise);
    fireEvent.click(view.trigger); expect(screen.getByText("正在保存并同步诊断记录…")).toBeTruthy(); expect(screen.queryByText("AI 简历诊断中…")).toBeNull();
    await act(async () => pending.resolve()); const dialog = screen.getByRole("dialog", { name: "确认替换当前内容" });
    expect(screen.queryByText("正在保存并同步诊断记录…")).toBeNull();
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "取消" })); });
    expect(view.trigger.hasAttribute("disabled")).toBe(false);
    expect(view.onApply).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  });
  it.each(["目标修改", "目标删除", "其他模块修改"])("真实确认期间%s，接受前仍核对最新目标", async change => {
    const view = await setup(); const dialog = await start(view.trigger);
    const next = change === "目标修改" ? [{ ...modules[0]!, content: { items: ["后来编辑，不能覆盖"] } }] : change === "目标删除" ? []
      : [...modules, { ...modules[0]!, key: "skills-other", content: { items: ["其他新内容"] } }];
    view.rerender(<DiagnoseDialog resumeId="4" modules={next} onApply={view.onApply} />);
    fireEvent.click(within(dialog).getByRole("button", { name: "确认采纳" }));
    if (change === "其他模块修改") { await waitFor(() => expect(writes()).toHaveLength(1)); expect(view.onApply).toHaveBeenCalledOnce(); }
    else { expect((await screen.findByRole("alert")).textContent).toContain(change === "目标修改" ? "确认期间目标内容已变化" : "目标模块或条目已被删除"); expect(view.onApply).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0); }
  });
});
