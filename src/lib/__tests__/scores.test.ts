import { describe, it, expect } from "vitest";
import {
  normalizeScores,
  normalizeReport,
  weakDimensions,
  type InterviewReport,
} from "../scores";

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
