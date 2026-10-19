// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarInterviewCard } from "../calendar-view/calendar-interview-card";
import { WeekCalendarGrid } from "../calendar-view/week-calendar-grid";
import { AgendaListView } from "../calendar-view/agenda-list-view";
import { ApplicationCalendarView } from "../calendar-view/application-calendar-view";
import { type Application, type CalendarInterviewEvent } from "@/lib/applications-types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Calendar view components", () => {
  const mockEvent: CalendarInterviewEvent = {
    id: 1,
    application_id: 10,
    company: "字节跳动",
    role: "高级前端工程师",
    salary_range: "35k-50k",
    round_name: "技术二面",
    interview_time: "2026-09-23T14:30:00.000Z",
    status: "scheduled",
    interviewer: "王架构师",
    location: "腾讯会议 (ID: 999-888-777)",
    meeting_url: "https://meeting.tencent.com/dm/test",
    reminder_minutes: 30,
    notes: "系统设计与并发优化",
    jd: "React Next.js Node.js",
    resume_id: 1,
    interview_id: null,
    interview_series_id: null,
    stage: "interview",
    preparation_tasks: [
      { id: 101, title: "复习系统设计高并发", done: false, due_time: "2026-09-23T12:00:00.000Z", created_at: "" },
    ],
  };

  const mockApp: Application = {
    id: 10,
    company: "字节跳动",
    role: "高级前端工程师",
    flow_status: "active", batch_name: "", hiring_stage: null, stage_changed_at: "", terminal_stage: null, terminal_reason: "", terminal_at: "",
    salary_range: "35k-50k",
    stage: "interview",
    resume_id: 1,
    jd: "React Next.js Node.js",
    interview_id: null,
    interview_series_id: null,
    next_interview_at: "2026-09-23T14:30:00.000Z",
    notes: "系统设计与并发优化",
    created_at: "",
    updated_at: "",
    interviews: [
      {
        id: 1,
        application_id: 10,
        round_name: "技术二面",
        interview_time: "2026-09-23T14:30:00.000Z",
        status: "scheduled",
        interviewer: "王架构师",
        notes: "系统设计与并发优化",
        created_at: "",
        updated_at: "",
      },
    ],
  };

  it("renders CalendarInterviewCard with company, round name, interviewer, location, meeting url, and mock interview link", () => {
    const html = renderToStaticMarkup(<CalendarInterviewCard event={mockEvent} currentTime={0} />);
    expect(html).toContain("字节跳动");
    expect(html).toContain("高级前端工程师");
    expect(html).toContain("技术二面");
    expect(html).toContain("王架构师");
    expect(html).toContain("腾讯会议 (ID: 999-888-777)");
    expect(html).toContain("https://meeting.tencent.com/dm/test");
    expect(html).toContain("进入会议");
    expect(html).toContain("待面试");
    expect(html).toContain("模考");
    expect(html).toContain("/interviews?applicationId=10");
    expect(html).toContain("导出此场面试到外部日历 (.ics)");
    expect(html).toContain("紧迫准备");
    expect(html).toContain("复习系统设计高并发");
  });

  it("renders WeekCalendarGrid with 7 weekday columns", () => {
    const weekDays = [
      new Date(2026, 8, 21),
      new Date(2026, 8, 22),
      new Date(2026, 8, 23),
      new Date(2026, 8, 24),
      new Date(2026, 8, 25),
      new Date(2026, 8, 26),
      new Date(2026, 8, 27),
    ];
    const eventsByDay = new Map<string, CalendarInterviewEvent[]>();
    eventsByDay.set("2026-09-23", [mockEvent]);

    const html = renderToStaticMarkup(
      <WeekCalendarGrid weekDays={weekDays} eventsByDay={eventsByDay} currentTime={0} />
    );
    expect(html).toContain("周一");
    expect(html).toContain("周三");
    expect(html).toContain("周日");
    expect(html).toContain("字节跳动");
    expect(html).toContain("1场");
  });

  it("renders AgendaListView with upcoming sections", () => {
    // 设置为未来的时间，确保归入待进行面试分组
    const futureTime = new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString();
    const futureEvent = { ...mockEvent, interview_time: futureTime };
    const html = renderToStaticMarkup(<AgendaListView events={[futureEvent]} currentTime={0} />);
    expect(html).toContain("待进行面试 (1)");
    expect(html).toContain("字节跳动");

  });

  it("renders ApplicationCalendarView shell with week navigation buttons and export calendar button", () => {
    const scheduledNow = new Date().toISOString();
    const currentWeekApp = { ...mockApp, next_interview_at: scheduledNow,
      interviews: mockApp.interviews!.map((interview) => ({ ...interview, interview_time: scheduledNow })) };
    const html = renderToStaticMarkup(
      <ApplicationCalendarView applications={[currentWeekApp]} />
    );
    expect(html).toContain("上周");
    expect(html).toContain("本周");
    expect(html).toContain("下周");
    expect(html).toContain("导出日历");
    expect(html).toContain("周日历");
    expect(html).toContain("议程清单");
    expect(html).toContain("本周 1 场面试");
  });

  it("到期后自动更新紧迫提示，但不改变用户选中的参考周", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
    const scheduledNow = new Date().toISOString();
    const currentApp = {
      ...mockApp,
      interviews: mockApp.interviews!.map((interview) => ({ ...interview, interview_time: scheduledNow })),
      preparation_tasks: [{ id: 101, title: "演示待办", done: false, due_time: "2026-09-30T10:00:30Z", created_at: "" }],
    };
    render(<ApplicationCalendarView applications={[currentApp]} />);
    expect(screen.getByText(/本周 1 场面试/)).toBeDefined();
    expect(screen.getAllByText(/即将截止/)).toHaveLength(2);
    fireEvent.click(screen.getByTitle("查看下一周"));
    expect(screen.getByText(/本周 0 场面试/)).toBeDefined();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText(/已逾期/)).toBeDefined();
    expect(screen.getByText(/本周 0 场面试/)).toBeDefined();
  });

  it("保持挂载时更新卡片倒计时、截止提示和议程历史分类", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
    const currentApp = {
      ...mockApp,
      interviews: mockApp.interviews!.map((interview) => ({ ...interview, interview_time: "2026-09-30T10:20:00Z", reminder_minutes: 15 })),
      preparation_tasks: [{ id: 101, title: "准备示例", done: false, due_time: "2026-09-30T10:00:30Z", created_at: "" }],
    };
    render(<ApplicationCalendarView applications={[currentApp]} />);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText(/仅剩 20m/)).toBeDefined();
    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(screen.getByText(/仅剩 15m/)).toBeDefined();
    expect(screen.getAllByText(/已逾期/).length).toBe(2);
    act(() => vi.advanceTimersByTime(16 * 60_000));
    expect(screen.queryByText(/仅剩/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /议程清单/ }));
    expect(screen.getByText("待进行面试 (1)")).toBeDefined();
    act(() => vi.advanceTimersByTime(121 * 60_000));
    expect(screen.getByText("待进行面试 (0)")).toBeDefined();
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("跨本地午夜更新今天标记且保持参考周", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 30, 23, 59, 30));
    render(<ApplicationCalendarView applications={[]} />);
    act(() => vi.advanceTimersByTime(1));
    const todayColumn = () => screen.getByText("今天").closest(".min-h-\\[380px\\]");
    expect(todayColumn()?.textContent).toContain("30");
    act(() => vi.advanceTimersByTime(60_000));
    expect(todayColumn()?.textContent).toContain("1");
    expect(screen.getByText(/2026年9月28日 - 10月4日/)).toBeDefined();
  });
});
