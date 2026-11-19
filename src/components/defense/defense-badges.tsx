import { badgeAccent, badgeDanger, badgePrimary } from "@/lib/ui";
import type { RiskType } from "@/lib/resume-defense";

export function DefenseRiskLevelTag({ level }: { level: unknown }) {
  switch (level) {
    case "critical": return <span className={badgeDanger}>关键信号 · 优先核实</span>;
    case "high": return <span className={badgeDanger}>核心表述待核实</span>;
    case "medium": return <span className={badgeAccent}>局部表述待补充</span>;
    case "low": return <span className={badgePrimary}>本次未发现明确问题</span>;
    default: return <span className={badgeAccent}>未提供有效风险评级</span>;
  }
}

export function DefenseRiskTypeTag({ type }: { type: RiskType }) {
  const labels: Record<RiskType, string> = {
    vague_phrase: "表述宽泛待澄清",
    data_suspicion: "数据口径待核实",
    buzzword_stuffing: "术语与实践待说明",
    scope_ambiguity: "职责边界待核实",
    logic_flaw: "逻辑或技术表述待核实",
  };
  return <span className={badgeAccent}>{Object.hasOwn(labels, type) ? labels[type] : "表述待核实"}</span>;
}

/** 与演练提示词的 90 / 70 / 50 分段一致，仅描述本次回答。 */
export function DefenseScoreTag({ score }: { score: number }) {
  if (!Number.isFinite(score) || score < 0 || score > 100) return <span className={badgeAccent}>未提供有效演练分数</span>;
  const label = score >= 90 ? "回答充分" : score >= 70 ? "核心回答正确，部分待澄清" : score >= 50 ? "关键解释待补充" : "核心问题未解决";
  const cls = score >= 90 ? badgePrimary : score >= 50 ? badgeAccent : badgeDanger;
  return <span className={cls}>{label}（{score}分）</span>;
}
