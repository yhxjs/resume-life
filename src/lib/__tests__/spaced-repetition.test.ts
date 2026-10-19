import { describe, expect, it } from "vitest";
import { addReviewDays, getReviewDate, getReviewMastery, scheduleReview } from "../spaced-repetition";
import type { ReviewSchedule } from "../spaced-repetition-card-types";

const initial: ReviewSchedule = {
  interval_days: 0, ease_factor: 250, repetitions: 0, review_count: 0, lapses: 0,
  next_review_date: "2026-09-27", last_reviewed_at: "",
};
const reviewedAt = "2026-09-27T12:00:00.000Z";

describe("SM-2 间隔复习", () => {
  it("成功回忆采用 1 天、6 天、难度倍数的间隔", () => {
    const first = scheduleReview(initial, "good", "2026-09-27", reviewedAt);
    expect(first).toMatchObject({ interval_days: 1, next_review_date: "2026-09-28", repetitions: 1, review_count: 1 });
    const second = scheduleReview(first, "good", "2026-09-28", reviewedAt);
    expect(second.interval_days).toBe(6);
    const third = scheduleReview(second, "good", "2026-10-04", reviewedAt);
    expect(third.interval_days).toBe(15);
    expect(third.next_review_date).toBe("2026-10-19");
  });
  it("遗忘重置连续成功次数、保留总次数，按实际复习日重排", () => {
    const result = scheduleReview({ ...initial, interval_days: 30, repetitions: 4, review_count: 5 }, "again", "2026-10-20", reviewedAt);
    expect(result).toMatchObject({ repetitions: 0, review_count: 6, interval_days: 1, lapses: 1, next_review_date: "2026-10-21" });
    expect(getReviewMastery(result)).toBe("relearning");
  });
  it("吃力降低难度系数，轻松答出提升系数", () => {
    expect(scheduleReview(initial, "hard", "2026-09-27", reviewedAt).ease_factor).toBe(236);
    expect(scheduleReview(initial, "easy", "2026-09-27", reviewedAt).ease_factor).toBe(260);
    expect(scheduleReview({ ...initial, ease_factor: 130 }, "again", "2026-09-27", reviewedAt).ease_factor).toBe(130);
  });
  it("间隔限制为一年，掌握仍保留到期复习", () => {
    const result = scheduleReview({ ...initial, interval_days: 200, repetitions: 8, review_count: 8 }, "easy", "2026-09-27", reviewedAt);
    expect(result.interval_days).toBe(365);
    expect(result.next_review_date).toBe("2027-09-27");
    expect(getReviewMastery(result)).toBe("mastered");
    expect(getReviewMastery(initial)).toBe("new");
  });
  it("日历加天支持跨月、跨年与闰年，不按固定 24 小时推日期", () => {
    expect(addReviewDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addReviewDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addReviewDays("2026-03-08", 1)).toBe("2026-03-09");
  });
  it("今日使用用户时区，避免 UTC 提前或延后一天", () => {
    const instant = new Date("2026-09-27T17:00:00.000Z");
    expect(getReviewDate(instant, "Asia/Shanghai")).toBe("2026-09-28");
    expect(getReviewDate(instant, "America/Los_Angeles")).toBe("2026-09-27");
    expect(() => getReviewDate(instant, "not-a-zone")).toThrow();
  });
});
