// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationPreparationPage } from "../application-preparation-page";
import { jsonFetch } from "@/lib/fetcher";
import type { ApplicationPreparation } from "@/lib/application-preparation-types";

vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));

function preparation(): ApplicationPreparation {
  const emptyPage = () => ({ items: [], nextCursor: null, total: 0 });
  return {
    application: { id: 8, company: "甲公司", role: "接口开发", stage: "applied", jd: "", resume_id: null } as ApplicationPreparation["application"],
    tasks: [],
    resources: { diagnosis: emptyPage(), intro: emptyPage(), portrait: emptyPage(), interview: emptyPage(), series: emptyPage(), notebook: emptyPage() },
  };
}

beforeEach(() => { vi.mocked(jsonFetch).mockReset(); });
afterEach(cleanup);

it("初次读取失败时聚焦页面错误，保留只读重试入口", async () => {
  vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("资料暂不可用")).mockResolvedValueOnce(preparation());
  render(<ApplicationPreparationPage id="8" />);
  const error = await screen.findByRole("alert");
  expect(error.textContent).toContain("资料暂不可用");
  await waitFor(() => expect(document.activeElement).toBe(error));
  fireEvent.click(within(error).getByRole("button", { name: "重新加载" }));
  await screen.findByRole("heading", { name: "甲公司 · 接口开发" });
  expect(vi.mocked(jsonFetch).mock.calls.map(([url]) => url)).toEqual(Array(2).fill("/api/applications/8/preparation"));
});

it("关联结果未知时弹窗引导关闭核对并禁止重试，关闭后聚焦页面详细错误", async () => {
  vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
    if (init?.method === "POST") throw new Error("本次关联写入失败");
    if (url.includes("candidates=true")) return { items: [{ id: 5, title: "候选画像", summary: "接口岗位", created_at: "", linked: false, resume_id: null, href: "/tools/jd/5" }], nextCursor: null } as never;
    return preparation() as never;
  });
  render(<ApplicationPreparationPage id="8" />);
  fireEvent.click(await screen.findByRole("button", { name: "关联已有JD 考点画像" }));
  const picker = screen.getByRole("dialog", { name: "关联已有JD 考点画像" });
  fireEvent.click(await within(picker).findByRole("button", { name: "关联" }));
  const pickerError = await within(picker).findByRole("alert");
  await waitFor(() => expect(document.activeElement).toBe(pickerError));
  expect(pickerError.textContent).toContain("关联结果尚未确认");
  expect(within(picker).queryByRole("button", { name: "重试关联" })).toBeNull();
  expect((within(picker).getByRole("button", { name: "关联" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(picker).getByRole("button", { name: "关闭" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const pageError = screen.getByRole("alert");
  expect(pageError.textContent).toContain("本次关联写入失败");
  await waitFor(() => expect(document.activeElement).toBe(pageError));
  expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
