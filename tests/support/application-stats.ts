import { calculateBatchFunnelMetrics, calculateFunnelMetrics } from "../../src/lib/application-funnel";
import type { ApplicationStats, FunnelApplication, FunnelBatchMetric, FunnelMetrics } from "../../src/lib/applications-types";

/** 与统计 API 的计算来源一致，避免用残缺或旧口径的成功夹具绕过读取校验。 */
export function applicationStatsFixture(applications: FunnelApplication[] = []): ApplicationStats & { funnel: FunnelMetrics; batchStats: FunnelBatchMetric[] } {
  const funnel = calculateFunnelMetrics(applications);
  return {
    counts: { ...funnel.counts }, totalActive: funnel.totalActive, upcomingInterviews: [],
    funnel, batchStats: calculateBatchFunnelMetrics(applications),
    rates: { appliedRate: funnel.steps[0]!.conversionRate ?? 0, interviewRate: funnel.hiringSteps[0]!.conversionRate ?? 0, offerRate: funnel.winRate },
  };
}
