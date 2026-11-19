// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { InterviewScheduleBanner } from "../interview-schedule-banner";

afterEach(cleanup);
const now = new Date("2026-11-04T10:00:00Z").getTime();
const app = (id: number, time: string) => ({ id, company: `公司${id}`, role: "系统开发", jd: "JD", next_interview_at: time });

it("单位按投递记录显示并链接完整日程", () => {
  render(<InterviewScheduleBanner currentTime={now} upcomingInterviews={[app(1, "2026-11-04T10:20:00Z"), app(2, "2026-11-05T10:00:00Z")]} />);
  expect(screen.getByRole("region", { name: "面试排期提醒（2 条投递）" })).toBeTruthy();
  expect(screen.getByText("每条投递仅显示最近一次排期")).toBeTruthy();
  expect(screen.getByRole("link", { name: "查看完整日程" }).getAttribute("href")).toBe("/applications?view=calendar");
  expect(screen.getByText("仅剩 20m")).toBeTruthy();
  expect(screen.getByText("仅剩 24h")).toBeTruthy();
});

it("已到排期不再显示为剩余时间或紧急告警", () => {
  const { container } = render(<InterviewScheduleBanner currentTime={now} upcomingInterviews={[app(1, "2026-11-04T09:59:00Z")]} />);
  expect(screen.getByText("已到排期时间")).toBeTruthy();
  expect(container.querySelector(".bg-danger")).toBeNull();
});

it("无排期不渲染提醒", () => {
  const { container } = render(<InterviewScheduleBanner currentTime={now} upcomingInterviews={[]} />);
  expect(container.firstChild).toBeNull();
});

it("摘要最多列出三条投递，更多记录通过完整日程查看", () => {
  render(<InterviewScheduleBanner currentTime={now} upcomingInterviews={Array.from({ length: 5 }, (_, i) => app(i + 1, "2026-11-04T10:20:00Z"))} />);
  expect(screen.getByRole("region", { name: "面试排期提醒（5 条投递）" }).querySelectorAll(".bg-card")).toHaveLength(3);
  expect(screen.getByText("另有 2 条投递排期，请查看完整日程。")).toBeTruthy();
});
