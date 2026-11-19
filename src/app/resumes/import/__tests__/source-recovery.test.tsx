// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiFetch } from "@/lib/api-fetch";
import { jsonFetch } from "@/lib/fetcher";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { MODULE_KEYS } from "@/lib/modules";
import { normalizeImportedModule } from "@/lib/resume-import";
import { emptyResumeImportEditor, readResumeImportSession, RESUME_IMPORT_SESSION_KEY, saveResumeImportSession } from "@/lib/resume-import-session";
import ImportPage from "../page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/lib/api-fetch", async original => ({ ...await original<typeof import("@/lib/api-fetch")>(), apiFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.resetAllMocks(); });

const receipt = (letter = "A") => ({ version: 1 as const, id: letter.repeat(43), expiresAt: 1_900_000_000_000 });
const text = '完整原文 <T> &amp; {"tableDocument":{}}，尚未上线。';
const validDraft = () => ({ title: "合成简历", modules: Object.fromEntries(MODULE_KEYS.map(key => [key, normalizeImportedModule(key, undefined)])) });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const parses = () => vi.mocked(apiFetch).mock.calls.filter(([url]) => url === "/api/import/parse");
const discards = () => vi.mocked(apiFetch).mock.calls.filter(([url]) => url === "/api/import/source/discard");
const plainParses = () => vi.mocked(jsonFetch).mock.calls.filter(([url]) => url === "/api/import/parse");
const stored = () => readResumeImportSession()!.editor;
function setup(responses: Response[]) {
  vi.mocked(jsonFetch).mockImplementation(async url => url === "/api/settings/configured" ? { configured: true } : validDraft());
  vi.mocked(apiFetch).mockImplementation(async url => {
    if (url === "/api/import/source/discard") return new Response(null, { status: 204 });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected import request");
    return next;
  });
}
function chooseFile(container: HTMLElement, name = "source.docx") {
  fireEvent.click(screen.getByRole("tab", { name: /上传文件/ }));
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["synthetic"], name)] } });
}
const start = () => fireEvent.click(screen.getByRole("button", { name: "开始智能解析 →" }));
function saveSource() {
  return saveResumeImportSession({ editor: { ...emptyResumeImportEditor(), source: "file", recoveredText: text, sourceReceipt: receipt() }, pending: null });
}

it("同文、模型失败和刷新保留同一回执，刷新不自动解析或清理", async () => {
  setup([response({ extractedText: text, sourceReceipt: receipt() }), response({ error: "合成模型失败", extractedText: text }, 502), response(validDraft())]);
  const first = render(<ImportPage />);
  chooseFile(first.container); start();
  await screen.findByText("合成模型失败");
  expect(stored().sourceReceipt).toEqual(receipt());
  fireEvent.change(screen.getByRole("textbox", { name: "已保留的原文，可直接修改" }), { target: { value: text } });
  first.unmount();
  render(<ImportPage />);
  await screen.findByText(/已恢复当前标签页的导入草稿/);
  expect(parses()).toHaveLength(2); expect(discards()).toHaveLength(0);
  start(); await screen.findByRole("heading", { name: "确认解析草稿" });
  expect(JSON.parse(parses()[2]![1]!.body as string)).toEqual({ text, sourceReceipt: receipt().id });
  expect(stored().sourceReceipt).toEqual(receipt());
  expect(plainParses()).toHaveLength(0);
});

it("改正文后撤销也不恢复旧回执，保存成功后才清理旧来源", async () => {
  saveSource(); setup([]); render(<ImportPage />);
  await screen.findByText(/已恢复当前标签页的导入草稿/);
  const input = screen.getByRole("textbox", { name: "已保留的原文，可直接修改" });
  fireEvent.change(input, { target: { value: text + "修改" } });
  expect(stored().sourceReceipt).toBeNull();
  expect(JSON.parse(discards()[0]![1]!.body as string)).toEqual({ sourceReceipt: receipt().id });
  fireEvent.change(input, { target: { value: text } });
  start(); await screen.findByRole("heading", { name: "确认解析草稿" });
  expect(JSON.parse(plainParses()[0]![1]!.body as string)).toEqual({ text });
  expect(discards()).toHaveLength(1); expect(parses()).toHaveLength(0);
});

it("容量拒绝保存全文和阻塞状态，刷新后也须主动选择普通文本", async () => {
  setup([response({ extractedText: text, error: "来源容量已满", code: "IMPORT_SOURCE_CAPACITY" }, 429)]);
  const first = render(<ImportPage />); chooseFile(first.container); start();
  await screen.findByText("来源容量已满");
  expect(stored()).toMatchObject({ recoveredText: text, sourceReceipt: null, sourceIssue: "unavailable" });
  expect(plainParses()).toHaveLength(0);
  first.unmount(); render(<ImportPage />); await screen.findByText(/已恢复当前标签页的导入草稿/);
  expect(screen.getByRole("button", { name: "开始智能解析 →" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "按普通文本继续" }));
  await screen.findByRole("heading", { name: "确认解析草稿" });
  expect(JSON.parse(plainParses()[0]![1]!.body as string)).toEqual({ text });
  expect(parses()).toHaveLength(1);
});

it.each([[410, "IMPORT_SOURCE_EXPIRED", "expired"], [409, "IMPORT_SOURCE_MISMATCH", "mismatch"]] as const)(
  "%s 来源拒绝不会静默降级，两个显式动作出现并保留原文和回执", async (status, code, issue) => {
    saveSource(); setup([response({ error: "来源需要重新确认", code, extractedText: text }, status)]);
    render(<ImportPage />); await screen.findByText(/已恢复当前标签页的导入草稿/); start();
    await screen.findByText("来源需要重新确认");
    expect(stored()).toMatchObject({ recoveredText: text, sourceReceipt: receipt(), sourceIssue: issue });
    expect(screen.getByRole("button", { name: "重新上传文件" })).toBeTruthy();
    expect(plainParses()).toHaveLength(0); expect(discards()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "按普通文本继续" }));
    await screen.findByRole("heading", { name: "确认解析草稿" });
    expect(plainParses()).toHaveLength(1); expect(parses()).toHaveLength(1); expect(discards()).toHaveLength(1);
  },
);

it("替换文件暂存失败保留旧存储来源，后续成功保存才释放旧回执", async () => {
  const original = saveSource();
  setup([response({ extractedText: text + "新文件", sourceReceipt: receipt("B") }), response(validDraft())]);
  const page = render(<ImportPage />); await screen.findByText(/已恢复当前标签页的导入草稿/);
  chooseFile(page.container, "replacement.docx");
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("模拟存储已满"); });
  start(); await screen.findByText(/已保留页面内原文，但暂存失败/);
  expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(original);
  expect((screen.getByRole("textbox", { name: "已保留的原文，可直接修改" }) as HTMLTextAreaElement).value).toBe(text + "新文件");
  expect(discards()).toHaveLength(0); expect(parses()).toHaveLength(1);
  write.mockRestore(); start(); await screen.findByRole("heading", { name: "确认解析草稿" });
  expect(stored().sourceReceipt).toEqual(receipt("B"));
  expect(discards()).toHaveLength(1);
  expect(JSON.parse(discards()[0]![1]!.body as string)).toEqual({ sourceReceipt: receipt().id });
  expect(JSON.parse(parses()[1]![1]!.body as string).sourceReceipt).toBe(receipt("B").id);
});

it("新文件提取失败保留旧来源，迟到回包不能继续解析或提前清理", async () => {
  const original = saveSource(); setup([response({ error: "新文件损坏" }, 422)]);
  const page = render(<ImportPage />); await screen.findByText(/已恢复当前标签页的导入草稿/);
  chooseFile(page.container, "broken.docx"); start(); await screen.findByText("新文件损坏");
  expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(original); expect(discards()).toHaveLength(0);
  const pending = Promise.withResolvers<Response>(); vi.mocked(apiFetch).mockReturnValueOnce(pending.promise);
  start(); page.unmount();
  await act(async () => pending.resolve(response({ extractedText: text + "迟到", sourceReceipt: receipt("B") })));
  expect(parses()).toHaveLength(2); expect(discards()).toHaveLength(0);
  expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(original);
});

it("另一恢复记录替换导致CAS失败时不清理旧来源、不覆盖新记录", async () => {
  saveSource(); setup([]); render(<ImportPage />); await screen.findByText(/已恢复当前标签页的导入草稿/);
  const foreign = saveResumeImportSession({ editor: { ...emptyResumeImportEditor(), recoveredText: "其他原文", sourceReceipt: receipt("B") }, pending: null });
  fireEvent.change(screen.getByRole("textbox", { name: "已保留的原文，可直接修改" }), { target: { value: "页面内修改" } });
  await screen.findByText(/暂存失败：导入恢复记录已改变/);
  expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(foreign); expect(discards()).toHaveLength(0);
  start(); expect(parses()).toHaveLength(0); expect(plainParses()).toHaveLength(0);
});

it("清除取消不释放，确认成功删除本标签页记录后才释放", async () => {
  saveSource(); setup([]); render(<ImportPage />); await screen.findByText(/已恢复当前标签页的导入草稿/);
  vi.mocked(confirmDialog).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  fireEvent.click(screen.getByRole("button", { name: "清除导入暂存" }));
  await waitFor(() => expect(vi.mocked(confirmDialog)).toHaveBeenCalledOnce());
  expect(discards()).toHaveLength(0); expect(stored().sourceReceipt).toEqual(receipt());
  fireEvent.click(screen.getByRole("button", { name: "清除导入暂存" }));
  await waitFor(() => expect(discards()).toHaveLength(1));
  expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBeNull();
});

it("清除确认期间换入另一恢复记录，旧确认不能释放任何来源", async () => {
  saveSource(); setup([]); render(<ImportPage />); await screen.findByText(/已恢复当前标签页的导入草稿/);
  const confirmed = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(confirmed.promise);
  fireEvent.click(screen.getByRole("button", { name: "清除导入暂存" }));
  const foreign = saveResumeImportSession({ editor: { ...emptyResumeImportEditor(), recoveredText: "其他来源", sourceReceipt: receipt("B") }, pending: null });
  await act(async () => confirmed.resolve(true));
  await screen.findByText(/无法清除导入暂存：导入恢复记录已改变/);
  expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(foreign); expect(discards()).toHaveLength(0);
});

it("带来源草稿的pending创建仅提交原创建协议，不把回执放入简历内容", async () => {
  saveResumeImportSession({ editor: { ...emptyResumeImportEditor(), source: "file", recoveredText: text,
    sourceReceipt: receipt(), draft: validDraft() }, pending: null });
  setup([]);
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockImplementation(async url => url === "/api/settings/configured" ? { configured: true } : pending.promise);
  const page = render(<ImportPage />); await screen.findByRole("heading", { name: "确认解析草稿" });
  fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
  await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.some(([url]) => url === "/api/resumes")).toBe(true));
  const call = vi.mocked(jsonFetch).mock.calls.find(([url]) => url === "/api/resumes")![1]!;
  expect(JSON.parse(call.body as string)).toEqual(validDraft());
  expect(call.body).not.toContain(receipt().id);
  const session = readResumeImportSession()!;
  expect(session.editor.sourceReceipt).toEqual(receipt());
  expect(session.pending).toMatchObject({ receipt: true, snapshot: validDraft() });
  expect(new Headers(call.headers).get("Idempotency-Key")).toBe(session.pending!.token);
  const raw = sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY);
  page.unmount(); await act(async () => pending.resolve({ id: 42 }));
  expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw); expect(discards()).toHaveLength(0);
});

it("损坏恢复数据只在展示时脱敏，实际CAS仍使用原始字符串", async () => {
  const raw = JSON.stringify({ version: 1, generation: "initial", editor: { sourceReceipt: receipt() } });
  sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, raw); setup([]); render(<ImportPage />);
  const view = await screen.findByRole("textbox", { name: "原始导入恢复数据" });
  expect((view as HTMLTextAreaElement).value).not.toContain(receipt().id);
  expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
});
