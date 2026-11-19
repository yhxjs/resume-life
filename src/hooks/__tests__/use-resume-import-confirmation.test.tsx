// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { useResumeImportCreation } from "../use-resume-import-creation";
import Page from "@/app/resumes/import/page";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { MODULE_KEYS, normalizeContent } from "@/lib/modules";
import { RESUME_IMPORT_SESSION_KEY, saveResumeImportSession } from "@/lib/resume-import-session";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
const text = "原始导入 <T> &amp;\n内部  空格";
const draft = { title: "导入标题 <T> &amp;", modules: Object.fromEntries(MODULE_KEYS.map(key => [key, normalizeContent(key, key === "summary" ? { text } : undefined)])) };
const editor = { source: "paste" as const, text, recoveredText: null, ocrInfo: null, manualDraft: false, draft };
type Action = "discard" | "allowRetry";
function seed(action: Action) { return saveResumeImportSession({ editor, pending: action === "allowRetry" ? { token: "00000000-0000-4000-8000-000000000001", snapshot: draft, receipt: true } : null }); }
const title = (action: Action) => action === "discard" ? "清除导入暂存" : "允许再次创建简历";
const confirmText = (action: Action) => action === "discard" ? "清除暂存" : "允许再次创建";
const posts = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST");
async function setup(action: Action, initialize = true) {
  if (initialize) seed(action);
  const navigate = vi.fn(); const onRestore = vi.fn(); const hook = renderHook(() => useResumeImportCreation(navigate, { getEditor: () => editor, onRestore }));
  await waitFor(() => expect(action === "discard" ? hook.result.current.canStart() : hook.result.current.phase === "unknown").toBe(true));
  if (action === "allowRetry") { act(() => hook.result.current.reread()); await waitFor(() => expect(hook.result.current.recovery).toEqual([])); }
  onRestore.mockClear(); return { ...hook, navigate, onRestore };
}
beforeEach(() => {
  sessionStorage.clear(); vi.mocked(jsonFetch).mockImplementation(async url => { if (String(url).includes("/requests/")) throw new HttpError("回执不可读", 503); return (url === "/api/settings/configured" ? { configured: true } : []) as never; });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe.each(["discard", "allowRetry"] as const)("导入 %s 确认归属", action => {
  it("离页关闭当前确认并结算等待，旧入口零写入且保留暂存", async () => {
    render(<ConfirmDialogHost />); const old = await setup(action); const raw = sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY); const methods = old.result.current; const settled = vi.fn();
    act(() => { void methods[action]().then(settled); }); expect(screen.getByRole("dialog", { name: title(action) })).toBeTruthy(); old.unmount(); expect(screen.queryByRole("dialog")).toBeNull(); await waitFor(() => expect(settled).toHaveBeenCalledOnce());
    await act(async () => { await methods[action](); }); expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw); expect(old.navigate).not.toHaveBeenCalled(); expect(old.onRestore).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
  });
  it("离页移除排队确认，保留其他当前确认与有效后续项", async () => {
    render(<ConfirmDialogHost />); const old = await setup(action); const raw = sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY); const settled = vi.fn(); act(() => { void confirmDialog({ title: "当前有效", message: "其他工作" }); void old.result.current[action]().then(settled); void confirmDialog({ title: "后续有效", message: "后续工作" }); });
    old.unmount(); await waitFor(() => expect(settled).toHaveBeenCalledOnce()); fireEvent.click(screen.getByRole("button", { name: "确定" })); expect(screen.getByRole("dialog").textContent).toContain("后续有效"); fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
  });
  it("接受后同事件离页不清旧草稿，也不解锁或覆盖新实例", async () => {
    render(<ConfirmDialogHost />); const old = await setup(action); const settled = vi.fn(); act(() => { void old.result.current[action]().then(settled); }); act(() => { screen.getByRole("button", { name: confirmText(action) }).click(); old.unmount(); });
    const raw = seed("allowRetry"); const next = await setup("allowRetry", false); await waitFor(() => expect(settled).toHaveBeenCalledOnce()); expect(next.result.current.locked).toBe(true); expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw); expect(posts()).toHaveLength(0); expect(next.navigate).not.toHaveBeenCalled();
  });
  it.each(["取消", "Escape"])("真实页面%s归还焦点，原稿和核对信息保留，重复点击仅一次确认", async cancel => {
    const raw = seed(action); render(<><Page /><ConfirmDialogHost /></>);
    if (action === "allowRetry") { const reread = await screen.findByRole("button", { name: "重新读取导入结果" }); fireEvent.click(reread); await screen.findByText("当前列表为空；原请求仍可能稍后完成。"); }
    const trigger = await screen.findByRole("button", { name: action === "discard" ? "清除导入暂存" : "已核对，允许再次创建" }); trigger.focus(); act(() => { trigger.click(); trigger.click(); });
    const dialog = screen.getByRole("dialog", { name: title(action) }); if (cancel === "Escape") fireEvent.keyDown(document, { key: "Escape" }); else fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger)); expect(screen.queryByRole("dialog")).toBeNull(); expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw); expect(posts()).toHaveLength(0); if (action === "allowRetry") expect(screen.getByRole("textbox", { name: "简历标题" }).matches(":disabled")).toBe(true);
  });
});

it("解析从同事件开始后，旧清除入口不能清稿或排确认", async () => {
  saveResumeImportSession({ editor: { ...editor, draft: null }, pending: null }); const pending = Promise.withResolvers<typeof draft>();
  vi.mocked(jsonFetch).mockImplementation(async url => (url === "/api/import/parse" ? pending.promise : { configured: true }) as never);
  const view = render(<><Page /><ConfirmDialogHost /></>); const parse = await screen.findByRole("button", { name: "开始智能解析 →" }); const clear = screen.getByRole("button", { name: "清除导入暂存" });
  await waitFor(() => expect((screen.getByRole("textbox", { name: "简历原文" }) as HTMLTextAreaElement).value).toBe(text));
  act(() => { parse.click(); clear.click(); }); expect(screen.queryByRole("dialog")).toBeNull(); expect(vi.mocked(jsonFetch).mock.calls.filter(([url]) => url === "/api/import/parse")).toHaveLength(1); expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toContain("原始导入");
  view.unmount(); await act(async () => { pending.resolve(draft); }); expect(vi.mocked(jsonFetch).mock.calls.filter(([url]) => url === "/api/resumes")).toHaveLength(0);
});
