import { describe, it, expect } from "vitest";
import {
  normalizeScores,
  validateGeneratedScores,
  normalizeReport,
  normalizeEvaluatorReport,
  validateGeneratedEvaluatorReport,
  EVALUATOR_REPORT_OUTPUT_LIMITS,
  validateGeneratedReport,
  INTERVIEW_REPORT_OUTPUT_LIMITS,
  weakDimensions,
  type InterviewReport,
} from "../scores";
import { validateGeneratedSeriesReport } from "../series";

describe("scores.ts 评分与维度算法", () => {
  it("normalizeScores 正常解析 1-10 整数维度分并四舍五入", () => {
    const raw = {
      depth: 8.2,
      structure: 8.8,
      authenticity: 7,
      completeness: 8,
    };
    const result = normalizeScores(raw);
    expect(result).not.toBeNull();
    expect(result?.depth).toBe(8);
    expect(result?.structure).toBe(9);
    expect(result?.authenticity).toBe(7);
    expect(result?.completeness).toBe(8);
  });

  it("normalizeScores 对非法维度或超范围值严格校验并返回 null", () => {
    expect(normalizeScores({ depth: 15, structure: 8, authenticity: 7, completeness: 8 })).toBeNull();
    expect(normalizeScores({ depth: -1, structure: 8, authenticity: 7, completeness: 8 })).toBeNull();
    expect(normalizeScores({ depth: "invalid", structure: 8, authenticity: 7, completeness: 8 })).toBeNull();
  });

  it("normalizeScores 缺少必要维度时返回 null", () => {
    const raw = {
      depth: 8,
      // 缺少 structure, authenticity, completeness
    };
    const result = normalizeScores(raw);
    expect(result).toBeNull();
  });

  it("四维评分提取只保留分数字段，不影响完整答题响应的外围字段", () => {
    const raw = { depth: 8, structure: 8, authenticity: 8, completeness: 8, extra: 9 };
    expect(validateGeneratedScores(raw)).toEqual({ depth: 8, structure: 8, authenticity: 8, completeness: 8 });
    expect(normalizeScores(raw)).toEqual({ depth: 8, structure: 8, authenticity: 8, completeness: 8 });
  });

  it("normalizeReport 验证总结报告结构并自动根据五维平均计算 overall", () => {
    const validReport = {
      depth: 9,
      structure: 8,
      authenticity: 9,
      completeness: 8,
      jd_match: 9,
      strengths: "技术深度良好",
      weaknesses: "部分细节未交代基数",
      suggestions: "建议多结合实际压测数据",
    };
    const parsed = normalizeReport(validReport);
    expect(parsed).not.toBeNull();
    // 均值 (9+8+9+8+9)/5 = 8.6
    expect(parsed?.overall).toBe(8.6);
    expect(parsed?.strengths).toBe("技术深度良好");
  });

  it("weakDimensions 能正确找出低于 7 分的短板维度", () => {
    const report: InterviewReport = {
      depth: 9,
      structure: 6, // < 7，弱项
      authenticity: 5, // < 7，弱项
      completeness: 8,
      jd_match: 9,
      overall: 7.4,
      strengths: "",
      weaknesses: "",
      suggestions: "",
    };
    const weaks = weakDimensions(report);
    expect(weaks).toContain("structure");
    expect(weaks).toContain("authenticity");
    expect(weaks).not.toContain("depth");
  });

  it("normalizeReport 能正确解析经历挖掘产物 mining_summary", () => {
    const rawWithMining = {
      depth: 8,
      structure: 8,
      authenticity: 9,
      completeness: 8,
      jd_match: 9,
      strengths: "逻辑清晰",
      weaknesses: "缺少量化指标",
      suggestions: "补充峰值QPS数据",
      mining_summary: {
        project_name: "电商秒杀履约重构",
        background: "历史系统在双十一峰值出现线程阻塞",
        actions: "引入多级缓存与异步削峰架构",
        tradeoffs: "在强一致性与高可用之间采用最终一致性",
        results: "订单处理延迟降低60%",
        contribution: "负责核心削峰模块与降级熔断设计",
        pending_confirmations: [
          {
            category: "量化指标",
            item: "线上压测峰值 QPS 与缓存命中率",
            source_hint: "查阅原项目 Grafana 历史看板",
          },
        ],
        resume_bullets: [
          "主导秒杀履约系统重构，基于 Redis 与 RocketMQ 构建多级缓存削峰体系，平稳支撑大促洪峰",
          "针对数据库连接池打满问题设计柔性降级方案，将核心接口 P99 延迟降低 60%",
        ],
      },
    };

    const parsed = normalizeReport(rawWithMining);
    expect(parsed).not.toBeNull();
    expect(parsed?.mining_summary).toBeDefined();
    expect(parsed?.mining_summary?.project_name).toBe("电商秒杀履约重构");
    expect(parsed?.mining_summary?.pending_confirmations).toHaveLength(1);
    expect(parsed?.mining_summary?.pending_confirmations[0]?.category).toBe("量化指标");
    expect(parsed?.mining_summary?.resume_bullets).toHaveLength(2);
    expect(parsed?.mining_summary?.tradeoffs).toContain("最终一致性");
  });
});

describe("新生成面试评估的篇幅与字段契约", () => {
  const evaluator = {
    recommendation: "Lean No",
    level: "暂无法判断",
    level_justification: "目前证据范围有限。",
    summary_for_hr: "本场回答提供了部分匹配证据。",
    hire_reasons: [],
    concerns_and_risks: [],
    placement_suggestion: "补充系统设计考察后再判断。",
    evidence_quotes: [],
  };

  it("新生成评估必须显式返回证据数组，历史缺少字段时仍归一化为空数组", () => {
    expect(validateGeneratedEvaluatorReport(evaluator, [4])).not.toBeNull();
    expect(validateGeneratedEvaluatorReport({ ...evaluator, evidence_quotes: undefined }, [4])).toBeNull();
    expect(normalizeEvaluatorReport({ ...evaluator, evidence_quotes: undefined })?.evidence_quotes).toEqual([]);
  });

  it.each([
    ["Hire", "hire_reasons"],
    ["Strong Hire", "hire_reasons"],
    ["No Hire", "concerns_and_risks"],
  ] as const)("%s 的必需理由不因枚举前后空白而跳过", (recommendation, requiredList) => {
    for (const padded of [recommendation, ` ${recommendation} `, `\t${recommendation}\n`, `\u3000${recommendation}\u00a0`]) {
      const raw = { ...evaluator, recommendation: padded };
      expect(validateGeneratedEvaluatorReport(raw, [4]), JSON.stringify(padded)).toBeNull();
      expect(validateGeneratedEvaluatorReport({ ...raw, [requiredList]: ["本次回答中的具体依据"] }, [4]))
        .toMatchObject({ recommendation, [requiredList]: ["本次回答中的具体依据"] });
      expect(normalizeEvaluatorReport(raw)?.recommendation).toBe(recommendation);
    }
  });

  it("证据不足的 Lean No 保留空理由清单与前后空白兼容", () => {
    expect(validateGeneratedEvaluatorReport({ ...evaluator, recommendation: "\tLean No\n" }, [4])).toEqual(evaluator);
  });

  it.each(["strengths", "weaknesses", "suggestions"] as const)("新生成复盘拒绝 %s 的不可见或纯标点占位", (field) => {
    for (const placeholder of ["\u200b\u2060", "!!!"]) {
      expect(validateGeneratedReport({
        depth: 7, structure: 7, authenticity: 7, completeness: 7, jd_match: 7,
        strengths: "具体表现", weaknesses: "需要补充细节", suggestions: "建议补充考察", [field]: placeholder,
      }, false)).toBeNull();
    }
  });

  it.each(["level", "level_justification", "summary_for_hr", "placement_suggestion"] as const)("evaluator report 拒绝 %s 的不可见或纯标点占位", (field) => {
    for (const placeholder of ["\u200b\u2060", "!!!"]) {
      expect(validateGeneratedEvaluatorReport({ ...evaluator, [field]: placeholder }, [4])).toBeNull();
    }
  });

  it("evaluator report 的非空清单项和证据摘要必须含可见内容", () => {
    expect(validateGeneratedEvaluatorReport({ ...evaluator, recommendation: "Lean No", hire_reasons: ["\u200b"] }, [4])).toBeNull();
    expect(validateGeneratedEvaluatorReport({ ...evaluator, recommendation: "Lean No", concerns_and_risks: ["!!!"] }, [4])).toBeNull();
    expect(validateGeneratedEvaluatorReport({ ...evaluator, evidence_quotes: [
      { turn_idx: 4, topic: "\u2060", observation: "观察" },
    ] }, [4])).toBeNull();
    expect(validateGeneratedEvaluatorReport({ ...evaluator, evidence_quotes: [
      { turn_idx: 4, topic: "主题", observation: "!!!" },
    ] }, [4])).toBeNull();
  });

  it.each([
    ["level", EVALUATOR_REPORT_OUTPUT_LIMITS.level],
    ["level_justification", EVALUATOR_REPORT_OUTPUT_LIMITS.levelJustification],
    ["summary_for_hr", EVALUATOR_REPORT_OUTPUT_LIMITS.summaryForHr],
    ["placement_suggestion", EVALUATOR_REPORT_OUTPUT_LIMITS.placementSuggestion],
  ] as const)("新生成评估拒绝超长字段 %s", (field, maxChars) => {
    expect(validateGeneratedEvaluatorReport({ ...evaluator, [field]: "字".repeat(maxChars + 1) }, [4])).toBeNull();
  });

  it.each([
    ["hire_reasons", EVALUATOR_REPORT_OUTPUT_LIMITS.hireReason],
    ["concerns_and_risks", EVALUATOR_REPORT_OUTPUT_LIMITS.concern],
  ] as const)("评估拒绝超长%s条目或超过条数上限", (field, maxChars) => {
    expect(validateGeneratedEvaluatorReport({ ...evaluator, [field]: ["字".repeat(maxChars + 1)] }, [4])).toBeNull();
    expect(validateGeneratedEvaluatorReport({ ...evaluator, [field]: Array(EVALUATOR_REPORT_OUTPUT_LIMITS.listItems + 1).fill("具体依据") }, [4])).toBeNull();
  });

  it("评估证据主题与观察受篇幅限制", () => {
    expect(validateGeneratedEvaluatorReport({ ...evaluator, evidence_quotes: [
      { turn_idx: 4, topic: "字".repeat(EVALUATOR_REPORT_OUTPUT_LIMITS.topic + 1), observation: "观察" },
    ] }, [4])).toBeNull();
    expect(validateGeneratedEvaluatorReport({ ...evaluator, evidence_quotes: [
      { turn_idx: 4, topic: "主题", observation: "字".repeat(EVALUATOR_REPORT_OUTPUT_LIMITS.observation + 1) },
    ] }, [4])).toBeNull();
  });
});

describe("新生成复盘报告的篇幅契约", () => {
  const report = {
    depth: 7,
    structure: 7,
    authenticity: 7,
    completeness: 7,
    jd_match: 7,
    strengths: "具体优点。",
    weaknesses: "需要补充细节。",
    suggestions: "建议补充考察。",
  };

  it("限制总结文本长度，但不改变历史报告归一化", () => {
    expect(validateGeneratedReport(report, false)).not.toBeNull();
    expect(validateGeneratedReport({ ...report, strengths: "字".repeat(INTERVIEW_REPORT_OUTPUT_LIMITS.summaryText + 1) }, false)).toBeNull();
    expect(normalizeReport({ ...report, strengths: "字".repeat(INTERVIEW_REPORT_OUTPUT_LIMITS.summaryText + 1) })).not.toBeNull();
  });

  it("普通面试拒绝新生成的挖掘专属字段，但保留历史报告读取", () => {
    const mining = {
      project_name: "项目",
      background: "背景",
      actions: "行动",
      tradeoffs: "取舍",
      results: "结果",
      contribution: "分工",
      pending_confirmations: [],
      resume_bullets: [],
    };
    const withUnexpectedMining = { ...report, mining_summary: mining };
    expect(validateGeneratedReport(withUnexpectedMining, false)).toBeNull();
    expect(normalizeReport(withUnexpectedMining)?.mining_summary).toEqual(mining);
  });

  it("新生成面试报告和面试官报告逐层拒绝未声明字段", () => {
    const evaluator = {
      recommendation: "Hire", level: "暂无法判断", level_justification: "证据有限", summary_for_hr: "依据本场回答",
      hire_reasons: [], concerns_and_risks: [], placement_suggestion: "补充考察", evidence_quotes: [],
    };
    expect(validateGeneratedReport({ ...report, internal_note: "extra" }, false)).toBeNull();
    expect(validateGeneratedReport({ ...report, mining_summary: {
      project_name: "项目", background: "背景", actions: "行动", tradeoffs: "", results: "", contribution: "分工",
      pending_confirmations: [], resume_bullets: [], extra: true,
    } }, true)).toBeNull();
    expect(validateGeneratedEvaluatorReport({ ...evaluator, extra: true }, [4])).toBeNull();
    expect(validateGeneratedEvaluatorReport({ ...evaluator, evidence_quotes: [{ turn_idx: 4, topic: "主题", observation: "观察", extra: true }] }, [4])).toBeNull();
    expect(normalizeEvaluatorReport({ ...evaluator, extra: true })).not.toBeNull();
  });

  it("跨轮总结拒绝服务端会忽略的额外字段", () => {
    const series = { verdict: "结论", strengths: "强项", weaknesses: "待核实", suggestions: "补充考察" };
    expect(validateGeneratedSeriesReport(series, 7.5)).toMatchObject({ overall: 7.5 });
    expect(validateGeneratedSeriesReport({ ...series, overall: 9 }, 7.5)).toBeNull();
    expect(validateGeneratedSeriesReport({ ...series, extra: true }, 7.5)).toBeNull();
    expect(validateGeneratedSeriesReport({ ...series, strengths: "\u200b" }, 7.5)).toBeNull();
    expect(validateGeneratedSeriesReport({ ...series, suggestions: "!!!" }, 7.5)).toBeNull();
  });

  it("经历挖掘报告的文本和数组均按提示词上限校验", () => {
    const mining = {
      project_name: "项目",
      background: "任务背景",
      actions: "实际行动",
      tradeoffs: "",
      results: "",
      contribution: "参与执行",
      pending_confirmations: [],
      resume_bullets: [],
    };
    expect(validateGeneratedReport({ ...report, mining_summary: mining }, true)).not.toBeNull();
    expect(validateGeneratedReport({ ...report, mining_summary: { ...mining, actions: "字".repeat(INTERVIEW_REPORT_OUTPUT_LIMITS.miningText + 1) } }, true)).toBeNull();
    expect(validateGeneratedReport({ ...report, mining_summary: { ...mining, resume_bullets: Array(INTERVIEW_REPORT_OUTPUT_LIMITS.resumeBullets + 1).fill("经历") } }, true)).toBeNull();
    expect(validateGeneratedReport({ ...report, mining_summary: { ...mining, pending_confirmations: Array(INTERVIEW_REPORT_OUTPUT_LIMITS.pendingConfirmations + 1).fill({ category: "类别", item: "待核对", source_hint: "建议渠道" }) } }, true)).toBeNull();
  });

  it("挖掘字段允许未知时为空，但非空内容、简历条目和待核实字段不可用占位串", () => {
    const mining = {
      project_name: "项目", background: "背景", actions: "实际行动", tradeoffs: "", results: "", contribution: "分工",
      pending_confirmations: [], resume_bullets: [],
    };
    expect(validateGeneratedReport({ ...report, mining_summary: mining }, true)).not.toBeNull();
    expect(validateGeneratedReport({ ...report, mining_summary: { ...mining, tradeoffs: "\u200b" } }, true)).toBeNull();
    expect(validateGeneratedReport({ ...report, mining_summary: { ...mining, resume_bullets: ["!!!"] } }, true)).toBeNull();
    expect(validateGeneratedReport({ ...report, mining_summary: {
      ...mining, pending_confirmations: [{ category: "类别", item: "\u2060", source_hint: "建议渠道" }],
    } }, true)).toBeNull();
  });
});
