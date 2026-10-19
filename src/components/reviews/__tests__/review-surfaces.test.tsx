import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TodayReviews } from "../today-reviews";
import { ReviewWorkbench } from "../review-workbench";
import { useReviewList } from "../use-review-list";
import { useCursorList } from "@/hooks/use-cursor-list";
import NotebookPage from "@/app/notebook/page";
import type { ReviewCard, ReviewList } from "@/lib/spaced-repetition-card-types";

vi.mock("../use-review-list", () => ({ useReviewList: vi.fn() }));
vi.mock("@/hooks/use-cursor-list", () => ({ useCursorList: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
const card: ReviewCard = { id: 301, source: "notebook", source_id: 91, source_label: "缓存追练", question: "如何处理缓存一致性？", mastery: "learning", interval_days: 1, ease_factor: 2.5, repetitions: 1, review_count: 1, lapses: 0, next_review_date: "2026-09-26", last_reviewed_at: "2026-09-25T10:00:00Z" };
const data: ReviewList = { items: [card], nextCursor: "next-list", summary: { date: "2026-09-27", total: 3, due: 2, notebook: 1, remedial: 1, overdue: 1, completed_today: 1 } };
const result = () => ({ data, loading: false, loadingMore: false, error: "", reload: vi.fn(), loadMore: vi.fn() });

beforeEach(() => { vi.clearAllMocks(); vi.mocked(useReviewList).mockReturnValue(result()); });

describe("复习入口与工作台", () => {
  it("首页展示今日到期与逾期、来源数量和少量题目预览", () => {
    const html = renderToStaticMarkup(<TodayReviews />);
    expect(html).toContain("今日待复习");
    expect(html).toContain("错题 1"); expect(html).toContain("追练 1"); expect(html).toContain("逾期 1");
    expect(html).toContain(card.question); expect(html).toContain("/reviews?card=301");
  });

  it("首页拉取失败不能显示今日已完成，提供重试入口", () => {
    vi.mocked(useReviewList).mockReturnValue({ ...result(), data: null, error: "读取失败" });
    const html = renderToStaticMarkup(<TodayReviews />);
    expect(html).toContain("读取失败"); expect(html).toContain("重试"); expect(html).not.toContain("今日复习已完成");
  });

  it("今日无到期题时明确完成状态，全部为空时引导收藏", () => {
    const empty = { ...data, items: [], nextCursor: null, summary: { ...data.summary, due: 0, overdue: 0, notebook: 0, remedial: 0 } };
    vi.mocked(useReviewList).mockReturnValue({ ...result(), data: empty });
    expect(renderToStaticMarkup(<TodayReviews />)).toContain("今日复习已完成");
    vi.mocked(useReviewList).mockReturnValue({ ...result(), data: { ...empty, summary: { ...empty.summary, total: 0 } } });
    expect(renderToStaticMarkup(<TodayReviews />)).toContain("收藏错题");
  });

  it("统一工作台默认今日，保留来源过滤、排期状态和分页", () => {
    const html = renderToStaticMarkup(<ReviewWorkbench initialCardId={null} />);
    expect(vi.mocked(useReviewList).mock.calls[0]?.[0]).toMatchObject({ scope: "due", source: "all" });
    for (const copy of ["复习工作台", "今日到期", "全部题目", "复习来源", "学习中", "2026-09-26", "加载更多"]) expect(html).toContain(copy);
  });

  it("错题卡保留展开温习，同时提供掌握状态和间隔复习入口", () => {
    vi.mocked(useCursorList).mockReturnValue({
      items: [{ id: 91, category_id: null, category_name: null, source: "drill", source_label: "缓存追练", question: card.question, answer: "旧答案", comment: "", reference: "参考", scores: null, created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z", review_card_id: 301, review_mastery: "learning", next_review_date: "2026-09-26" }],
      nextCursor: null, loadingMore: false, listError: "", failedCursor: undefined, loadMore: vi.fn(), reload: vi.fn(),
    } as never);
    const html = renderToStaticMarkup(<NotebookPage />);
    expect(html).toContain("展开温习"); expect(html).toContain("/reviews?card=301"); expect(html).toContain("学习中"); expect(html).toContain("2026-09-26");
    expect(html).not.toContain("旧答案");
  });
});
