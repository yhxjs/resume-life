import type { Application } from "@/lib/applications-types";

export const PLAN_STEP_KEYS = ["jd", "resume", "portrait", "diagnosis", "intro", "evidence", "focus", "intro-practice", "interview", "questions", "review"] as const;
export type PlanStepKey = (typeof PLAN_STEP_KEYS)[number];
export const MANUAL_PLAN_STEP_KEYS = ["evidence", "focus", "intro-practice", "questions", "review"] as const;
export function isPreparationCompletion(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MANUAL_PLAN_STEP_KEYS.length && new Set(value).size === value.length
    && value.every(key => MANUAL_PLAN_STEP_KEYS.includes(key as (typeof MANUAL_PLAN_STEP_KEYS)[number]));
}
export type PlanStep = {
  key: PlanStepKey;
  category: "material" | "training";
  title: string;
  reason: string;
  minutes: [number, number];
  done: boolean;
  manual: boolean;
  blocked: string | null;
  action: "edit" | "generate" | "practice" | "visit";
  actionLabel: string;
  href: string | null;
  instructions: string[];
};
export type PreparationPlan = {
  application: Application;
  contextKey: string;
  generatedAt: string | null;
  stale: boolean;
  steps: PlanStep[];
};

export function remainingPlanMinutes(steps: PlanStep[]): [number, number] {
  return steps.filter(step => !step.done).reduce<[number, number]>((total, step) => [total[0] + step.minutes[0], total[1] + step.minutes[1]], [0, 0]);
}

/** 先验证完整响应及岗位归属，再更新页面，避免失败写入被显示为完成。 */
export function readPreparationPlan(value: unknown, applicationId: number): PreparationPlan {
  const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  function fail(): never { throw new Error("准备清单响应不完整，请刷新清单核对"); }
  if (!isObject(value) || !isObject(value.application) || value.application.id !== applicationId || !Number.isSafeInteger(applicationId) || applicationId <= 0
    || typeof value.application.company !== "string" || typeof value.application.role !== "string" || typeof value.application.jd !== "string"
    || typeof value.contextKey !== "string" || !/^[a-f0-9]{64}$/.test(value.contextKey) || typeof value.stale !== "boolean"
    || (value.generatedAt !== null && (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt)))) || !Array.isArray(value.steps)) fail();
  const ids = new Set<unknown>();
  for (const step of value.steps) {
    if (!isObject(step) || !PLAN_STEP_KEYS.includes(step.key as PlanStepKey) || ids.has(step.key)
      || !["material", "training"].includes(String(step.category)) || !["edit", "generate", "practice", "visit"].includes(String(step.action))
      || [step.title, step.reason, step.actionLabel].some(text => typeof text !== "string" || !text.trim())
      || typeof step.done !== "boolean" || typeof step.manual !== "boolean" || (step.blocked !== null && typeof step.blocked !== "string")
      || !Array.isArray(step.minutes) || step.minutes.length !== 2 || step.minutes.some(n => !Number.isSafeInteger(n) || n < 1 || n > 240) || step.minutes[0] > step.minutes[1]
      || (step.href !== null && (typeof step.href !== "string" || !/^\/(?:applications|resumes|intros|interviews|tools\/jd)\//.test(step.href) && !/^\/interviews\?applicationId=\d+$/.test(step.href)))
      || !Array.isArray(step.instructions) || step.instructions.some(text => typeof text !== "string" || !text.trim())) fail();
    ids.add(step.key);
  }
  if (value.generatedAt !== null && PLAN_STEP_KEYS.slice(0, 10).some(key => !ids.has(key))) fail();
  return value as PreparationPlan;
}
