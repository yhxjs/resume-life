// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-resume-options", () => ({ useResumeOptions: () => ({
  resumes: [{ id: 1, title: "参考简历", versions: [{ id: 11, version: 1, name: "发布版" }] }],
  resumesError: "", reloadResumes: vi.fn(),
}) }));

const row = (id: number) => ({ id, jd: `岗位 ${id}`, resume_title: "参考简历", created_at: "2026-10-29", resume_version_id: 11, resume_version: 1, resume_version_name: "发布版" });
const first = { items: Array.from({ length: 50 }, (_, index) => row(60 - index)), nextCursor: "11", total: 52 };
const settle = () => act(() => vi.advanceTimersByTimeAsync(1));
function install(pages: unknown[]) {
  const fetch = vi.fn(async (url: string) => {
    if (!url.startsWith("/api/intros")) throw new Error(`意外请求：${url}`);
    return Response.json(pages.shift());
  });
  vi.stubGlobal("fetch", fetch); return fetch;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("自我介绍历史列表边界", () => {
  it.each([{ created_at: null }, { resume_version_id: 0 }, { resume_version: null }, { resume_version_name: 3 }])("首页坏条目整页拒绝，重读保留 JD 草稿 %#", async invalid => {
    install([{ items: [row(60), { ...row(59), ...invalid }], nextCursor: null }, { items: [row(60)], nextCursor: null }]);
    render(<Page />);
    const input = screen.getByRole("textbox", { name: "目标岗位要求（JD / 职位描述）" });
    fireEvent.change(input, { target: { value: "  未提交 <T> &amp;\n内部  空格  " } }); await settle();
    expect(screen.queryByRole("link", { name: "岗位 60" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("自我介绍历史响应");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" })); await settle();
    expect(screen.getByRole("link", { name: "岗位 60" })).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("  未提交 <T> &amp;\n内部  空格  ");
  });

  it("重复续页不能部分追加；修复后仍请求原游标", async () => {
    const fetch = install([first, { items: [row(11), row(10)], nextCursor: null }, { items: [row(10), row(9)], nextCursor: null }]);
    render(<Page />); await settle();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" })); await settle();
    expect(screen.queryByRole("link", { name: "岗位 10" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("自我介绍历史响应");
    fireEvent.click(screen.getByRole("button", { name: "重试加载更多" })); await settle();
    expect(screen.getByRole("link", { name: "岗位 9" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetch.mock.calls[1]![0]).toBe(fetch.mock.calls[2]![0]);
  });

  it("历史日期字面量保留，空历史明确显示且不假冒读取失败", async () => {
    install([{ items: [{ ...row(60), created_at: "旧时间 <T> &amp;" }], nextCursor: null }]);
    const view = render(<Page />); await settle();
    expect(screen.getByText("旧时间 <T> &amp;")).toBeTruthy(); expect(screen.queryByText("Invalid Date")).toBeNull();
    view.unmount(); install([{ items: [], nextCursor: null, total: 0 }]); render(<Page />); await settle();
    expect(screen.getByText("尚无自我介绍历史，生成后会显示在这里。")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
