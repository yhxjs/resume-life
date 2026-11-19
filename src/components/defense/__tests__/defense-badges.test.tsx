// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DefenseRiskLevelTag, DefenseRiskTypeTag, DefenseScoreTag } from "../defense-badges";
import type { RiskLevel, RiskType } from "@/lib/resume-defense";

afterEach(cleanup);

describe("排雷评级与本次回答分数的展示边界", () => {
  it.each([
    [0, "核心问题未解决", "bg-danger-wash"], [49.9, "核心问题未解决", "bg-danger-wash"],
    [50, "关键解释待补充", "bg-accent-wash"], [65, "关键解释待补充", "bg-accent-wash"], [69.9, "关键解释待补充", "bg-accent-wash"],
    [70, "核心回答正确，部分待澄清", "bg-accent-wash"], [85, "核心回答正确，部分待澄清", "bg-accent-wash"], [89.9, "核心回答正确，部分待澄清", "bg-accent-wash"],
    [90, "回答充分", "bg-primary-soft"], [100, "回答充分", "bg-primary-soft"],
  ])("%s 分按 90 / 70 / 50 分段显示，保留实际分数", (score, label, color) => {
    render(<DefenseScoreTag score={score} />);
    const badge = screen.getByText(`${label}（${score}分）`);
    expect(badge.classList.contains(color)).toBe(true);
    expect(screen.queryByText(/坚不可摧|满分示范|破绽已被击穿/)).toBeNull();
  });

  it.each([NaN, Infinity, -1, 101])("无效分数 %s 不显示为已评估", (score) => {
    render(<DefenseScoreTag score={score} />);
    expect(screen.getByText("未提供有效演练分数")).toBeTruthy();
  });

  it.each([
    ["critical", "关键信号 · 优先核实"], ["high", "核心表述待核实"],
    ["medium", "局部表述待补充"], ["low", "本次未发现明确问题"], ["unknown", "未提供有效风险评级"],
  ])("风险 %s 只表示本次审阅线索", (level, label) => {
    render(<DefenseRiskLevelTag level={level as RiskLevel} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText(/风险可控|破绽百出/)).toBeNull();
  });

  it.each([
    ["vague_phrase", "表述宽泛待澄清"], ["data_suspicion", "数据口径待核实"],
    ["buzzword_stuffing", "术语与实践待说明"], ["scope_ambiguity", "职责边界待核实"],
    ["logic_flaw", "逻辑或技术表述待核实"], ["__proto__", "表述待核实"],
  ])("类别 %s 不额外推断造假、蹭成果或技术挂件", (type, label) => {
    render(<DefenseRiskTypeTag type={type as RiskType} />);
    expect(screen.getByText(label)).toBeTruthy();
  });
});
