import type { ReviewGrade, ReviewMastery, ReviewSchedule } from "./spaced-repetition-card-types";

/** 使用用户所在时区的日历日期，避免 ISO/UTC 截断导致跨日偏差。 */
export function getReviewDate(date = new Date(), timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function addReviewDays(date: string, days: number): string {
  const calendar = new Date(`${date}T00:00:00.000Z`);
  calendar.setUTCDate(calendar.getUTCDate() + days);
  return calendar.toISOString().slice(0, 10);
}

export function getReviewMastery(state: Pick<ReviewSchedule, "review_count" | "repetitions" | "interval_days">): ReviewMastery {
  if (state.review_count === 0) return "new";
  if (state.repetitions === 0) return "relearning";
  if (state.repetitions >= 4 && state.interval_days >= 21) return "mastered";
  return state.repetitions >= 2 ? "familiar" : "learning";
}

/**
 * SM-2：质量分 1/3/4/5，成功间隔 1、6、上次间隔 × EF；遗忘后重新学习。
 * EF 以百分比整数存储，避免浮点误差，也兼容现有只接受安全整数的备份协议。
 * 这是排期启发式，不将掌握程度解释为真实记忆概率。
 * 算法来源：https://super-memory.com/english/ol/sm2.htm
 */
export function scheduleReview(state: ReviewSchedule, grade: ReviewGrade, today: string, reviewedAt: string): ReviewSchedule {
  const quality = { again: 1, hard: 3, good: 4, easy: 5 }[grade];
  const repetitions = grade === "again" ? 0 : state.repetitions + 1;
  const interval = repetitions <= 1 ? 1 : repetitions === 2 ? 6 : Math.ceil(state.interval_days * state.ease_factor / 100);
  const interval_days = Math.min(365, interval);
  const difference = 5 - quality;
  return {
    interval_days,
    ease_factor: Math.max(130, state.ease_factor + 10 - difference * (8 + difference * 2)),
    repetitions,
    review_count: state.review_count + 1,
    lapses: state.lapses + (grade === "again" ? 1 : 0),
    next_review_date: addReviewDays(today, interval_days),
    last_reviewed_at: reviewedAt,
  };
}
