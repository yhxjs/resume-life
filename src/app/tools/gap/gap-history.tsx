"use client";

import Link from "next/link";
import { btnDanger, btnGhost, badgeAccent, badgePrimary } from "@/lib/ui";
import { parseRemedyResult } from "@/lib/career-gap-remedy";
import { remedyTitle, scenarioLabel, type RemedyRecord } from "./gap-helpers";

type GapHistoryProps = { records: RemedyRecord[]; onRemove: (id: number) => void };

export function GapHistory({ records, onRemove }: GapHistoryProps) {
  return <div className="space-y-3 pt-2"><div className="flex items-center justify-between"><h2 className="text-sm font-bold text-ink">📜 重塑对策历史记录</h2><span className="text-xs text-faint">已载入 {records.length} 份报告</span></div><div className="divide-y divide-line rounded-xl border border-line bg-card overflow-hidden">{records.map((record) => { const parsed = parseRemedyResult(record.result); return <div key={record.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 hover:bg-surface/50 transition-colors"><div className="min-w-0 space-y-1"><div className="flex items-center gap-2"><Link href={`/tools/gap/${record.id}`} className="font-medium text-ink hover:text-primary hover:underline truncate">{remedyTitle(record)}</Link><span className={record.scenario_type === "gap" ? badgeAccent : badgePrimary}>{scenarioLabel(record.scenario_type)}</span>{record.target_role && <span className="text-[11px] text-muted hidden sm:inline">→ {record.target_role}</span>}</div>{parsed && <p className="text-xs text-muted truncate">{parsed.punchline}</p>}<p className="text-[11px] text-faint">{new Date(record.created_at).toLocaleString()}</p></div><div className="flex shrink-0 items-center gap-2"><Link href={`/tools/gap/${record.id}`} className={btnGhost}>查看对策</Link><button type="button" onClick={() => onRemove(record.id)} className={btnDanger}>删除</button></div></div>; })}</div></div>;
}
