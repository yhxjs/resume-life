// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/fetcher";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: api.fetch }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "1" }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: async () => true }));
import IntroPage from "@/app/intros/[id]/page";
const version = (revision: string, text = "Original sentence") => ({
  id: 1, resume_id: 1, resume_title: "Synthetic", jd: "", created_at: "",
  versions: [{ kind: "30s", revision, sentences: [{ text, comment: "Synthetic comment" }] }],
});
beforeEach(() => api.fetch.mockReset().mockResolvedValueOnce(version("a".repeat(64))));
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
