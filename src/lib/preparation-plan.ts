import { createHash } from "node:crypto";
import { getDb, inTransaction, now } from "@/lib/db";
import { ApplicationInputError } from "@/lib/applications";
import { preparationApplication, listPreparationResources } from "@/lib/application-preparation";
import { parseJdPortraitResult } from "@/lib/jd-portrait";
import { INTRO_KINDS, readStoredIntroSentences } from "@/lib/intro";
import { isStoredDiagnosisReport } from "@/lib/backup-domain";
import { isPreparationCompletion } from "@/lib/preparation-plan-types";
import type { Application } from "@/lib/applications-types";
import type { PlanStep, PlanStepKey, PreparationPlan } from "@/lib/preparation-plan-types";

type SavedPlan = { context_key: string; completed_steps: string; created_at: string };
type Resource = { id: number; jd: string; status?: string; result?: string; report?: string };

function contextKey(app: Application): string {
  return createHash("sha256").update(JSON.stringify([app.id, app.company, app.role, app.jd.trim(), app.resume_id, app.resume_version_id])).digest("hex");
}

/** 仅使用明确关联到本投递、且 JD/发布版本匹配的资料，不凭同名岗位或同一简历猜归属。 */
function currentResource(app: Application, kind: "portrait" | "diagnosis" | "intro" | "interview" | "series"): Resource | undefined {
  const source = {
    portrait: ["jd_portraits", "portrait_id"], diagnosis: ["resume_diagnoses", "diagnosis_id"],
    intro: ["intros", "intro_id"], interview: ["interviews", "interview_id"], series: ["interview_series", "series_id"],
  }[kind];
  const directId = kind === "interview" ? app.interview_id : kind === "series" ? app.interview_series_id : null;
  const rows = getDb().prepare(`SELECT r.id, r.jd${kind === "portrait" ? ", r.result" : kind === "diagnosis" ? ", r.report" : kind === "interview" || kind === "series" ? ", r.status" : ""} FROM ${source[0]} r WHERE (
    EXISTS (SELECT 1 FROM application_preparation_resources p WHERE p.application_id = ? AND p.${source[1]} = r.id)
    OR r.id = ?) ${kind === "interview" ? "AND r.series_id IS NULL" : ""}
    ${kind === "portrait" ? "" : "AND r.resume_id = ? AND r.resume_version_id = ?"}
    ORDER BY ${kind === "interview" || kind === "series" ? "(r.status = 'finished') DESC," : ""} r.id DESC`)
    .all(app.id, directId ?? null, ...(kind === "portrait" ? [] : [app.resume_id ?? null, app.resume_version_id ?? null])) as Resource[];
  return rows.find(row => {
    if (row.jd.trim() !== app.jd.trim()) return false;
    if (kind === "portrait") return Boolean(parseJdPortraitResult(row.result ?? ""));
    if (kind === "diagnosis") {
      try { return isStoredDiagnosisReport(JSON.parse(row.report ?? "")); } catch { return false; }
    }
    if (kind === "intro") {
      const versions = getDb().prepare("SELECT kind, sentences FROM intro_versions WHERE intro_id = ?").all(row.id) as { kind: string; sentences: string }[];
      return INTRO_KINDS.every(key => {
        const version = versions.find(item => item.kind === key);
        if (!version) return false;
        const parsed = readStoredIntroSentences(version.sentences);
        return !parsed.error && parsed.sentences.length > 0;
      });
    }
    return true;
  });
}

function readCompleted(saved: SavedPlan | undefined, key: string): Set<string> {
  if (!saved || saved.context_key !== key) return new Set();
  const value: unknown = JSON.parse(saved.completed_steps);
  if (!isPreparationCompletion(value)) throw new Error("清单完成记录无法读取");
  return new Set(value);
}

function buildSteps(app: Application, completed: Set<string>): PlanStep[] {
  const hasJd = Boolean(app.jd.trim());
  const hasResume = Boolean(app.resume_id && app.resume_version_id);
  const portrait = hasJd ? currentResource(app, "portrait") : undefined;
  const diagnosis = hasJd && hasResume ? currentResource(app, "diagnosis") : undefined;
  const intro = hasJd && hasResume ? currentResource(app, "intro") : undefined;
  const single = hasJd && hasResume ? currentResource(app, "interview") : undefined;
  const series = hasJd && hasResume ? currentResource(app, "series") : undefined;
  const interview = single?.status === "finished" ? single : series?.status === "finished" ? series : single ?? series;
  const interviewHref = interview ? `/interviews/${interview === series ? "series/" : ""}${interview.id}?applicationId=${app.id}` : `/interviews?applicationId=${app.id}`;
  const prepareHref = `/applications/${app.id}/prepare`;
  const prerequisite = !hasJd ? "先补充岗位 JD" : !hasResume ? "先关联已发布的简历版本" : null;
  const introHref = intro ? `/intros/${intro.id}?applicationId=${app.id}` : null;
  const portraitHref = portrait ? `/tools/jd/${portrait.id}?applicationId=${app.id}` : null;
  let focus: string[] = [];
  if (portrait?.result) {
    try {
      const result = parseJdPortraitResult(portrait.result);
      focus = result?.followups.slice(0, 3).flatMap(item => item.questions.slice(0, 1).map(question => `${item.topic}：${question}`)) ?? [];
    } catch { /* 历史画像异常时仍提供基于原 JD 的练习步骤。 */ }
  }
  const manual = (key: PlanStepKey, title: string, reason: string, minutes: [number, number], instructions: string[], blocked: string | null = null, href: string | null = null): PlanStep => ({
    key, title, reason, minutes, instructions, category: "training", manual: true, done: !blocked && completed.has(key), blocked,
    action: "practice", actionLabel: "开始练习", href,
  });
  const material = (key: PlanStepKey, title: string, reason: string, minutes: [number, number], done: boolean, href: string | null, blocked: string | null = null): PlanStep => ({
    key, title, reason, minutes, done, href, blocked, category: "material", manual: false, instructions: [],
    action: key === "jd" || key === "resume" ? "edit" : done ? "visit" : "generate",
    actionLabel: key === "jd" || key === "resume" ? done ? "查看 / 调整" : "去补充" : done ? "查看资料" : "立即生成",
  });
  const steps: PlanStep[] = [
    material("jd", "补齐岗位 JD", "明确职责、硬性条件和加分项，后续准备均使用本次投递保存的 JD。", [5, 10], hasJd, null),
    material("resume", "锁定投递简历", "关联本岗位使用的已发布版本，保证诊断、自我介绍与训练使用同一份经历。", [10, 20], hasResume, null),
    material("portrait", "梳理岗位考点", portrait ? "已有关联本岗位 JD 的考点画像，可直接查看准备重点。" : "尚无匹配当前 JD 的考点画像，先提炼有原文依据的练习方向。", [5, 10], Boolean(portrait), portraitHref, !hasJd ? "先补充岗位 JD" : null),
    material("diagnosis", "检查简历与岗位匹配", diagnosis ? "已有当前 JD 与简历版本的诊断，可查看待补充的经历证据。" : "尚无当前 JD 与简历版本的诊断，先核对岗位要求与经历表述。", [10, 15], Boolean(diagnosis), diagnosis ? `/resumes/${app.resume_id}?applicationId=${app.id}&diagnosisId=${diagnosis.id}` : null, prerequisite),
    material("intro", "准备双版自我介绍", intro ? "已关联当前 JD 与简历版本的自我介绍，接下来可练习口头表达。" : "尚无匹配当前资料的自我介绍，准备 30 秒和 2 分钟两版开场。", [10, 15], Boolean(intro), introHref, prerequisite),
    manual("evidence", "整理岗位相关的项目证据", `围绕「${app.role}」的职责，选出能说明个人贡献的真实案例。`, [20, 30], [
      "从岗位 JD 中挑出两项核心职责，各选一个真实经历；没有相关经历时记录待补内容。",
      "按背景、目标、个人行动、结果整理，区分自己的工作与团队成果。",
      "核对数据来源、技术取舍和可展示材料，不确定的数字保留待核实标记。",
    ], prerequisite),
    manual("focus", "练习岗位重点问题", focus.length ? "使用本岗位考点画像中的练习题，检查概念、方案取舍与适用条件。" : "根据 JD 中明确的要求练习核心知识；生成考点画像后，这里会显示具体练习题。", [20, 30], focus.length ? focus : [
      "从 JD 中选取最核心的两项能力，分别解释概念、适用场景和限制。",
      "对每项能力用一个真实案例或明确标注的假设场景展开，说明方案取舍。",
      "把答不清的问题记下，回到岗位资料继续补充与训练。",
    ], !hasJd ? "先补充岗位 JD" : null, portraitHref),
    manual("intro-practice", "计时演练自我介绍", "有讲稿之后，还需确认表达时长、重点和自然程度。", [10, 15], [
      "打开自我介绍，分别完成一次 30 秒和 2 分钟的计时表达。",
      "脱稿再讲一遍，确保个人定位、相关经历和应聘动机清晰。",
      "删去重复铺垫，核对每项经历与已发布简历一致。",
    ], !intro ? "先准备本岗位的自我介绍" : null, introHref),
    { key: "interview", category: "training", title: "完成一场岗位模拟面试", reason: interview?.status === "finished" ? "已有匹配当前 JD 与简历版本的完整模拟面试，可查看报告。" : interview ? "本岗位已有进行中的面试，继续完成后会自动更新进度。" : "用本岗位 JD 与投递简历练习连续作答，检查临场表达和薄弱环节。", minutes: [30, 45],
      done: interview?.status === "finished", manual: false, blocked: prerequisite, action: "visit", actionLabel: interview?.status === "finished" ? "查看面试报告" : interview ? "继续面试" : "开始模拟面试", href: interviewHref, instructions: [] },
    manual("questions", "准备有针对性的反问", `围绕「${app.company} · ${app.role}」仍需确认的事项准备提问。`, [10, 15], [
      "写下 JD 中尚不明确的职责边界、团队协作方式和阶段目标。",
      "挑选 2–3 个影响求职决策的问题，避免直接假定公司存在某种问题。",
      "试着口头提问，并为每个问题准备一个具体追问。",
    ], !hasJd ? "先补充岗位 JD" : null),
  ];
  const notebook = listPreparationResources(app.id, "notebook", { limit: 1 });
  if ((notebook.total ?? 0) > 0) steps.push(manual("review", "复习本岗位错题", `本投递已关联 ${notebook.total} 道错题，优先处理答不清或反复出错的部分。`, [15, 25], [
    "打开投递资料中的错题，先不看参考答案重新作答。", "对照点评定位遗漏条件，修正后再口述一遍，并记录仍需追练的问题。",
  ], null, prepareHref));
  return steps;
}

export function getPreparationPlan(applicationId: number): PreparationPlan {
  const application = preparationApplication(applicationId);
  const key = contextKey(application);
  const saved = getDb().prepare("SELECT context_key, completed_steps, created_at FROM application_preparation_plans WHERE application_id = ?").get(applicationId) as SavedPlan | undefined;
  const stale = Boolean(saved && saved.context_key !== key);
  return { application, contextKey: key, generatedAt: !stale && saved ? saved.created_at : null, stale,
    steps: saved && !stale ? buildSteps(application, readCompleted(saved, key)) : [] };
}

/** 重复生成保留当前岗位的完成项；JD 或简历版本变化后重新建立进度。 */
export function generatePreparationPlan(applicationId: number, expectedContext: unknown): PreparationPlan {
  return inTransaction(() => {
    const current = getPreparationPlan(applicationId);
    assertContext(current, expectedContext);
    const timestamp = now();
    getDb().prepare(`INSERT INTO application_preparation_plans (application_id, context_key, completed_steps, created_at, updated_at)
      VALUES (?, ?, '[]', ?, ?) ON CONFLICT(application_id) DO UPDATE SET
      completed_steps = CASE WHEN context_key = excluded.context_key THEN completed_steps ELSE '[]' END,
      context_key = excluded.context_key, created_at = excluded.created_at, updated_at = excluded.updated_at`)
      .run(applicationId, current.contextKey, timestamp, timestamp);
    return getPreparationPlan(applicationId);
  });
}

function assertContext(plan: PreparationPlan, expectedContext: unknown) {
  if (typeof expectedContext !== "string" || expectedContext !== plan.contextKey) throw new ApplicationInputError("岗位资料已变化，请刷新后重新生成清单");
}

export function completePreparationStep(applicationId: number, input: { contextKey?: unknown; key?: unknown; done?: unknown }): PreparationPlan {
  return inTransaction(() => {
    const current = getPreparationPlan(applicationId);
    assertContext(current, input.contextKey);
    const step = current.steps.find(item => item.key === input.key);
    if (!step?.manual || typeof input.done !== "boolean" || (input.done && step.blocked)) throw new ApplicationInputError("请先完成前置资料，只能手动更新可执行的训练项");
    const saved = getDb().prepare("SELECT context_key, completed_steps, created_at FROM application_preparation_plans WHERE application_id = ?").get(applicationId) as SavedPlan;
    const completed = readCompleted(saved, current.contextKey);
    if (input.done) completed.add(step.key); else completed.delete(step.key);
    getDb().prepare("UPDATE application_preparation_plans SET completed_steps = ?, updated_at = ? WHERE application_id = ?")
      .run(JSON.stringify([...completed]), now(), applicationId);
    return getPreparationPlan(applicationId);
  });
}
