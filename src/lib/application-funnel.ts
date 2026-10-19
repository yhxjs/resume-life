import {
  FUNNEL_STAGES, STAGE_CONFIG, APPLICATION_TERMINAL_STAGES, APPLICATION_TERMINAL_STAGE_CONFIG,
  type ApplicationStage, type ApplicationTerminalStage, type FunnelApplication,
  type FunnelBatchMetric, type FunnelInsight, type FunnelMetrics, type FunnelStepMetric,
} from "@/lib/applications-types";

type Result = "active" | "passed" | "terminated" | "unknown";
const rate = (numerator: number, denominator: number): number | null =>
  denominator ? Math.round(numerator / denominator * 100) : null;

/** 每条投递在每个阶段只计一次，以最后一次到访结果为准；跳级不补造中间阶段。 */
function stageResults(app: FunnelApplication) {
  const board = new Map<ApplicationStage, Result>();
  const hiring = new Map<ApplicationTerminalStage, Result>();
  const history = [...(app.stage_history ?? [])].sort((a, b) => a.id - b.id);
  for (let i = 0; i < history.length; i++) {
    let entry = history[i]!;
    if (entry.to_stage === "rejected") {
      // 连续终止记录是归因更正：保留首次终止前的环节，按最新归因重算结果。
      let latest = entry;
      while (history[i + 1]?.from_stage === "rejected" && history[i + 1]?.to_stage === "rejected") {
        latest = history[++i]!;
      }
      entry = { ...entry, to_hiring_stage: latest.to_hiring_stage, terminal_stage: latest.terminal_stage };
    }
    const { from_stage: from, to_stage: to, from_hiring_stage: previous, to_hiring_stage: next } = entry;
    if (from === "rejected" && to !== "rejected") {
      for (const [stage, result] of board) if (result === "terminated") board.set(stage, "unknown");
      for (const [stage, result] of hiring) if (result === "terminated") hiring.set(stage, "unknown");
    }
    if (from && from !== "rejected" && from !== to) {
      board.set(from, to === "rejected" ? "terminated"
        : FUNNEL_STAGES.indexOf(to) > FUNNEL_STAGES.indexOf(from) ? "passed" : "unknown");
    }
    if (previous && previous !== next && from !== "rejected") {
      const screeningPassed = previous === "resume_screening" && from === "applied" &&
        ["interviewing", "interview", "reviewing", "offer"].includes(to);
      hiring.set(previous, to === "offer" || screeningPassed || (next && previous !== "other" && next !== "other" &&
        APPLICATION_TERMINAL_STAGES.indexOf(next) > APPLICATION_TERMINAL_STAGES.indexOf(previous))
        ? "passed" : "unknown");
    }
    if (to !== "rejected") {
      board.set(to, to === "offer" ? "passed" : "active");
      if (next) hiring.set(next, to === "offer" ? "passed" : "active");
    } else {
      // 修改终止归因时保留旧事件，但不能把一次终止统计到两个环节。
      for (const [stage, result] of hiring) if (result === "terminated") hiring.set(stage, "unknown");
      if (entry.terminal_stage) hiring.set(entry.terminal_stage, "terminated");
    }
  }

  if (app.stage !== "rejected") {
    for (const [stage, result] of board) if (result === "terminated") board.set(stage, "unknown");
    for (const [stage, result] of hiring) if (result === "terminated") hiring.set(stage, "unknown");
    board.set(app.stage, app.stage === "offer" ? "passed" : "active");
    if (app.hiring_stage) hiring.set(app.hiring_stage, app.stage === "offer" ? "passed" : "active");
  } else if (app.terminal_stage) {
    hiring.set(app.terminal_stage, "terminated");
  }
  for (const [stage, result] of board) {
    if (result === "active" && stage !== app.stage) board.set(stage, "unknown");
  }
  for (const [stage, result] of hiring) {
    if (result === "active" && (app.stage === "rejected" || stage !== app.hiring_stage)) hiring.set(stage, "unknown");
  }
  return { board, hiring };
}

/** 基于全量投递及阶段履历统计，绝不把“当前驻留数”当成流失数。 */
export function calculateFunnelMetrics(applications: FunnelApplication[]): FunnelMetrics {
  const counts: Record<ApplicationStage, number> = { interested: 0, applied: 0, interviewing: 0, interview: 0, reviewing: 0, offer: 0, rejected: 0 };
  const steps: FunnelStepMetric[] = FUNNEL_STAGES.map(stage => ({
    stage, label: STAGE_CONFIG[stage].label, desc: STAGE_CONFIG[stage].desc,
    count: 0, cumulativeCount: 0, passedCount: 0, unknownCount: 0,
    conversionRate: null, dropOffCount: 0, dropOffRate: null,
  }));
  const hiringSteps = APPLICATION_TERMINAL_STAGES.map(stage => ({
    stage, label: APPLICATION_TERMINAL_STAGE_CONFIG[stage].label,
    active: 0, passed: 0, terminated: 0, conversionRate: null as number | null,
  }));
  const reasons = new Map<string, { stage: ApplicationTerminalStage | null; reason: string; count: number }>();
  let incompleteHistoryCount = 0;
  let unknownTerminations = 0;

  for (const app of applications) {
    counts[app.stage]++;
    if (!app.stage_history?.length || app.stage_history.some(h => !h.changed_at)) incompleteHistoryCount++;
    if (app.stage === "rejected") {
      if (!app.terminal_stage) unknownTerminations++;
      const reason = app.terminal_reason || "未记录原因";
      const key = JSON.stringify([app.terminal_stage, reason]);
      const item = reasons.get(key) ?? { stage: app.terminal_stage, reason, count: 0 };
      item.count++;
      reasons.set(key, item);
    }
    const results = stageResults(app);
    for (const step of steps) {
      const result = results.board.get(step.stage);
      if (!result) continue;
      step.cumulativeCount++;
      if (result === "active") step.count++;
      else if (result === "passed") step.passedCount++;
      else if (result === "terminated") step.dropOffCount++;
      else step.unknownCount++;
    }
    for (const step of hiringSteps) {
      const result = results.hiring.get(step.stage);
      if (result && result !== "unknown") step[result]++;
    }
  }
  for (const step of steps) {
    step.conversionRate = rate(step.passedCount, step.passedCount + step.dropOffCount);
    step.dropOffRate = rate(step.dropOffCount, step.passedCount + step.dropOffCount);
  }
  for (const step of hiringSteps) step.conversionRate = rate(step.passed, step.passed + step.terminated);

  const totalApplications = applications.length;
  const totalCompleted = counts.offer + counts.rejected;
  const totalActive = totalApplications - totalCompleted;
  const insights: FunnelInsight[] = [];
  for (const step of hiringSteps) {
    if (step.passed + step.terminated < 3 || step.conversionRate === null || step.conversionRate >= 25) continue;
    insights.push({
      id: `low-${step.stage}`, severity: "warning", title: `${step.label}已结算通过率偏低`,
      description: `已有 ${step.passed + step.terminated} 份投递在此环节获得结果，建议结合终止原因复盘；进行中不计入该比例。`,
      metricHighlight: `已通过 ${step.passed} / 已终止 ${step.terminated}`,
      actionText: step.stage === "resume_screening" ? "简历排雷" : "模拟面试",
      actionHref: step.stage === "resume_screening" ? "/tools/defense" : "/interviews",
    });
  }
  if (counts.offer) insights.push({
    id: "offer-negotiation", severity: "success", title: "已有 Offer，可准备谈薪",
    description: "建议结合岗位和待遇评估录用意向。", metricHighlight: `${counts.offer} 份 Offer`,
    actionText: "薪资谈判演练", actionHref: "/tools/salary",
  });
  if (!insights.length) insights.push({
    id: "pending-results", severity: "info", title: "持续跟进，等待更多明确结果",
    description: "建议更新招聘环节与终止原因；尚未推进的投递不会被视为流失。", metricHighlight: `进行中 ${totalActive} 份`,
  });
  return {
    counts, totalApplications, totalActive, totalCompleted, totalOffers: counts.offer, totalRejected: counts.rejected,
    winRate: rate(counts.offer, totalCompleted) ?? 0, overallYieldRate: rate(counts.offer, totalApplications) ?? 0,
    steps, hiringSteps, insights, unknownTerminations, incompleteHistoryCount,
    terminationReasons: [...reasons.values()].sort((a, b) => b.count - a.count),
  };
}

export function calculateBatchFunnelMetrics(applications: FunnelApplication[]): FunnelBatchMetric[] {
  const groups = new Map<string, FunnelApplication[]>();
  for (const app of applications) {
    const key = app.batch_name.trim();
    const group = groups.get(key) ?? [];
    group.push(app);
    groups.set(key, group);
  }
  return [...groups].map(([batchName, apps]) => ({ batchName, ...calculateFunnelMetrics(apps) }));
}
