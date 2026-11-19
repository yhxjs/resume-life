// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/fetcher";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
const navigation = vi.hoisted(() => ({ id: "1" }));
const confirm = vi.hoisted(() => vi.fn());
vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: api.fetch }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: navigation.id }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: confirm }));
import IntroPage from "@/app/intros/[id]/page";
const version = (revision: string, text = "Original sentence") => ({
  id: 1, resume_id: 1, resume_title: "Synthetic", jd: "", created_at: "",
  resume_version_id: null, resume_version: null, resume_version_name: null,
  versions: [{ kind: "30s", revision, sentences: [{ text, comment: "Synthetic comment" }] }],
});
beforeEach(() => {
  navigation.id = "1";
  confirm.mockReset().mockResolvedValue(true);
  api.fetch.mockReset().mockResolvedValueOnce(version("a".repeat(64)));
});
afterEach(cleanup);

const twoVersions = () => ({
  ...version("a".repeat(64)),
  versions: [
    { kind: "30s", revision: "a".repeat(64), sentences: [
      { text: "短版第一句", comment: "点评" }, { text: "短版第二句", comment: "点评" },
    ] },
    { kind: "2min", revision: "b".repeat(64), sentences: [{ text: "长版第一句", comment: "点评" }] },
  ],
});

async function pendingSave() {
  api.fetch.mockReset().mockResolvedValueOnce(twoVersions());
  render(<IntroPage />);
  fireEvent.click((await screen.findAllByRole("button", { name: "微调" }))[0]!);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "已提交的短版草稿" } });
  const pending = Promise.withResolvers<unknown>();
  api.fetch.mockImplementationOnce(() => pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  return pending;
}

function savedShortVersion() {
  return { kind: "30s", revision: "c".repeat(64), sentences: [
    { text: "已提交的短版草稿", comment: "" }, { text: "短版第二句", comment: "点评" },
  ] };
}

it("sends the loaded revision and keeps the editing draft on conflict", async () => {
  render(<IntroPage />);
  fireEvent.click(await screen.findByRole("button", { name: "微调" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "My draft" } });
  api.fetch.mockRejectedValueOnce(new HttpError("内容已更新", 409));
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await screen.findByText("内容已更新");
  expect(JSON.parse(api.fetch.mock.calls[1]![1].body)).toMatchObject({ baseRevision: "a".repeat(64) });
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("My draft");
});

it("loads a fresh revision without dropping the draft and lets the user explicitly retry", async () => {
  render(<IntroPage />);
  fireEvent.click(await screen.findByRole("button", { name: "微调" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "My draft" } });
  api.fetch.mockRejectedValueOnce(new HttpError("内容已更新", 409));
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await screen.findByText("内容已更新");
  api.fetch.mockResolvedValueOnce(version("b".repeat(64), "Other tab saved"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "获取最新版本（保留草稿）" })));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("My draft");
  api.fetch.mockResolvedValueOnce({ kind: "30s", revision: "c".repeat(64), sentences: [{ text: "My draft", comment: "" }] });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  expect(JSON.parse(api.fetch.mock.calls[3]![1].body)).toMatchObject({ baseRevision: "b".repeat(64) });
});

it("keeps the full pasted draft and reports the 800 character limit without sending an oversized save", async () => {
  render(<IntroPage />);
  fireEvent.click(await screen.findByRole("button", { name: "微调" }));
  const draft = "字".repeat(801);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: draft } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(draft);
  expect(api.fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/每句最多 800 字/)).toBeTruthy();
});

it("keeps the draft after a save validation error from the server", async () => {
  render(<IntroPage />);
  fireEvent.click(await screen.findByRole("button", { name: "微调" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "完整草稿" } });
  api.fetch.mockRejectedValueOnce(new HttpError("每版最多 60 句", 400));
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await screen.findByText("每版最多 60 句");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("完整草稿");
});

it("names each textarea with the selected version and sentence number", async () => {
  api.fetch.mockReset().mockResolvedValueOnce(twoVersions());
  render(<IntroPage />);
  fireEvent.click((await screen.findAllByRole("button", { name: "微调" }))[1]!);
  expect(screen.getByRole("textbox", { name: "30 秒版第 2 句" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "2 分钟版" }));
  fireEvent.click(screen.getByRole("button", { name: "微调" }));
  expect(screen.getByRole("textbox", { name: "2 分钟版第 1 句" })).toBeTruthy();
});

it.each(["another version", "another sentence", "the same sentence after cancellation"])(
  "does not close a new edit of %s when the old save succeeds", async (target) => {
    const pending = await pendingSave();
    if (target === "another version") {
      fireEvent.click(screen.getByRole("button", { name: "2 分钟版" }));
      fireEvent.click(screen.getByRole("button", { name: "微调" }));
    } else if (target === "another sentence") {
      fireEvent.click(screen.getByRole("button", { name: "微调" }));
    } else {
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      fireEvent.click(screen.getAllByRole("button", { name: "微调" })[0]!);
    }
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "新编辑会话的草稿" } });
    await act(async () => pending.resolve(savedShortVersion()));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("新编辑会话的草稿");
    expect((screen.getByRole("button", { name: "保存修改" }) as HTMLButtonElement).disabled).toBe(false);
  }
);

it.each([400, 409, 500])("does not attach an old %s error or conflict to a new editing session", async (status) => {
  const pending = await pendingSave();
  fireEvent.click(screen.getByRole("button", { name: "2 分钟版" }));
  fireEvent.click(screen.getByRole("button", { name: "微调" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "长版新草稿" } });
  await act(async () => pending.reject(new HttpError("旧保存失败", status)));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("长版新草稿");
  expect(screen.queryByText("旧保存失败")).toBeNull();
  expect(screen.queryByRole("button", { name: "获取最新版本（保留草稿）" })).toBeNull();
});

it("keeps text changed in the same editor while a save is pending", async () => {
  const pending = await pendingSave();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "保存期间继续输入" } });
  await act(async () => pending.resolve(savedShortVersion()));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("保存期间继续输入");
});

it("calculates reading time and per-sentence pace from the selected version", async () => {
  api.fetch.mockReset().mockResolvedValueOnce({ ...twoVersions(), versions: [
    { kind: "30s", revision: "a".repeat(64), sentences: [
      { text: "字".repeat(40), comment: "点评" }, { text: "字".repeat(40), comment: "点评" },
    ] },
    { kind: "2min", revision: "b".repeat(64), sentences: [{ text: "字".repeat(240), comment: "点评" }] },
  ] });
  render(<IntroPage />);
  await screen.findByRole("heading", { name: "预估朗读时长" });
  expect(screen.queryByText("00:28.4")).toBeNull();
  expect(screen.getByText(/约 10 秒\/句/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "2 分钟版" }));
  expect(screen.queryByText("01:52.0")).toBeNull();
  expect(screen.getByText(/约 60 秒\/句/)).toBeTruthy();
  expect(screen.getAllByText("约 1 分钟").length).toBeGreaterThan(0);
});


it.each(["save", "comment", "regen"])("切换记录后旧 %s 的成功不显示在新页或清除新页等待", async (command) => {
  const old = Promise.withResolvers<unknown>();
  const nextLoad = Promise.withResolvers<unknown>();
  const nextCommand = Promise.withResolvers<unknown>();
  const { rerender } = render(<IntroPage />);
  await screen.findByRole("button", { name: "微调" });
  api.fetch.mockReturnValueOnce(old.promise);
  if (command === "save") {
    fireEvent.click(screen.getByRole("button", { name: "微调" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A保存草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  } else await act(async () => fireEvent.click(screen.getByRole("button", { name: command === "comment" ? "重新点评整篇" : "重新构思本版" })));
  expect(api.fetch).toHaveBeenCalledTimes(2);
  api.fetch.mockReturnValueOnce(nextLoad.promise);
  navigation.id = "2";
  rerender(<IntroPage />);
  expect(screen.queryByText("Original sentence")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  await act(async () => nextLoad.resolve({ ...version("b".repeat(64), "B的原句"), id: 2 }));
  api.fetch.mockReturnValueOnce(nextCommand.promise);
  fireEvent.click(screen.getByRole("button", { name: "重新点评整篇" }));
  await act(async () => old.resolve({ kind: "30s", revision: "c".repeat(64), sentences: [{ text: "A旧结果", comment: "A旧点评" }] }));
  expect(screen.queryByText("A旧结果")).toBeNull();
  expect(screen.getByText("B的原句")).toBeTruthy();
  expect((screen.getByRole("button", { name: "AI 点评中…" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => nextCommand.resolve({ kind: "30s", revision: "d".repeat(64), sentences: [{ text: "B的原句", comment: "B新点评" }] }));
  expect(screen.getByText("B新点评")).toBeTruthy();
});

it.each(["save", "comment", "regen"])("切换记录后旧 %s 失败不附着新页", async (command) => {
  const old = Promise.withResolvers<unknown>();
  const { rerender } = render(<IntroPage />);
  await screen.findByRole("button", { name: "微调" });
  api.fetch.mockReturnValueOnce(old.promise);
  if (command === "save") {
    fireEvent.click(screen.getByRole("button", { name: "微调" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A保存草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  } else await act(async () => fireEvent.click(screen.getByRole("button", { name: command === "comment" ? "重新点评整篇" : "重新构思本版" })));
  api.fetch.mockResolvedValueOnce({ ...version("b".repeat(64), "B的原句"), id: 2 });
  navigation.id = "2";
  rerender(<IntroPage />);
  await screen.findByText("B的原句");
  await act(async () => old.reject(new HttpError("A旧冲突", 409)));
  expect(screen.queryByText("A旧冲突")).toBeNull();
  expect(screen.queryByRole("button", { name: "获取最新版本（保留草稿）" })).toBeNull();
  expect(screen.getByRole("button", { name: "重新点评整篇" })).toBeTruthy();
});

it("旧确认框在切换记录后批准，不提交旧记录重生成", async () => {
  const confirmation = Promise.withResolvers<boolean>();
  confirm.mockReturnValueOnce(confirmation.promise);
  const { rerender } = render(<IntroPage />);
  fireEvent.click(await screen.findByRole("button", { name: "重新构思本版" }));
  api.fetch.mockResolvedValueOnce({ ...version("b".repeat(64), "B的原句"), id: 2 });
  navigation.id = "2";
  rerender(<IntroPage />);
  await screen.findByText("B的原句");
  await act(async () => confirmation.resolve(true));
  expect(api.fetch).toHaveBeenCalledTimes(2);
});

it("确认期间互斥阻止重复生成、保存和点评，取消后恢复命令入口", async () => {
  const confirmation = Promise.withResolvers<boolean>();
  confirm.mockReturnValueOnce(confirmation.promise);
  render(<IntroPage />);
  fireEvent.click(await screen.findByRole("button", { name: "重新构思本版" }));
  fireEvent.click(screen.getByRole("button", { name: "重新构思本版" }));
  fireEvent.click(screen.getByRole("button", { name: "重新点评整篇" }));
  fireEvent.click(screen.getByRole("button", { name: "微调" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "确认期间保留的草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  expect(api.fetch).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledTimes(1);
  await act(async () => confirmation.resolve(false));
  api.fetch.mockResolvedValueOnce({ kind: "30s", revision: "b".repeat(64), sentences: [{ text: "确认期间保留的草稿", comment: "" }] });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  expect(api.fetch).toHaveBeenCalledTimes(2);
});

it("冲突重读期间切换记录，旧读取不覆盖新记录", async () => {
  const old = Promise.withResolvers<unknown>();
  const { rerender } = render(<IntroPage />);
  fireEvent.click(await screen.findByRole("button", { name: "微调" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "A草稿" } });
  api.fetch.mockRejectedValueOnce(new HttpError("A冲突", 409));
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await screen.findByText("A冲突");
  api.fetch.mockReturnValueOnce(old.promise);
  fireEvent.click(screen.getByRole("button", { name: "获取最新版本（保留草稿）" }));
  api.fetch.mockResolvedValueOnce({ ...version("b".repeat(64), "B的原句"), id: 2 });
  navigation.id = "2";
  rerender(<IntroPage />);
  await screen.findByText("B的原句");
  await act(async () => old.resolve(version("c".repeat(64), "A旧读取")));
  expect(screen.queryByText("A旧读取")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText("B的原句")).toBeTruthy();
});

it("错误记录的初始响应被拒绝并可重读", async () => {
  api.fetch.mockReset().mockResolvedValueOnce({ ...version("a".repeat(64)), id: 2 });
  render(<IntroPage />);
  await screen.findByText("服务器返回的自我介绍记录不完整");
  expect(screen.queryByText("Original sentence")).toBeNull();
  api.fetch.mockResolvedValueOnce(version("b".repeat(64)));
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  await screen.findByText("Original sentence");
});

const badIntroMetadata = [
  { created_at: {} },
  { resume_id: Number.MAX_SAFE_INTEGER + 1 },
  { resume_version_id: "11", resume_version: 2, resume_version_name: "错误绑定" },
  { resume_version_id: 11, resume_version: null, resume_version_name: "错误绑定" },
  { resume_version_id: 11, resume_version: 2, resume_version_name: null },
  { resume_version_id: null, resume_version: 2, resume_version_name: "残留版本" },
];

it.each(badIntroMetadata)("初次读取拒绝损坏的完整元数据 %#，重读有效存档后才开放编辑", async patch => {
  api.fetch.mockReset().mockResolvedValueOnce({ ...version("a".repeat(64)), ...patch });
  render(<IntroPage />);
  await screen.findByText("服务器返回的自我介绍记录不完整");
  expect(screen.queryByText("Original sentence")).toBeNull();
  expect(screen.queryByRole("button", { name: "微调" })).toBeNull();
  api.fetch.mockResolvedValueOnce(version("a".repeat(64)));
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  await screen.findByText("Original sentence");
  expect(api.fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  expect(api.fetch.mock.calls.every(([, options]) => options?.cache === "no-store")).toBe(true);
});

it.each(badIntroMetadata)("冲突重读拒绝损坏元数据 %#，保留原存档与草稿", async patch => {
  render(<IntroPage />);
  fireEvent.click(await screen.findByRole("button", { name: "微调" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "完整未提交草稿" } });
  api.fetch.mockRejectedValueOnce(new HttpError("内容已更新", 409));
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await screen.findByText("内容已更新");
  api.fetch.mockResolvedValueOnce({ ...version("b".repeat(64), "不得采用的正文"), ...patch });
  fireEvent.click(screen.getByRole("button", { name: "获取最新版本（保留草稿）" }));
  await screen.findByText("服务器返回的自我介绍记录不完整");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("完整未提交草稿");
  expect(screen.queryByText("不得采用的正文")).toBeNull();
  api.fetch.mockResolvedValueOnce(version("c".repeat(64), "有效最新存档"));
  fireEvent.click(screen.getByRole("button", { name: "获取最新版本（保留草稿）" }));
  await screen.findByText(/已获取最新版本，草稿已保留/);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("完整未提交草稿");
  expect(api.fetch.mock.calls.filter(([, options]) => options?.method)).toHaveLength(1);
  expect(api.fetch.mock.calls.filter(([, options]) => !options?.method).every(([, options]) => options?.cache === "no-store")).toBe(true);
});

it.each(badIntroMetadata)("写入恢复拒绝损坏元数据 %#，不能据此采用修订或解除待确认锁", async patch => {
  render(<IntroPage />);
  fireEvent.click(await screen.findByRole("button", { name: "微调" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "完整未提交草稿" } });
  api.fetch.mockRejectedValueOnce(new HttpError("写入超时", 408))
    .mockResolvedValueOnce({ ...version("b".repeat(64), "不得采用的正文"), ...patch });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await screen.findByText(/保存状态暂无法确认/);
  expect((screen.getByRole("button", { name: "保存修改" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("完整未提交草稿");
  expect(screen.queryByText("不得采用的正文")).toBeNull();
  api.fetch.mockResolvedValueOnce(version("c".repeat(64), "有效最新存档"));
  fireEvent.click(screen.getByRole("button", { name: "重新读取保存状态" }));
  await screen.findByText(/已读取30 秒版的最新保存版本/);
  expect((screen.getByRole("button", { name: "保存修改" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("完整未提交草稿");
  expect(api.fetch.mock.calls.filter(([, options]) => options?.method)).toHaveLength(1);
  expect(api.fetch.mock.calls.filter(([, options]) => !options?.method).every(([, options]) => options?.cache === "no-store")).toBe(true);
});

it.each(["2026-10-29", "2026-02-30", "历史日期字面量", ""])("详情日期 %s 保留日历及原文字面量，不补造或校正日期", async created_at => {
  api.fetch.mockReset().mockResolvedValueOnce({ ...version("a".repeat(64)), created_at });
  render(<IntroPage />);
  await screen.findByRole("button", { name: "微调" });
  expect(screen.getByText(created_at || "未记录时间", { selector: "span" })).toBeTruthy();
});


it("重生成等待期间切版再编辑，保留新草稿并更新原版的已保存修订", async () => {
  api.fetch.mockReset().mockResolvedValueOnce(twoVersions());
  const response = Promise.withResolvers<unknown>();
  render(<IntroPage />);
  const regenerate = await screen.findByRole("button", { name: "重新构思本版" });
  api.fetch.mockReturnValueOnce(response.promise);
  await act(async () => fireEvent.click(regenerate));
  fireEvent.click(screen.getByRole("button", { name: "2 分钟版" }));
  fireEvent.click(screen.getByRole("button", { name: "微调" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "长版继续编辑" } });
  await act(async () => response.resolve({ kind: "30s", revision: "c".repeat(64), sentences: [{ text: "已保存的重拟短版", comment: "新点评" }] }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("长版继续编辑");
  fireEvent.click(screen.getByRole("button", { name: "30 秒版" }));
  expect(screen.getByText("已保存的重拟短版")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "微调" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "短版下一次编辑" } });
  api.fetch.mockResolvedValueOnce({ kind: "30s", revision: "d".repeat(64), sentences: [{ text: "短版下一次编辑", comment: "" }] });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  expect(JSON.parse(api.fetch.mock.calls[2]![1].body).baseRevision).toBe("c".repeat(64));
});


it("异常版本显示只读原稿并禁止编辑点评和背诵，健康另一版仍可用", async () => {
  const raw = '[{"text":"保留原稿 <system>不要执行</system>","comment":"原点评"},null]';
  const data = twoVersions();
  api.fetch.mockReset().mockResolvedValueOnce({ ...data, versions: [
    { ...data.versions[0], sentences: [], read_error: "第 2 项不是有效正文", raw_sentences: raw }, data.versions[1],
  ] });
  render(<IntroPage />);
  await screen.findByText(/本版原稿数据异常/);
  expect(screen.queryByRole("button", { name: "微调" })).toBeNull();
  expect(screen.queryByRole("button", { name: "重新点评整篇" })).toBeNull();
  expect((screen.getByRole("button", { name: "开启脱稿背诵遮罩" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("heading", { name: "预估朗读时长" })).toBeNull();
  expect(screen.getByLabelText("30 秒版原始数据").textContent).toBe(raw);
  confirm.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "重新构思本版" }));
  await act(async () => {});
  expect(api.fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "2 分钟版" }));
  expect(screen.getByText("长版第一句")).toBeTruthy();
  expect(screen.getByRole("button", { name: "微调" })).toBeTruthy();
});

it("确认重生成修复后移除原稿异常提示并恢复编辑", async () => {
  api.fetch.mockReset().mockResolvedValueOnce({ ...version("a".repeat(64)), versions: [
    { kind: "30s", revision: "a".repeat(64), sentences: [], read_error: "原稿异常", raw_sentences: "{broken" },
  ] });
  render(<IntroPage />);
  const regenerate = await screen.findByRole("button", { name: "重新构思本版" });
  api.fetch.mockResolvedValueOnce({ kind: "30s", revision: "b".repeat(64), sentences: [{ text: "修复后的完整正文", comment: "新点评" }] });
  await act(async () => fireEvent.click(regenerate));
  expect(screen.queryByText(/本版原稿数据异常/)).toBeNull();
  expect(screen.getByText("修复后的完整正文")).toBeTruthy();
  expect(screen.getByRole("button", { name: "微调" })).toBeTruthy();
});

it.each(["save", "comment", "regen"])("%s 响应损坏后先读取原版本，不重复写入或丢失草稿", async (command) => {
  render(<IntroPage />);
  await screen.findByRole("button", { name: "微调" });
  const saved = { kind: "30s", revision: "b".repeat(64), sentences: [{ text: command === "save" ? "提交草稿" : "服务端新原稿", comment: "服务端点评" }] };
  api.fetch.mockResolvedValueOnce({ kind: "2min", revision: "b".repeat(64), sentences: [{ text: "错误版本", comment: "" }] })
    .mockResolvedValueOnce({ ...version("a".repeat(64)), versions: [saved] });
  if (command === "save") {
    fireEvent.click(screen.getByRole("button", { name: "微调" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "提交草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  } else fireEvent.click(screen.getByRole("button", { name: command === "comment" ? "重新点评整篇" : "重新构思本版" }));
  await screen.findByText(/已读取30 秒版的最新保存版本/);
  expect(api.fetch).toHaveBeenCalledTimes(3);
  expect(api.fetch.mock.calls[2]).toEqual(["/api/intros/1", { cache: "no-store" }]);
  expect(screen.queryByText("错误版本")).toBeNull();
  if (command === "save") expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("提交草稿");
  else expect(screen.getByText("服务端新原稿")).toBeTruthy();
});

it("保存状态读取反复失败时只允许重读，切版与继续输入不会解除写锁", async () => {
  const failed = await pendingSave();
  api.fetch.mockRejectedValueOnce(new Error("读取断线"));
  await act(async () => failed.reject(new Error("响应丢失")));
  await screen.findByText(/保存状态暂无法确认/);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("已提交的短版草稿");
  expect((screen.getByRole("button", { name: "保存修改" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "2 分钟版" }));
  fireEvent.click(screen.getByRole("button", { name: "微调" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "长版新草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  fireEvent.click(screen.getByRole("button", { name: "重新构思本版" }));
  const read = Promise.withResolvers<unknown>();
  api.fetch.mockReturnValueOnce(read.promise);
  const retry = screen.getByRole("button", { name: "重新读取保存状态" });
  fireEvent.click(retry);
  fireEvent.click(retry);
  expect(api.fetch).toHaveBeenCalledTimes(4);
  await act(async () => read.resolve({ ...twoVersions(), id: 999 }));
  expect(screen.getByText(/保存状态暂无法确认/)).toBeTruthy();
  api.fetch.mockResolvedValueOnce({ ...twoVersions(), versions: [savedShortVersion(), twoVersions().versions[1]] });
  fireEvent.click(screen.getByRole("button", { name: "重新读取保存状态" }));
  await screen.findByText(/已读取30 秒版的最新保存版本/);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("长版新草稿");
  expect((screen.getByRole("button", { name: "保存修改" }) as HTMLButtonElement).disabled).toBe(false);
  expect(api.fetch.mock.calls.filter((call) => call[1]?.method)).toHaveLength(1);
});

it("读取确认无新修订后保留原错误和草稿，允许显式重试", async () => {
  const failed = await pendingSave();
  api.fetch.mockResolvedValueOnce(twoVersions());
  await act(async () => failed.reject(new Error("请求未到达")));
  await screen.findByText(/尚未读取到新修订：请求未到达/);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("已提交的短版草稿");
  api.fetch.mockResolvedValueOnce(savedShortVersion());
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  expect(JSON.parse(api.fetch.mock.calls[3]![1].body).baseRevision).toBe("a".repeat(64));
});

it.each(["save", "comment", "regen"].flatMap(command =>
  ["changed", "unchanged", "unreadable", "mismatched"].map(result => ({ command, result }))))(
  "$command 收到 408 后只读核对 $result，核对前锁定写入并保留草稿", async ({ command, result }) => {
    api.fetch.mockReset().mockResolvedValueOnce(twoVersions());
    render(<IntroPage />);
    await screen.findAllByRole("button", { name: "微调" });
    const read = Promise.withResolvers<unknown>();
    api.fetch.mockRejectedValueOnce(new HttpError("写入等待超时", 408)).mockReturnValueOnce(read.promise);
    if (command === "save") {
      fireEvent.click(screen.getAllByRole("button", { name: "微调" })[0]!);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "已提交的短版草稿" } });
      fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    } else {
      await act(async () => fireEvent.click(screen.getByRole("button", { name: command === "comment" ? "重新点评整篇" : "重新构思本版" })));
    }
    await waitFor(() => expect(api.fetch).toHaveBeenCalledTimes(3));
    expect(api.fetch.mock.calls[2]).toEqual(["/api/intros/1", { cache: "no-store" }]);
    expect((screen.getByRole("button", { name: /^(重新点评整篇|AI 点评中…)$/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /^(重新构思本版|AI 重拟中…)$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "2 分钟版" }));
    fireEvent.click(screen.getByRole("button", { name: "微调" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "另一版本继续输入的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: /^(保存修改|保存中…)$/ }));
    expect(api.fetch).toHaveBeenCalledTimes(3);
    const latest = { ...twoVersions(), versions: [savedShortVersion(), twoVersions().versions[1]] };
    await act(async () => {
      if (result === "unreadable") read.reject(new HttpError("核对读取失败", 503));
      else read.resolve(result === "unchanged" ? twoVersions() : result === "mismatched" ? { ...latest, id: 999 } : latest);
    });
    if (result === "unreadable" || result === "mismatched") {
      expect(screen.getByText(/保存状态暂无法确认/)).toBeTruthy();
      expect((screen.getByRole("button", { name: "保存修改" }) as HTMLButtonElement).disabled).toBe(true);
      const retry = screen.getByRole("button", { name: "重新读取保存状态" });
      const retryRead = Promise.withResolvers<unknown>();
      api.fetch.mockReturnValueOnce(retryRead.promise);
      fireEvent.click(retry);
      fireEvent.click(retry);
      expect(api.fetch).toHaveBeenCalledTimes(4);
      await act(async () => retryRead.resolve(latest));
    }
    await screen.findByText(result === "unchanged" ? /尚未读取到新修订/ : /已读取30 秒版的最新保存版本/);
    if (result === "unchanged") expect(screen.getByText(/上次请求仍可能稍后完成/)).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("另一版本继续输入的草稿");
    expect((screen.getByRole("button", { name: "保存修改" }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.fetch.mock.calls.filter(call => call[1]?.method)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText("长版第一句")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "30 秒版" }));
    expect(screen.getByText(result === "unchanged" ? "短版第一句" : "已提交的短版草稿")).toBeTruthy();
  }
);

it.each(["missing", "damaged"])("恢复读取的原版本 %s 时继续锁定写入", async (mode) => {
  const failed = await pendingSave();
  api.fetch.mockResolvedValueOnce({ ...twoVersions(), versions: mode === "missing" ? [twoVersions().versions[1]] : [
    { kind: "30s", revision: "c".repeat(64), sentences: [], read_error: "异常", raw_sentences: "{broken" },
  ] });
  await act(async () => failed.reject(new Error("断线")));
  await screen.findByText(/保存状态暂无法确认/);
  expect((screen.getByRole("button", { name: "保存修改" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("已提交的短版草稿");
});

it("恢复读取期间离开记录，旧读取不改变新记录或触发新读取", async () => {
  const failed = await pendingSave();
  const read = Promise.withResolvers<unknown>();
  api.fetch.mockReturnValueOnce(read.promise);
  await act(async () => failed.reject(new Error("断线")));
  cleanup();
  api.fetch.mockResolvedValueOnce({ ...version("b".repeat(64), "新记录"), id: 2 });
  navigation.id = "2";
  render(<IntroPage />);
  await screen.findByText("新记录");
  await act(async () => read.resolve({ ...twoVersions(), versions: [savedShortVersion()] }));
  expect(screen.getByText("新记录")).toBeTruthy();
  expect(screen.queryByText(/最新保存版本/)).toBeNull();
  expect(api.fetch).toHaveBeenCalledTimes(4);
});

it("重生成变短后仍显示等待期间新开的尾句草稿", async () => {
  api.fetch.mockReset().mockResolvedValueOnce(twoVersions());
  render(<IntroPage />);
  await screen.findByRole("button", { name: "重新构思本版" });
  const pending = Promise.withResolvers<unknown>();
  api.fetch.mockReturnValueOnce(pending.promise);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "重新构思本版" })));
  fireEvent.click(screen.getAllByRole("button", { name: "微调" })[1]!);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "未提交的尾句草稿" } });
  await act(async () => pending.resolve({ kind: "30s", revision: "c".repeat(64), sentences: [{ text: "缩短的新版本", comment: "点评" }] }));
  expect((screen.getByRole("textbox", { name: "原编辑位置的保留草稿" }) as HTMLTextAreaElement).value).toBe("未提交的尾句草稿");
  expect(screen.getByText(/最新版本已不含原编辑位置/)).toBeTruthy();
});

it.each(["save", "comment"])("%s 成功响应带错正文时不直接采用，先读存档", async (command) => {
  render(<IntroPage />);
  await screen.findByRole("button", { name: "微调" });
  const read = Promise.withResolvers<unknown>();
  api.fetch.mockResolvedValueOnce({ kind: "30s", revision: "b".repeat(64), sentences: [{ text: "错误正文不得显示", comment: "错误点评" }] })
    .mockReturnValueOnce(read.promise);
  if (command === "save") {
    fireEvent.click(screen.getByRole("button", { name: "微调" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "正确草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  } else fireEvent.click(screen.getByRole("button", { name: "重新点评整篇" }));
  await waitFor(() => expect(api.fetch).toHaveBeenCalledTimes(3));
  expect(screen.queryByText("错误正文不得显示")).toBeNull();
  await act(async () => read.resolve(version("c".repeat(64), "已存档正文")));
  await screen.findByText(/已读取30 秒版的最新保存版本/);
  if (command === "save") expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("正确草稿");
  else expect(screen.getByText("已存档正文")).toBeTruthy();
});
