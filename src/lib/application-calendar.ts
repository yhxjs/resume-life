import {
  type Application,
  type CalendarInterviewEvent,
  type InterviewRoundStatus,
} from "@/lib/applications-types";

/**
 * 获取某个日期所在周的周一 00:00:00 (本地时区)
 */
export function getMondayOfWeek(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  const day = result.getDay();
  // 周日 getDay() === 0，在我国习惯中视作周的最后一天（需要回退 6 天）
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);
  return result;
}

/**
 * 获取以 referenceDate 为准的周一至周日 7 天日期对象 (本地时区)
 */
export function getWeekDays(referenceDate: Date): Date[] {
  const monday = getMondayOfWeek(referenceDate);
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
}

/**
 * 判断两个 Date 对象是否在本地同一天
 */
export function isSameDay(d1: Date, d2: Date): boolean {
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

/**
 * 格式化周标题，如 "2026年9月21日 - 9月27日"
 */
export function formatWeekTitle(referenceDate: Date): string {
  const days = getWeekDays(referenceDate);
  const start = days[0]!;
  const end = days[6]!;

  const startYear = start.getFullYear();
  const startMonth = start.getMonth() + 1;
  const startDate = start.getDate();

  const endYear = end.getFullYear();
  const endMonth = end.getMonth() + 1;
  const endDate = end.getDate();

  if (startYear === endYear) {
    if (startMonth === endMonth) {
      return `${startYear}年${startMonth}月${startDate}日 - ${endDate}日`;
    }
    return `${startYear}年${startMonth}月${startDate}日 - ${endMonth}月${endDate}日`;
  }
  return `${startYear}年${startMonth}月${startDate}日 - ${endYear}年${endMonth}月${endDate}日`;
}

/**
 * 格式化为本地 YYYY-MM-DD
 */
export function toDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 面试紧急度与提醒计算结果
 */
export interface InterviewUrgencyInfo {
  isPast: boolean;
  isUrgent: boolean; // 24小时内
  isSoon: boolean;   // 72小时内
  isAlarming: boolean; // 处于提前提醒窗口内（如距面试不到 15m/30m/1h）
  diffMinutes: number;
  diffHours: number;
  diffDays: number;
  label: string;
}

/**
 * 计算距离当前时间的紧急程度与提醒窗口命中
 */
export function getInterviewUrgency(
  interviewTimeIso: string,
  nowTimestamp: number,
  reminderMinutes: number = 15
): InterviewUrgencyInfo {
  if (!interviewTimeIso) {
    return {
      isPast: false,
      isUrgent: false,
      isSoon: false,
      isAlarming: false,
      diffMinutes: 0,
      diffHours: 0,
      diffDays: 0,
      label: "",
    };
  }

  const interviewTime = new Date(interviewTimeIso).getTime();
  if (Number.isNaN(interviewTime)) {
    return {
      isPast: false,
      isUrgent: false,
      isSoon: false,
      isAlarming: false,
      diffMinutes: 0,
      diffHours: 0,
      diffDays: 0,
      label: "",
    };
  }

  const diffMs = interviewTime - nowTimestamp;
  const diffMinutes = Math.round(diffMs / (1000 * 60));
  const diffHours = Math.round(diffMs / (1000 * 60 * 60));
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffMs < 0) {
    return {
      isPast: true,
      isUrgent: false,
      isSoon: false,
      isAlarming: false,
      diffMinutes,
      diffHours,
      diffDays,
      label: "已结束",
    };
  }

  // 命中提前提醒时间窗口（在面试前 reminderMinutes 内，且尚未开始）
  const isAlarming = reminderMinutes > 0 && diffMinutes <= reminderMinutes;

  if (diffHours <= 24) {
    const isVeryClose = diffMinutes <= 60;
    return {
      isPast: false,
      isUrgent: true,
      isSoon: true,
      isAlarming,
      diffMinutes: Math.max(diffMinutes, 0),
      diffHours: Math.max(diffHours, 0),
      diffDays: Math.max(diffDays, 0),
      label: isVeryClose ? (diffMinutes <= 1 ? "即将开始" : `仅剩 ${diffMinutes}m`) : `仅剩 ${diffHours}h`,
    };
  }

  if (diffHours <= 72) {
    return {
      isPast: false,
      isUrgent: false,
      isSoon: true,
      isAlarming,
      diffMinutes,
      diffHours,
      diffDays,
      label: `${diffDays}天后`,
    };
  }

  return {
    isPast: false,
    isUrgent: false,
    isSoon: false,
    isAlarming,
    diffMinutes,
    diffHours,
    diffDays,
    label: `${diffDays}天后`,
  };
}

/**
 * 准备待办紧迫度计算结果
 */
export interface TaskUrgencyInfo {
  hasDue: boolean;
  isOverdue: boolean;
  isDueToday: boolean;
  isDueSoon: boolean; // 24小时内到期
  label: string;
}

/**
 * 计算待办截止时间的紧迫度
 */
export function getTaskUrgency(dueTimeIso: string | undefined, nowTimestamp: number): TaskUrgencyInfo {
  if (!dueTimeIso) {
    return { hasDue: false, isOverdue: false, isDueToday: false, isDueSoon: false, label: "" };
  }
  const due = new Date(dueTimeIso).getTime();
  if (Number.isNaN(due)) {
    return { hasDue: false, isOverdue: false, isDueToday: false, isDueSoon: false, label: "" };
  }

  const diffMs = due - nowTimestamp;
  const diffHours = Math.round(diffMs / (1000 * 60 * 60));

  if (diffMs < 0) {
    return { hasDue: true, isOverdue: true, isDueToday: false, isDueSoon: false, label: "已逾期" };
  }

  if (diffHours <= 24) {
    return {
      hasDue: true,
      isOverdue: false,
      isDueToday: true,
      isDueSoon: true,
      label: diffHours <= 1 ? "即将截止" : `剩 ${diffHours}h 截止`,
    };
  }

  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  return {
    hasDue: true,
    isOverdue: false,
    isDueToday: false,
    isDueSoon: diffDays <= 3,
    label: `${diffDays}天后截止`,
  };
}

/**
 * 从 Applications 列表中提取扁平化的所有面试事件，保障日程完整性
 */
export function extractCalendarEvents(
  applications: Application[]
): CalendarInterviewEvent[] {
  const events: CalendarInterviewEvent[] = [];

  for (const app of applications) {
    if (app.interviews && app.interviews.length > 0) {
      for (const round of app.interviews) {
        if (!round.interview_time) continue;
        events.push({
          id: round.id,
          application_id: app.id,
          company: app.company,
          role: app.role,
          salary_range: app.salary_range,
          round_name: round.round_name || "面试",
          interview_time: round.interview_time,
          status: round.status || "scheduled",
          interviewer: round.interviewer || "",
          location: round.location || "",
          meeting_url: round.meeting_url || "",
          reminder_minutes: typeof round.reminder_minutes === "number" ? round.reminder_minutes : 15,
          notes: round.notes || "",
          jd: app.jd || "",
          resume_id: app.resume_id,
          interview_id: app.interview_id,
          interview_series_id: app.interview_series_id,
          stage: app.stage,
          preparation_tasks: app.preparation_tasks || [],
        });
      }
    } else if (app.next_interview_at) {
      // 2. 若未独立建轮次但有 next_interview_at，生成合成事件避免漏看
      events.push({
        id: -app.id, // 用负数标识合成事件
        application_id: app.id,
        company: app.company,
        role: app.role,
        salary_range: app.salary_range,
        round_name: app.latest_round || "预约面试",
        interview_time: app.next_interview_at,
        status: (app.latest_round_status as InterviewRoundStatus) || "scheduled",
        interviewer: "",
        location: "",
        meeting_url: "",
        reminder_minutes: 15,
        notes: app.notes || "",
        jd: app.jd || "",
        resume_id: app.resume_id,
        interview_id: app.interview_id,
        interview_series_id: app.interview_series_id,
        stage: app.stage,
        preparation_tasks: app.preparation_tasks || [],
      });
    }
  }

  // 按时间升序排序
  return events.sort((a, b) => {
    return new Date(a.interview_time).getTime() - new Date(b.interview_time).getTime();
  });
}

/**
 * 将事件按 YYYY-MM-DD 归类到周内各天
 */
export function groupEventsByDay(
  events: CalendarInterviewEvent[],
  weekDays: Date[]
): Map<string, CalendarInterviewEvent[]> {
  const map = new Map<string, CalendarInterviewEvent[]>();
  for (const day of weekDays) {
    map.set(toDayKey(day), []);
  }

  for (const event of events) {
    const eventDate = new Date(event.interview_time);
    if (Number.isNaN(eventDate.getTime())) continue;
    const key = toDayKey(eventDate);
    if (map.has(key)) {
      map.get(key)!.push(event);
    }
  }

  return map;
}
