// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
const navigation = vi.hoisted(() => ({ id: "1" }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: api.fetch }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: navigation.id }), useSearchParams: () => new URLSearchParams() }));
import IntroPage from "@/app/intros/[id]/page";
import { confirmDialog, ConfirmDialogHost } from "@/components/common/confirm-dialog";

const version = (id: number) => ({
  id, resume_id: 1, resume_title: `简历 ${id}`, jd: "", created_at: "",
  resume_version_id: null, resume_version: null, resume_version_name: null,
  versions: [{ kind: "30s", revision: "a".repeat(64), sentences: [{ text: `原始正文 ${id}`, comment: "点评" }] }],
});
const Shell = ({ showPage = true }) => <><ConfirmDialogHost />{showPage && <IntroPage />}</>;

beforeEach(() => {
  navigation.id = "1";
  api.fetch.mockReset().mockImplementation((url: string) => Promise.resolve(version(Number(url.split("/").at(-1)))));
});
afterEach(cleanup);

it.each(["离开页面", "切换记录"])("%s 会关闭当前重生成确认，并保留其他有效确认", async target => {
  const page = render(<Shell />);
  fireEvent.click(await screen.findByRole("button", { name: "重新构思本版" }));
  expect(screen.getByRole("dialog").textContent).toContain("重新生成30 秒版");
  let next!: Promise<boolean>;
  act(() => { next = confirmDialog({ message: "其他有效操作" }); });

  navigation.id = "2";
  await act(async () => { page.rerender(<Shell showPage={target === "切换记录"} />); });

  expect(screen.getByRole("dialog").textContent).toContain("其他有效操作");
  expect(screen.queryByText("重新生成30 秒版")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(await next).toBe(true);
  expect(api.fetch.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
});

it.each(["离开页面", "切换记录"])("%s 会移除排队中的旧重生成确认，不影响当前确认", async target => {
  const page = render(<Shell />);
  const regenerate = await screen.findByRole("button", { name: "重新构思本版" });
  let first!: Promise<boolean>;
  act(() => { first = confirmDialog({ message: "当前有效操作" }); });
  fireEvent.click(regenerate);
  expect(screen.getByRole("dialog").textContent).toContain("当前有效操作");

  navigation.id = "2";
  await act(async () => { page.rerender(<Shell showPage={target === "切换记录"} />); });
  expect(screen.getByRole("dialog").textContent).toContain("当前有效操作");
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(await first).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.fetch.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
});

it("StrictMode 下取消后可再次确认，当前记录只提交一次重生成", async () => {
  render(<StrictMode><Shell /></StrictMode>);
  fireEvent.click(await screen.findByRole("button", { name: "重新构思本版" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "取消" })); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.fetch.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);

  api.fetch.mockResolvedValueOnce({ kind: "30s", revision: "b".repeat(64), sentences: [{ text: "重新生成的正文", comment: "新点评" }] });
  fireEvent.click(screen.getByRole("button", { name: "重新构思本版" }));
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  await screen.findByText("重新生成的正文");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toEqual([
    ["/api/intros/1/regenerate", expect.objectContaining({ body: JSON.stringify({ kind: "30s", baseRevision: "a".repeat(64) }) })],
  ]);
});
