import type { ModuleData } from "@/lib/modules";
import type { ResumeStyleOverrides } from "@/lib/templates";

export type ApplicationStage =
  | "interested"     // 意向
  | "applied"        // 已投递
  | "interviewing"   // 约面
  | "interview"      // 面试中
  | "reviewing"      // 待复盘
  | "offer"          // 斩获 Offer
  | "rejected";      // 流程终止

export type ApplicationFlowStatus = "active" | "passed" | "terminated";

export const APPLICATION_FLOW_STATUSES: ApplicationFlowStatus[] = [
  "active",
  "passed",
  "terminated",
];

export type ApplicationTerminalStage =
  | "resume_screening"
  | "technical_interview"
  | "hr_interview"
  | "other";

export const APPLICATION_TERMINAL_STAGES: ApplicationTerminalStage[] = [
  "resume_screening",
  "technical_interview",
  "hr_interview",
  "other",
];

export const APPLICATION_TERMINAL_STAGE_CONFIG: Record<
  ApplicationTerminalStage,
  { label: string }
> = {
  resume_screening: { label: "简历筛选" },
  technical_interview: { label: "技术面" },
  hr_interview: { label: "HR 面" },
  other: { label: "其他阶段" },
};

export const STAGE_CONFIG: Record<
  ApplicationStage,
  { label: string; desc: string; color: string; border: string; bg: string; dot: string }
> = {
  interested: {
    label: "意向",
    desc: "已关注待投递",
    color: "text-muted",
    border: "border-line",
    bg: "bg-surface",
    dot: "bg-muted",
  },
  applied: {
    label: "已投递",
    desc: "已投递等回应",
    color: "text-ink",
    border: "border-line-strong",
    bg: "bg-surface",
    dot: "bg-ink",
  },
  interviewing: {
    label: "约面",
    desc: "邀约与面试排期",
    color: "text-ink",
    border: "border-line-strong",
    bg: "bg-surface",
    dot: "bg-ink",
  },
  interview: {
    label: "面试中",
    desc: "多轮面试推进中",
    color: "text-accent",
    border: "border-accent/40",
    bg: "bg-accent/5",
    dot: "bg-accent",
  },
  reviewing: {
    label: "待复盘",
    desc: "面试结束待总结",
    color: "text-primary",
    border: "border-primary/40",
    bg: "bg-primary/5",
    dot: "bg-primary",
  },
  offer: {
    label: "Offer",
    desc: "已收获意向书",
    color: "text-ok",
    border: "border-primary",
    bg: "bg-primary-soft",
    dot: "bg-primary",
  },
  rejected: {
    label: "流程终止",
    desc: "已结束/不合适",
    color: "text-faint",
    border: "border-line/60",
    bg: "bg-surface-2/60",
    dot: "bg-faint",
  },
};

export const FUNNEL_STAGES: ApplicationStage[] = [
  "interested",
  "applied",
  "interviewing",
  "interview",
  "reviewing",
  "offer",
];

/** 全部合法阶段（含 rejected），用于路由层入参白名单校验 */
export const APPLICATION_STAGES = Object.keys(STAGE_CONFIG) as ApplicationStage[];

export type InterviewRoundStatus =
  | "scheduled" // 待面试
  | "passed"    // 已通过
  | "failed"    // 未通过
  | "completed" // 已完成
  | "cancelled"; // 已取消

export const ROUND_STATUS_CONFIG: Record<
  InterviewRoundStatus,
  { label: string; color: string; bg: string; border: string }
> = {
  scheduled: {
    label: "待面试",
    color: "text-accent",
    bg: "bg-accent/10",
    border: "border-accent/30",
  },
  passed: {
    label: "已通过",
    color: "text-ok",
    bg: "bg-primary-soft",
    border: "border-primary/40",
  },
  failed: {
    label: "未通过",
    color: "text-danger",
    bg: "bg-danger-wash",
    border: "border-danger/30",
  },
  completed: {
    label: "已完成",
    color: "text-muted",
    bg: "bg-surface",
    border: "border-line",
  },
  cancelled: {
    label: "已取消",
    color: "text-faint",
    bg: "bg-surface-2",
    border: "border-line/60",
  },
};

export const INTERVIEW_ROUND_STATUSES = Object.keys(
  ROUND_STATUS_CONFIG
) as InterviewRoundStatus[];

export interface ApplicationInterview {
  id: number;
  application_id: number;
  round_name: string;
  interview_time: string;
  status: InterviewRoundStatus;
  interviewer: string;
  location?: string;
  meeting_url?: string;
  reminder_minutes?: number;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface CreateApplicationInterviewInput {
  round_name: string;
  interview_time?: string;
  status?: InterviewRoundStatus;
  interviewer?: string;
  location?: string;
  meeting_url?: string;
  reminder_minutes?: number;
  notes?: string;
}

export interface UpdateApplicationInterviewInput {
  round_name?: string;
  interview_time?: string;
  status?: InterviewRoundStatus;
  interviewer?: string;
  location?: string;
  meeting_url?: string;
  reminder_minutes?: number;
  notes?: string;
}

export interface Application {
  id: number;
  company: string;
  role: string;
  salary_range: string;
  stage: ApplicationStage;
  flow_status: ApplicationFlowStatus;
  batch_name: string;
  hiring_stage: ApplicationTerminalStage | null;
  stage_changed_at: string;
  terminal_stage: ApplicationTerminalStage | null;
  terminal_reason: string;
  terminal_at: string;
  resume_id: number | null;
  resume_version_id?: number | null;
  jd: string;
  interview_id: number | null;
  interview_series_id: number | null;
  next_interview_at: string;
  notes: string;
  created_at: string;
  updated_at: string;
  submitted_at?: string | null;

  // 关联属性
  resume_title?: string | null;
  resume_version?: number | null;
  resume_version_name?: string | null;
  interview_rounds?: number | null;
  interview_status?: string | null;
  interview_series_rounds_done?: number | null;
  interview_series_status?: string | null;

  // 独立子表面试轮次关联
  interviews?: ApplicationInterview[];
  latest_round?: string | null;
  latest_round_status?: InterviewRoundStatus | null;
  interview_rounds_count?: number;
  stage_history?: ApplicationStageHistory[];
  preparation_tasks?: import("@/lib/application-preparation-types").PreparationTask[];
}

export interface ApplicationStageHistory {
  id: number;
  application_id: number;
  from_stage: ApplicationStage | null;
  to_stage: ApplicationStage;
  from_hiring_stage: ApplicationTerminalStage | null;
  to_hiring_stage: ApplicationTerminalStage | null;
  terminal_stage: ApplicationTerminalStage | null;
  changed_at: string;
  reason: string;
}

export interface ApplicationResumeSnapshot {
  id: number;
  title: string;
  template: string;
  style_overrides: ResumeStyleOverrides;
  modules: ModuleData[];
}

export interface ApplicationVersions {
  submitted: {
    captured_at: string;
    resume: ApplicationResumeSnapshot | null;
    jd: string;
  } | null;
  current: {
    resume: ApplicationResumeSnapshot | null;
    jd: string;
    warnings: string[];
  };
}

export interface CreateApplicationInput {
  company: string;
  role: string;
  salary_range?: string;
  stage?: ApplicationStage;
  batch_name?: string;
  hiring_stage?: ApplicationTerminalStage | null;
  terminal_stage?: ApplicationTerminalStage | null;
  terminal_reason?: string;
  resume_id?: number | null;
  resume_version_id?: number | null;
  jd?: string;
  interview_id?: number | null;
  interview_series_id?: number | null;
  next_interview_at?: string;
  notes?: string;
}

export interface ApplicationStats {
  counts: Record<ApplicationStage, number>;
  totalActive: number;
  upcomingInterviews: Application[];
  rates: {
    appliedRate: number;    // 意向 -> 投递
    interviewRate: number;  // 投递 -> 约面
    offerRate: number;      // 约面 -> Offer
  };
  batchStats?: FunnelBatchMetric[];
  funnel?: FunnelMetrics;
}


export type ApplicationViewMode = "kanban" | "calendar" | "funnel";
export type CalendarDisplayMode = "week" | "agenda";

/** 日历/议程视图中的单场面试事件 */
export interface CalendarInterviewEvent {
  id: number;
  application_id: number;
  company: string;
  role: string;
  salary_range?: string;
  round_name: string;
  interview_time: string; // ISO 8601
  status: InterviewRoundStatus;
  interviewer: string;
  location?: string;
  meeting_url?: string;
  reminder_minutes?: number;
  notes: string;
  jd: string;
  resume_id: number | null;
  interview_id: number | null;
  interview_series_id: number | null;
  stage: ApplicationStage;
  preparation_tasks?: import("@/lib/application-preparation-types").PreparationTask[];
}

/** 漏斗单步度量指标 */
export interface FunnelStepMetric {
  stage: ApplicationStage;
  label: string;
  desc: string;
  count: number;
  cumulativeCount: number; // 有记录证据到达本阶段的投递数
  passedCount: number;
  unknownCount: number;
  conversionRate: number | null; // 通过 / (通过 + 终止)，无结果时为 null
  dropOffCount: number; // 明确从本阶段终止的投递数
  dropOffRate: number | null;
}

export type FunnelInsightSeverity = "info" | "warning" | "success";

/** 漏斗智能诊断与行动建议 */
export interface FunnelInsight {
  id: string;
  severity: FunnelInsightSeverity;
  title: string;
  description: string;
  metricHighlight: string;
  actionText?: string;
  actionHref?: string;
}

/** 全周期漏斗分析汇总度量 */
export interface FunnelMetrics {
  counts: Record<ApplicationStage, number>;
  totalApplications: number;
  totalActive: number;
  totalCompleted: number; // offer + rejected
  totalOffers: number;
  totalRejected: number;
  winRate: number;         // 胜率: offer / (offer + rejected) * 100
  overallYieldRate: number;// 投录比率: offer / totalApplications * 100
  steps: FunnelStepMetric[];
  insights: FunnelInsight[];
  hiringSteps: HiringStepMetric[];
  unknownTerminations: number;
  incompleteHistoryCount: number;
  terminationReasons: { stage: ApplicationTerminalStage | null; reason: string; count: number }[];
}

export type FunnelApplication = Pick<Application,
  'id' | 'stage' | 'batch_name' | 'hiring_stage' | 'terminal_stage' | 'terminal_reason' | 'stage_history'>;

export interface FunnelBatchMetric extends FunnelMetrics {
  batchName: string;
}

export interface HiringStepMetric {
  stage: ApplicationTerminalStage;
  label: string;
  active: number;
  passed: number;
  terminated: number;
  conversionRate: number | null;
}
