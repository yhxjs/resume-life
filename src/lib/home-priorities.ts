import { interviewEpochMs } from "./application-datetime";
import { getDb } from "./db";
import { addReviewDays, getReviewDate } from "./spaced-repetition";
import { getReviewSummary } from "./spaced-repetition-cards";
import { getHomeApplicationHref, type HomePriorities, type HomePriority } from "./home-priorities-contract";

const DAY = 24 * 60 * 60 * 1000;
type ApplicationCandidate = {
  id: number;
  company: string;
  role: string;
  stage: string;
  next_interview_at: string;
  has_interviews: number;
  scheduled_interviews: string;
  has_jd: number;
  has_resume: number;
  has_intro: number;
  has_portrait: number;
  has_diagnosis: number;
};
type RankedPriority = { item: HomePriority; priority: number; time: number; id: number };

/**
 * 首页只读轻量信号，不加载整份简历、报告或逐岗位查询资料。
 * 有真实轮次时以尚未完成的未来轮次为准，不能退回已取消轮次遗留的汇总时间。
 * 同一岗位合并面试和资料缺口；所有到期复习合为一次行动，最多返回三项。
 */
export function getHomePriorities(reference = new Date(), timeZone?: string): HomePriorities {
  const date = getReviewDate(reference, timeZone);
  const timestamp = reference.getTime();
  const applications = getDb().prepare(`SELECT a.id, a.company, a.role, a.stage, a.next_interview_at,
    EXISTS (SELECT 1 FROM application_interviews r WHERE r.application_id = a.id) AS has_interviews,
    (SELECT json_group_array(r.interview_time) FROM application_interviews r
      WHERE r.application_id = a.id AND r.status = 'scheduled') AS scheduled_interviews,
    length(trim(a.jd, char(9) || char(10) || char(13) || ' ')) > 0 AS has_jd,
    EXISTS (SELECT 1 FROM resume_versions v JOIN resumes r ON r.id = v.resume_id
      WHERE v.id = a.resume_version_id AND r.id = a.resume_id) AS has_resume,
    EXISTS (SELECT 1 FROM application_preparation_resources p WHERE p.application_id = a.id AND p.intro_id IS NOT NULL) AS has_intro,
    EXISTS (SELECT 1 FROM application_preparation_resources p WHERE p.application_id = a.id AND p.portrait_id IS NOT NULL) AS has_portrait,
    EXISTS (SELECT 1 FROM application_preparation_resources p WHERE p.application_id = a.id AND p.diagnosis_id IS NOT NULL) AS has_diagnosis
    FROM applications a WHERE a.stage != 'rejected' ORDER BY a.id`)
    .all() as ApplicationCandidate[];
  const reviews = getReviewSummary(date);
  const candidates: RankedPriority[] = [];

  for (const app of applications) {
    const missing = [
      !app.has_resume && "已发布的简历版本", !app.has_jd && "岗位 JD",
      !app.has_intro && "自我介绍", !app.has_portrait && "JD 考点画像",
      !app.has_diagnosis && "简历诊断",
    ].filter((label): label is string => Boolean(label));
    // 历史无时区时间沿用本地时间语义；筛选与展示统一解析，不能先用 SQLite 的 UTC 规则选一轮再过滤。
    const interviewTime = app.has_interviews
      ? (JSON.parse(app.scheduled_interviews) as string[]).reduce((nearest, value) => {
        const time = interviewEpochMs(value);
        return time !== null && time >= timestamp && time < nearest ? time : nearest;
      }, Infinity)
      : interviewEpochMs(app.next_interview_at) ?? Infinity;
    const upcoming = interviewTime >= timestamp && interviewTime <= timestamp + 7 * DAY;
    const base = { id: `application-${app.id}`, title: `${app.company} · ${app.role}`, href: getHomeApplicationHref(app.id) };
    if (upcoming) {
      const imminent = interviewTime <= timestamp + 2 * DAY;
      const interviewDate = getReviewDate(new Date(interviewTime), timeZone);
      const dayLabel = interviewDate === date ? "今天" : interviewDate === addReviewDays(date, 1) ? "明天" : "7 天内";
      const schedule = new Intl.DateTimeFormat("zh-CN", {
        timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date(interviewTime));
      candidates.push({
        priority: imminent ? 0 : 2, time: interviewTime, id: app.id,
        item: { ...base, kind: "interview", badge: `${dayLabel}面试`, urgent: imminent,
          reason: `${schedule} 面试。${missing.length ? `还缺${missing.join("、")}，建议面试前补齐。` : "准备资料已齐，过一遍自我介绍与岗位考点。"}`,
          action: app.id > 0 ? "进入面试准备" : "查看投递看板" },
      });
    } else if (app.stage !== "offer" && missing.length) {
      const blocked = !app.has_resume || !app.has_jd;
      candidates.push({
        priority: blocked ? 3 : 5, time: interviewTime >= timestamp ? interviewTime : Infinity, id: app.id,
        item: { ...base, kind: "materials", badge: blocked ? "基础资料待补" : "准备资料待补", urgent: false,
          reason: `还缺${missing.join("、")}。${blocked ? "先补齐简历版本和 JD，即可开始针对岗位的准备。" : "关联已有资料或生成内容，为下一次面试做好准备。"}`,
          action: app.id > 0 ? "补齐准备资料" : "查看投递看板" },
      });
    }
  }

  if (reviews.due > 0) {
    candidates.push({
      priority: reviews.overdue > 0 ? 1 : 4, time: 0, id: 0,
      item: { id: "reviews", kind: "review", title: `复习 ${reviews.due} 道到期题目`,
        badge: reviews.overdue > 0 ? `${reviews.overdue} 题已逾期` : "今日到期", urgent: reviews.overdue > 0,
        reason: `${reviews.overdue > 0 ? `其中 ${reviews.overdue} 题已逾期。` : "今天的复习已经安排好。"}错题 ${reviews.notebook} 题、追练 ${reviews.remedial} 题，先凭记忆作答，再对照参考。`,
        href: "/reviews", action: "开始今日复习" },
    });
  }
  candidates.sort((a, b) => a.priority - b.priority || a.time - b.time || a.id - b.id);
  return { date, items: candidates.slice(0, 3).map(candidate => candidate.item) };
}
