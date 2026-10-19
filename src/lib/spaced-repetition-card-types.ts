/** 复习进度，不代表真实记忆概率；此文件可由客户端安全导入。 */
export type ReviewGrade = "again" | "hard" | "good" | "easy";
export type ReviewMastery = "new" | "relearning" | "learning" | "familiar" | "mastered";
export type ReviewSource = "notebook" | "remedial";
export type ReviewSchedule = {
  interval_days: number;
  ease_factor: number;
  repetitions: number;
  review_count: number;
  lapses: number;
  next_review_date: string;
  last_reviewed_at: string;
};
export type ReviewCard = ReviewSchedule & {
  id: number;
  source: ReviewSource;
  source_id: number;
  source_label: string;
  question: string;
  mastery: ReviewMastery;
};
export type ReviewAttempt = {
  id: number;
  answer: string;
  grade: ReviewGrade;
  reviewed_at: string;
  interval_days: number;
  next_review_date: string;
};
export type ReviewDetail = ReviewCard & {
  answer: string;
  reference: string;
  comment: string;
  attempts: ReviewAttempt[];
  nextCursor: string | null;
};
export type ReviewSummary = {
  date: string;
  total: number;
  due: number;
  notebook: number;
  remedial: number;
  overdue: number;
  completed_today: number;
};
export type ReviewList = { items: ReviewCard[]; nextCursor: string | null; summary: ReviewSummary };
export const REVIEW_GRADE_LABELS: Record<ReviewGrade, string> = {
  again: "忘记了", hard: "有些吃力", good: "基本掌握", easy: "轻松答出",
};
export const REVIEW_MASTERY_LABELS: Record<ReviewMastery, string> = {
  new: "未复习", relearning: "待重新巩固", learning: "学习中", familiar: "较熟悉", mastered: "已掌握",
};
