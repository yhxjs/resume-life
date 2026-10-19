// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { jsonFetch } from "@/lib/fetcher";
import BankPage from "../page";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/hooks/use-cursor-list", () => ({ useCursorList: () => ({
  items: [], nextCursor: null, loadingMore: false, listError: "", failedCursor: null,
  loadMore: vi.fn(), reload: vi.fn(),
}) }));
beforeEach(() => {
  vi.mocked(jsonFetch).mockReset().mockImplementation(async (_url, options) => options?.method === "POST" ? { count: 501 } : []);
});
afterEach(cleanup);

describe("题库导入草稿保护", () => {
  it("超限提示分批且保留完整文本，不发送会被截断的请求", async () => {
    render(<BankPage />);
    const input = screen.getByLabelText("导入考题");
    const text = Array.from({ length: 501 }, (_, i) => `题目 ${i}`).join("\n");
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "导入 501 道考题" }));
    await waitFor(() => expect(screen.getByText("每次最多导入 500 道题，请分批导入", { exact: true })).toBeTruthy());
    expect((input as HTMLTextAreaElement).value).toBe(text);
    expect(vi.mocked(jsonFetch).mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });
  it("按去重后的题数展示待导入数量", () => {
    render(<BankPage />);
    fireEvent.change(screen.getByLabelText("导入考题"), { target: { value: "题一\n 题一 \n题二\n" } });
    expect(screen.getByRole("button", { name: "导入 2 道考题" })).toBeTruthy();
  });
  it("服务器拒绝导入时也保留原文", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (_url, options) => {
      if (options?.method === "POST") throw new Error("服务器拒绝导入");
      return [];
    });
    render(<BankPage />);
    const input = screen.getByLabelText("导入考题");
    fireEvent.change(input, { target: { value: "题一\n题二" } });
    fireEvent.click(screen.getByRole("button", { name: "导入 2 道考题" }));
    await waitFor(() => expect(screen.getByText("服务器拒绝导入")).toBeTruthy());
    expect((input as HTMLTextAreaElement).value).toBe("题一\n题二");
  });
});
