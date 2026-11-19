// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DrillPage from "@/app/drills/[id]/page";
import { jsonFetch } from "@/lib/fetcher";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "72" }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/components/notebook", () => ({ NotebookStarButton: () => null }));

afterEach(() => { cleanup(); vi.resetAllMocks(); });

beforeEach(() => {
  vi.mocked(jsonFetch).mockResolvedValue({
    id: 72, source: "interview", focus: "缓存一致性", questions: [{
      id: 91, idx: 1, question: "如何处理缓存一致性？", answer: "历史回答秘密", reference: "参考答案秘密",
      comment: "批改点评秘密", scores: null, answered_at: "2026-09-25T08:00:00Z", kind: "tech",
      notebook_id: null, review_card_id: 301, review_mastery: "learning", next_review_date: "2026-09-27",
    }],
  });
});

describe("已答追练的独立回忆", () => {
  it("普通重答从空白开始，答案、点评和参考完全不进入重答视图", async () => {
    render(<DrillPage />);
    const start = await screen.findByRole("button", { name: "重答本题 ↺" });
    expect(screen.getByText("历史回答秘密", { exact: true })).toBeTruthy();
    expect(screen.getByText("参考答案秘密", { exact: true })).toBeTruthy();
    expect(screen.getByText("批改点评秘密", { exact: true })).toBeTruthy();
    fireEvent.click(start);
    expect((screen.getByRole("textbox", { name: "重新回忆并作答：" }) as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("历史回答秘密", { exact: true })).toBeNull();
    expect(screen.queryByText("参考答案秘密", { exact: true })).toBeNull();
    expect(screen.queryByText("批改点评秘密", { exact: true })).toBeNull();
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it("已答追练展示掌握状态与独立复习入口", async () => {
    render(<DrillPage />);
    expect((await screen.findByRole("link", { name: "开始间隔复习" })).getAttribute("href")).toBe("/reviews?card=301");
    expect(screen.getByText(/学习中/)).toBeTruthy();
    expect(screen.getByText("2026-09-27", { exact: true })).toBeTruthy();
  });
});
