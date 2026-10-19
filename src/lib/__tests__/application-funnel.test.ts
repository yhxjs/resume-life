import { describe, expect, it } from 'vitest';
import { calculateBatchFunnelMetrics, calculateFunnelMetrics } from '@/lib/application-funnel';
import type { ApplicationStage, ApplicationStageHistory, ApplicationTerminalStage, FunnelApplication } from '@/lib/applications-types';

function app(id: number, stages: ApplicationStage[], batch = '', hiring: (ApplicationTerminalStage | null)[] = []): FunnelApplication {
  return { id, stage: stages.at(-1)!, batch_name: batch, hiring_stage: hiring.at(-1) ?? null,
    terminal_stage: null, terminal_reason: '',
    stage_history: stages.map((stage, i): ApplicationStageHistory => ({
      id: i + 1, application_id: id, from_stage: stages[i - 1] ?? null, to_stage: stage,
      from_hiring_stage: hiring[i - 1] ?? null, to_hiring_stage: hiring[i] ?? null,
      terminal_stage: null, reason: '', changed_at: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    })),
  };
}

describe('真实履历漏斗', () => {
  it('无数据或只有待回应时不产生流失和低通过率诊断', () => {
    expect(calculateFunnelMetrics([]).totalApplications).toBe(0);
    const metrics = calculateFunnelMetrics(Array.from({ length: 30 }, (_, i) => app(i, ['applied'], '', ['resume_screening'])));
    expect(metrics.steps.find(s => s.stage === 'applied')).toMatchObject({ count: 30, passedCount: 0, dropOffCount: 0, conversionRate: null });
    expect(metrics.hiringSteps[0]).toMatchObject({ active: 30, passed: 0, terminated: 0, conversionRate: null });
    expect(metrics.insights.some(i => i.severity === 'warning')).toBe(false);
  });
  it('通过及终止保留已到达的历史，进行中不进入已结算分母', () => {
    const passed = app(1, ['applied', 'interview', 'offer'], '春招', ['resume_screening', 'technical_interview', 'technical_interview']);
    const failed = app(2, ['applied', 'rejected'], '春招', ['resume_screening', 'resume_screening']);
    failed.terminal_stage = 'resume_screening';
    failed.terminal_reason = '岗位不匹配';
    failed.stage_history![1]!.terminal_stage = 'resume_screening';
    const metrics = calculateFunnelMetrics([passed, failed, app(3, ['applied'], '春招', ['resume_screening'])]);
    expect(metrics.steps.find(s => s.stage === 'applied')).toMatchObject({ cumulativeCount: 3, count: 1, passedCount: 1, dropOffCount: 1, conversionRate: 50 });
    expect(metrics.hiringSteps[0]).toMatchObject({ active: 1, passed: 1, terminated: 1, conversionRate: 50 });
    expect(metrics).toMatchObject({ totalActive: 1, totalOffers: 1, totalRejected: 1, winRate: 50 });
  });
  it('跳级不补造未到达阶段，回退重开不重复累计流失', () => {
    const record = app(1, ['applied', 'interview', 'applied', 'rejected', 'applied'], '', ['resume_screening', 'technical_interview', 'resume_screening', 'resume_screening', 'resume_screening']);
    record.stage_history![3]!.terminal_stage = 'resume_screening';
    const metrics = calculateFunnelMetrics([record]);
    expect(metrics.steps.find(s => s.stage === 'interviewing')!.cumulativeCount).toBe(0);
    expect(metrics.steps.find(s => s.stage === 'applied')).toMatchObject({ cumulativeCount: 1, count: 1, passedCount: 0, dropOffCount: 0 });
    expect(metrics.hiringSteps[0]).toMatchObject({ active: 1, terminated: 0, passed: 0 });
  });
  it('技术面和 HR 面分别展示进行中、已通过、已终止', () => {
    const metrics = calculateFunnelMetrics([app(1, ['interview', 'interview'], '', ['technical_interview', 'hr_interview'])]);
    expect(metrics.hiringSteps.find(s => s.stage === 'technical_interview')).toMatchObject({ passed: 1, active: 0 });
    expect(metrics.hiringSteps.find(s => s.stage === 'hr_interview')).toMatchObject({ passed: 0, active: 1 });
  });
  it.each(['interviewing', 'interview', 'reviewing', 'offer'] as ApplicationStage[])('已投递实际推进至 %s 后，简历筛选记为通过', (stage) => {
    const metrics = calculateFunnelMetrics([app(1, ['applied', stage], '', ['resume_screening', null])]);
    expect(metrics.hiringSteps[0]).toMatchObject({ active: 0, passed: 1, terminated: 0, conversionRate: 100 });
    expect(metrics.hiringSteps.find(s => s.stage === 'technical_interview')!.passed).toBe(0);
  });
  it('清除招聘环节或回退至意向不视为简历通过', () => {
    for (const stage of ['applied', 'interested'] as ApplicationStage[]) {
      const metrics = calculateFunnelMetrics([app(1, ['applied', stage], '', ['resume_screening', null])]);
      expect(metrics.hiringSteps[0]).toMatchObject({ active: 0, passed: 0, terminated: 0, conversionRate: null });
    }
  });
  it('缺失旧终止归因和变更时间时单列未知，不倒推历史', () => {
    const record = app(1, ['rejected']);
    record.stage_history![0]!.changed_at = '';
    const metrics = calculateFunnelMetrics([record]);
    expect(metrics).toMatchObject({ totalRejected: 1, unknownTerminations: 1, incompleteHistoryCount: 1 });
    expect(metrics.steps.every(s => s.dropOffCount === 0)).toBe(true);
  });
  it('从明确技术面直接记录 HR 面终止时，技术面已通过且 HR 面已终止', () => {
    const record = app(1, ['interview', 'rejected'], '', ['technical_interview', 'hr_interview']);
    record.terminal_stage = 'hr_interview';
    record.stage_history![1]!.terminal_stage = 'hr_interview';
    const metrics = calculateFunnelMetrics([record]);
    expect(metrics.hiringSteps[1]).toMatchObject({ active: 0, passed: 1, terminated: 0, conversionRate: 100 });
    expect(metrics.hiringSteps[2]).toMatchObject({ active: 0, passed: 0, terminated: 1 });
    expect(metrics.hiringSteps[0]!.passed).toBe(0);
  });
  it('在后续环节重开不据此推定原终止环节已通过', () => {
    const record = app(1, ['interview', 'rejected', 'interview'], '', ['technical_interview', 'technical_interview', 'hr_interview']);
    record.stage_history![1]!.terminal_stage = 'technical_interview';
    const metrics = calculateFunnelMetrics([record]);
    expect(metrics.hiringSteps[1]).toMatchObject({ active: 0, passed: 0, terminated: 0 });
    expect(metrics.hiringSteps[2]).toMatchObject({ active: 1, passed: 0, terminated: 0 });
  });
  it.each([
    ['hr_interview', 'other'], ['technical_interview', 'hr_interview'], ['hr_interview', 'resume_screening'],
  ] as [ApplicationTerminalStage, ApplicationTerminalStage][])('终止归因从 %s 更正为 %s 后，与直接记录最终归因口径一致', (before, after) => {
    const corrected = app(1, ['interview', 'rejected', 'rejected'], '', ['technical_interview', before, after]);
    corrected.terminal_stage = after;
    corrected.stage_history![1]!.terminal_stage = before;
    corrected.stage_history![2]!.terminal_stage = after;
    const direct = app(2, ['interview', 'rejected'], '', ['technical_interview', after]);
    direct.terminal_stage = after;
    direct.stage_history![1]!.terminal_stage = after;
    expect(calculateFunnelMetrics([corrected]).hiringSteps).toEqual(calculateFunnelMetrics([direct]).hiringSteps);
    expect(corrected.stage_history).toHaveLength(3);
  });
  it('更正终止归因不会撤销此前独立记录的技术面通过', () => {
    const record = app(1, ['interview', 'interview', 'rejected', 'rejected'], '', ['technical_interview', 'hr_interview', 'hr_interview', 'other']);
    record.terminal_stage = 'other';
    record.stage_history![2]!.terminal_stage = 'hr_interview';
    record.stage_history![3]!.terminal_stage = 'other';
    const metrics = calculateFunnelMetrics([record]);
    expect(metrics.hiringSteps[1]).toMatchObject({ passed: 1, terminated: 0 });
    expect(metrics.hiringSteps[2]).toMatchObject({ passed: 0, terminated: 0 });
    expect(metrics.hiringSteps[3]).toMatchObject({ terminated: 1 });
  });
  it('按精确批次名独立统计，空批次与字面“未分批”不会合并', () => {
    const batches = calculateBatchFunnelMetrics([app(1, ['applied'], '春招'), app(2, ['offer'], '秋招'), app(3, ['applied']), app(4, ['offer'], '未分批')]);
    expect(batches).toHaveLength(4);
    expect(batches.find(b => b.batchName === '春招')).toMatchObject({ totalActive: 1, totalOffers: 0, totalRejected: 0 });
    expect(batches.find(b => b.batchName === '秋招')).toMatchObject({ totalActive: 0, totalOffers: 1 });
  });
});
