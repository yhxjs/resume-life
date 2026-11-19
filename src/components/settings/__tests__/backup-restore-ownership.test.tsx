// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupManager } from "../backup-manager";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { jsonFetch } from "@/lib/fetcher";
import { BACKUP_MEDIA_TYPE, encodePasswordHeader } from "../backup-manager-utils";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
const password = "本次恢复密码-2026-安全";
const file = new File(["encrypted fixture"], "原备份 <T> &amp;.rlbackup", { type: BACKUP_MEDIA_TYPE });
const validation = { ok: true, manifest: { kind: "manifest", appName: "resume-life", backupVersion: "1.0.0", dbVersion: 3, createdAt: "2026-11-03T00:00:00Z", tables: ["resumes", "projects"] }, stats: { resumes: 2, projects: 3 }, totalRecords: 5 };
const restored = { ok: true, stats: validation.stats, snapshotCreated: "D:/backups/pre-restore.db" };
const restores = () => vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/backup/restore");
const exports = () => vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/backup/export");
const trigger = () => screen.getByRole("button", { name: "完全覆盖并恢复系统数据" });
const dialog = () => screen.getByRole("dialog", { name: "危险操作：完全覆盖现有数据" });
function accept() { fireEvent.click(within(dialog()).getByRole("button", { name: "确认完全覆盖并恢复" })); }
async function setup(host = true) {
  const view = render(<><BackupManager />{host && <ConfirmDialogHost />}</>);
  fireEvent.change(screen.getByLabelText("备份文件"), { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText("导入密码"), { target: { value: password } });
  await screen.findByText("待恢复备份包详情"); return view;
}
beforeEach(() => {
  vi.mocked(jsonFetch).mockResolvedValue({ ok: true, stats: null });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/backup/validate" ? validation : restored))));
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("备份恢复确认和请求的页面归属", () => {
  it("确认显示已验证文件、时间、数量与配置选择，重复触发只排一个，取消归还焦点且零恢复", async () => {
    await setup(); const button = trigger(); button.focus(); act(() => { button.click(); button.click(); });
    for (const text of [file.name, validation.manifest.createdAt, "5", "保留", "投递", "灾备"]) expect(dialog().textContent).toContain(text);
    expect((screen.getByLabelText("导入密码") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(dialog()).getByRole("button", { name: "取消" })); await waitFor(() => expect(document.activeElement).toBe(button)); expect(screen.queryByRole("dialog")).toBeNull(); expect(restores()).toHaveLength(0);
  });

  it("离页关闭当前确认，新实例Escape不恢复", async () => {
    render(<ConfirmDialogHost />); const old = await setup(false); fireEvent.click(trigger()); old.unmount(); expect(screen.queryByRole("dialog")).toBeNull();
    await setup(false); fireEvent.click(trigger()); fireEvent.keyDown(document, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(restores()).toHaveLength(0);
  });

  it("离页移除排队恢复确认，保留其他有效确认", async () => {
    render(<ConfirmDialogHost />); const old = await setup(false); act(() => { void confirmDialog({ title: "当前有效确认", message: "其他操作" }); });
    fireEvent.click(trigger()); act(() => { void confirmDialog({ title: "后续有效确认", message: "其他后续" }); }); old.unmount();
    fireEvent.click(screen.getByRole("button", { name: "确定" })); expect(screen.getByRole("dialog").textContent).toContain("后续有效确认"); fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(restores()).toHaveLength(0);
  });

  it("同事件确认后离页不继续提交旧恢复", async () => {
    const old = await setup(); fireEvent.click(trigger()); act(() => { accept(); old.unmount(); }); await act(async () => {}); expect(restores()).toHaveLength(0);
  });

  it("旧恢复入口在密码失效后不能使用旧校验提交", async () => {
    await setup(); const button = trigger(); fireEvent.change(screen.getByLabelText("导入密码"), { target: { value: "short" } }); act(() => button.click());
    expect(screen.queryByRole("dialog")).toBeNull(); expect(restores()).toHaveLength(0);
  });

  it("确认和恢复期间不能替换文件、密码或配置，提交绑定已确认快照且成功清理", async () => {
    await setup(); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(trigger());
    fireEvent.change(screen.getByLabelText("导入密码"), { target: { value: "another-password-2026" } }); fireEvent.change(screen.getByLabelText("备份文件"), { target: { files: [new File(["other"], "other.rlbackup")] } }); fireEvent.click(screen.getByRole("checkbox"));
    accept(); await screen.findByText(/数据恢复成功/); expect(restores()).toHaveLength(1); const init = restores()[0]![1]!;
    expect(init.body).toBe(file); expect(init.signal).toBeInstanceOf(AbortSignal); expect(new Headers(init.headers).get("X-Resume-Life-Backup-Password")).toBe(encodePasswordHeader(password)); expect(new Headers(init.headers).get("X-Resume-Life-Preserve-Ai-Config")).toBe("false");
    expect((screen.getByLabelText("导入密码") as HTMLInputElement).value).toBe(""); expect(screen.getByText(restored.snapshotCreated)).toBeTruthy(); expect(screen.queryByText("待恢复备份包详情")).toBeNull();
  });

  it("恢复真实完成但忽略取消的迟到回复不清理新实例，所属请求离页中止", async () => {
    const old = await setup(); const pending = Promise.withResolvers<Response>(); vi.mocked(fetch).mockReturnValueOnce(pending.promise); fireEvent.click(trigger()); accept(); await waitFor(() => expect(restores()).toHaveLength(1));
    const signal = restores()[0]![1]?.signal; old.unmount(); expect(signal?.aborted).toBe(true); await setup(); await act(async () => { pending.resolve(new Response(JSON.stringify(restored))); });
    expect(screen.queryByText(/数据恢复成功/)).toBeNull(); expect((screen.getByLabelText("导入密码") as HTMLInputElement).value).toBe(password); expect(screen.getByText("待恢复备份包详情")).toBeTruthy();
  });

  it.each([400, 413, 429])("明确拒绝%s保留校验和密码，必须再次确认才重试", async status => {
    await setup(); vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "明确拒绝恢复" }), { status })); fireEvent.click(trigger()); accept(); await screen.findByRole("alert");
    expect((screen.getByLabelText("导入密码") as HTMLInputElement).value).toBe(password); fireEvent.click(trigger()); expect(dialog()).toBeTruthy();
    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(trigger().matches(":disabled")).toBe(false); expect(restores()).toHaveLength(1);
  });

  it.each([{}, { ok: "true", ...{ stats: validation.stats, snapshotCreated: "path" } }, { ok: true }, { ...restored, stats: { resumes: 3, projects: 3 } }, { ...restored, snapshotCreated: "" }])("坏恢复完成%j保持未知锁、原稿和密码，不显示成功或自动重发", async result => {
    await setup(); vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(result))); fireEvent.click(trigger()); accept(); await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("恢复结果尚未确认"); expect(screen.queryByText(/数据恢复成功/)).toBeNull(); expect((screen.getByLabelText("导入密码") as HTMLInputElement).value).toBe(password); expect(trigger().matches(":disabled")).toBe(true); expect(restores()).toHaveLength(1);
  });

  it.each([408, 500])("响应%s结果未知，只在核对风险后明确解锁，解锁本身不恢复", async status => {
    await setup(); vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: "恢复响应中断" }), { status })); fireEvent.click(trigger()); accept();
    const allow = await screen.findByRole("button", { name: "核对后允许再次恢复" }); allow.focus(); fireEvent.click(allow); const retry = screen.getByRole("dialog", { name: "允许再次覆盖恢复" }); expect(retry.textContent).toContain("再次覆盖");
    fireEvent.click(within(retry).getByRole("button", { name: "取消" })); await waitFor(() => expect(document.activeElement).toBe(allow)); expect(trigger().matches(":disabled")).toBe(true); expect(restores()).toHaveLength(1);
    fireEvent.click(allow); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "允许再次恢复" })); await waitFor(() => expect(trigger().matches(":disabled")).toBe(false)); expect(restores()).toHaveLength(1); expect((screen.getByLabelText("导入密码") as HTMLInputElement).value).toBe(password);
  });

  it("导出与恢复从同事件互斥，导出等待期间不能确认恢复", async () => {
    await setup(); fireEvent.change(screen.getByLabelText("导出密码"), { target: { value: password } }); fireEvent.change(screen.getByLabelText("确认导出密码"), { target: { value: password } });
    const pending = Promise.withResolvers<Response>(); vi.mocked(fetch).mockReturnValueOnce(pending.promise); act(() => { screen.getByRole("button", { name: "导出加密备份 (.rlbackup)" }).click(); trigger().click(); });
    expect(exports()).toHaveLength(1); expect(restores()).toHaveLength(0); expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("多次恢复触发仅一次POST，确认等待反向阻止导出，成功后等待手动刷新", async () => {
    await setup(); fireEvent.change(screen.getByLabelText("导出密码"), { target: { value: password } }); fireEvent.change(screen.getByLabelText("确认导出密码"), { target: { value: password } });
    const restore = trigger(); const exportButton = screen.getByRole("button", { name: "导出加密备份 (.rlbackup)" }); act(() => { restore.click(); exportButton.click(); restore.click(); });
    expect(dialog().textContent).not.toContain(password); accept(); await screen.findByText(/数据恢复成功/); expect(restores()).toHaveLength(1); expect(exports()).toHaveLength(0); expect(screen.queryByRole("dialog")).toBeNull(); expect(exportButton.matches(":disabled")).toBe(true);
  });

  it("网络结果未知，解锁确认离页关闭，新实例保留自身配置", async () => {
    render(<ConfirmDialogHost />); const old = await setup(false); vi.mocked(fetch).mockRejectedValueOnce(new Error("网络中断")); fireEvent.click(trigger()); accept();
    fireEvent.click(await screen.findByRole("button", { name: "核对后允许再次恢复" })); expect(screen.getByRole("dialog", { name: "允许再次覆盖恢复" })).toBeTruthy(); old.unmount(); expect(screen.queryByRole("dialog")).toBeNull();
    await setup(false); expect(trigger().matches(":disabled")).toBe(false); expect((screen.getByLabelText("导入密码") as HTMLInputElement).value).toBe(password); expect(restores()).toHaveLength(1);
  });

  it.each([null, { ...validation, ok: "true" }, { ...validation, totalRecords: 6 }, { ...validation, stats: { resumes: -1, projects: 6 } }, { ...validation, manifest: { ...validation.manifest, tables: ["resumes", "resumes"] } }, { ...validation, manifest: { ...validation.manifest, appName: "other" } }])("坏校验%j不提供覆盖入口，文件密码保留并可重新验证", async value => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(value))); render(<><BackupManager /><ConfirmDialogHost /></>);
    fireEvent.change(screen.getByLabelText("备份文件"), { target: { files: [file] } }); fireEvent.change(screen.getByLabelText("导入密码"), { target: { value: password } }); await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "完全覆盖并恢复系统数据" })).toBeNull(); expect((screen.getByLabelText("导入密码") as HTMLInputElement).value).toBe(password); expect(restores()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("备份文件"), { target: { files: [new File([file], file.name, { type: file.type })] } }); await screen.findByText("待恢复备份包详情");
  });
});
