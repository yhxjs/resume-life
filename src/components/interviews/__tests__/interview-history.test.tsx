// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InterviewHistory } from "../interview-history";
import type { useInterviewsPage } from "@/hooks/use-interviews-page";

afterEach(cleanup);

it("历史加载与失败期间搜索框持续可用，空结果只在完整读取后提示", () => {
  const onKeywordChange = vi.fn();
  const props = {
    items: null, seriesItems: null, loadError: "", onRetry: vi.fn(),
    itemsHasMore: false, itemsLoadingMore: false, itemsLoadFailed: false, onLoadMoreItems: vi.fn(),
    seriesHasMore: false, seriesLoadingMore: false, seriesLoadFailed: false, onLoadMoreSeries: vi.fn(),
    keyword: "旧查询", onKeywordChange, onRemove: vi.fn(), onRemoveSeries: vi.fn(),
    deletion: { busy: false, canStart: () => true,
      single: { phase: "idle", target: null, error: "", notice: "", deletedIds: new Set<number>(), busy: false, canStart: () => true, remove: vi.fn(), retryCheck: vi.fn() },
      series: { phase: "idle", target: null, error: "", notice: "", deletedIds: new Set<number>(), busy: false, canStart: () => true, remove: vi.fn(), retryCheck: vi.fn() },
    } satisfies ReturnType<typeof useInterviewsPage>["deletion"],
  };
  const view = render(<InterviewHistory {...props} />);
  expect(screen.getAllByRole("status")).toHaveLength(1);
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索面试记录" }), { target: { value: "新查询" } });
  expect(onKeywordChange).toHaveBeenCalledWith("新查询");
  expect(screen.queryByText(/没有匹配的面试记录/)).toBeNull();
  view.rerender(<InterviewHistory {...props} keyword="新查询" loadError="新查询读取失败" />);
  expect(screen.getByRole("searchbox", { name: "搜索面试记录" })).toBeTruthy();
  expect(screen.queryByText(/没有匹配的面试记录/)).toBeNull();
  view.rerender(<InterviewHistory {...props} keyword="新查询" items={[]} seriesItems={[]} />);
  expect(screen.getByText(/没有匹配的面试记录/)).toBeTruthy();
  view.rerender(<InterviewHistory {...props} keyword="" />);
  expect(screen.getByRole("searchbox", { name: "搜索面试记录" })).toBeTruthy();
});
