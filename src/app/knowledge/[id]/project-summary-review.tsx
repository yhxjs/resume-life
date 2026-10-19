"use client";

import type { SummaryUnitKey } from "@/lib/project-summary-diff";
import { badgeAccent, badgeDanger, badgePrimary, btnGhost, btnPrimary } from "@/lib/ui";
import type { SummaryProposal } from "./use-project-detail";

const STATUS = {
  new: { text: "新增", className: badgePrimary },
  changed: { text: "变化", className: badgeAccent },
  conflict: { text: "冲突", className: badgeDanger },
} as const;

export function ProjectSummaryReview({ proposal, selectedKeys, onToggleAdoption }: {
  proposal: SummaryProposal;
  selectedKeys: SummaryUnitKey[];
  onToggleAdoption: (key: SummaryUnitKey) => void;
}) {
  return (
    <section role="region" aria-label="本次总结差异" className="border-y border-line py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">本次总结差异</h2>
        <span className="text-xs text-muted">已采纳 {selectedKeys.length} / {proposal.comparison.length} 段</span>
      </div>
      {proposal.materialChanges.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-muted">材料变化</span>
          {proposal.materialChanges.map((material) => (
            <span key={material.id} className="rounded border border-line bg-surface px-2 py-1 text-ink">
              {material.status === "new" ? "新增" : material.status === "removed" ? "移除" : "修改"} · {material.title}
            </span>
          ))}
        </div>
      )}
      {proposal.comparison.length === 0 ? (
        <p className="text-xs text-muted">新稿与当前总结内容一致。</p>
      ) : (
        <div className="divide-y divide-line border-t border-line">
          {proposal.comparison.map((change) => {
            const selected = selectedKeys.includes(change.key);
            const status = STATUS[change.status];
            return (
              <div key={change.key} role="group" aria-label={change.label} className="py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-semibold text-ink">{change.label}</h3>
                    <span className={status.className}>{status.text}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {change.status === "conflict" && (
                      <button type="button" className={btnGhost} onClick={() => selected && onToggleAdoption(change.key)} disabled={!selected}>
                        保留我的表达
                      </button>
                    )}
                    <button type="button" className={selected ? btnGhost : btnPrimary} onClick={() => onToggleAdoption(change.key)}>
                      {selected ? "撤销采纳" : "采纳本段"}
                    </button>
                  </div>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <span className="text-[11px] font-medium text-muted">当前档案</span>
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink">{change.previous || "（空）"}</p>
                  </div>
                  <div className="min-w-0">
                    <span className="text-[11px] font-medium text-muted">本次新稿</span>
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink">{change.next || "（建议删除此段）"}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
