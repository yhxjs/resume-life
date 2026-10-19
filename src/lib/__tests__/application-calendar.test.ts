import { describe, expect, it } from "vitest";
import {
  extractCalendarEvents,
  formatWeekTitle,
  getInterviewUrgency,
  getMondayOfWeek,
  getWeekDays,
  groupEventsByDay,
  isSameDay,
} from "@/lib/application-calendar";
import { type Application } from "@/lib/applications-types";

describe("application-calendar domain utils", () => {
  it("calculates Monday of week correctly (handling Sunday as end of week)", () => {
    // 2026-09-23 is Wednesday
    const wednesday = new Date(2026, 8, 23, 15, 30);
    const monday = getMondayOfWeek(wednesday);
    expect(monday.getFullYear()).toBe(2026);
    expect(monday.getMonth()).toBe(8);
    expect(monday.getDate()).toBe(21); // Monday is 21st
    expect(monday.getDay()).toBe(1);

    // 2026-09-27 is Sunday -> Monday should still be 21st
    const sunday = new Date(2026, 8, 27, 23, 59);
    const mondayFromSunday = getMondayOfWeek(sunday);
    expect(mondayFromSunday.getDate()).toBe(21);
    expect(mondayFromSunday.getDay()).toBe(1);
  });

  it("generates 7 consecutive week days from Monday to Sunday", () => {
    const ref = new Date(2026, 8, 23);
    const days = getWeekDays(ref);
    expect(days).toHaveLength(7);
    expect(days[0]!.getDay()).toBe(1); // Monday
    expect(days[6]!.getDay()).toBe(0); // Sunday
    expect(days[0]!.getDate()).toBe(21);
    expect(days[6]!.getDate()).toBe(27);
  });

  it("formats week title clearly across days", () => {
    const ref = new Date(2026, 8, 23);
    expect(formatWeekTitle(ref)).toBe("2026年9月21日 - 27日");
  });

  it("checks same day correctly", () => {
    const d1 = new Date(2026, 8, 23, 10, 0);
    const d2 = new Date(2026, 8, 23, 22, 30);
    const d3 = new Date(2026, 8, 24, 0, 1);
    expect(isSameDay(d1, d2)).toBe(true);
    expect(isSameDay(d1, d3)).toBe(false);
  });

  it("computes interview urgency correctly", () => {
    const now = new Date("2026-09-23T10:00:00.000Z").getTime();

    // In the past
    const past = getInterviewUrgency("2026-09-23T08:00:00.000Z", now);
    expect(past.isPast).toBe(true);
    expect(past.label).toBe("已结束");

    // Within 2 hours (<= 24h)
    const urgent = getInterviewUrgency("2026-09-23T12:00:00.000Z", now);
    expect(urgent.isUrgent).toBe(true);
    expect(urgent.diffHours).toBe(2);
    expect(urgent.label).toBe("仅剩 2h");

    // In 48 hours (soon)
    const soon = getInterviewUrgency("2026-09-25T10:00:00.000Z", now);
    expect(soon.isSoon).toBe(true);
    expect(soon.isUrgent).toBe(false);
    expect(soon.diffDays).toBe(2);

    // Far away
    const later = getInterviewUrgency("2026-10-10T10:00:00.000Z", now);
    expect(later.isSoon).toBe(false);
    expect(later.isUrgent).toBe(false);
  });

  it("extracts and groups calendar events cleanly", () => {
    const mockApps: Application[] = [
      {
        id: 1,
        company: "Alpha Tech",
        role: "Frontend Engineer",
        flow_status: "active", batch_name: "", hiring_stage: null, stage_changed_at: "", terminal_stage: null, terminal_reason: "", terminal_at: "",
        salary_range: "25k-35k",
        stage: "interview",
        resume_id: 10,
        jd: "React Next.js",
        interview_id: null,
        interview_series_id: null,
        next_interview_at: "2026-09-23T14:00:00.000Z",
        notes: "带电脑",
        created_at: "2026-09-20T00:00:00.000Z",
        updated_at: "2026-09-20T00:00:00.000Z",
        interviews: [
          {
            id: 101,
            application_id: 1,
            round_name: "技术一面",
            interview_time: "2026-09-23T14:00:00.000Z",
            status: "scheduled",
            interviewer: "李工",
            notes: "手撕代码",
            created_at: "",
            updated_at: "",
          },
          {
            id: 102,
            application_id: 1,
            round_name: "技术二面",
            interview_time: "2026-09-25T16:00:00.000Z",
            status: "scheduled",
            interviewer: "王主管",
            notes: "系统设计",
            created_at: "",
            updated_at: "",
          },
        ],
      },
      {
        id: 2,
        company: "Beta Cloud",
        role: "Fullstack",
        flow_status: "active", batch_name: "", hiring_stage: null, stage_changed_at: "", terminal_stage: null, terminal_reason: "", terminal_at: "",
        salary_range: "",
        stage: "interviewing",
        resume_id: null,
        jd: "",
        interview_id: null,
        interview_series_id: null,
        next_interview_at: "2026-09-24T10:00:00.000Z",
        notes: "",
        created_at: "",
        updated_at: "",
        // 没有独立 interviews 数组，依赖 next_interview_at 生成合成事件
      },
    ];

    const events = extractCalendarEvents(mockApps);
    expect(events).toHaveLength(3);
    expect(events[0]!.company).toBe("Alpha Tech");
    expect(events[0]!.round_name).toBe("技术一面");
    expect(events[1]!.company).toBe("Beta Cloud"); // 24号排在中间
    expect(events[2]!.round_name).toBe("技术二面"); // 25号

    const weekDays = getWeekDays(new Date(2026, 8, 23));
    const grouped = groupEventsByDay(events, weekDays);
    expect(grouped.size).toBe(7);
  });
});
