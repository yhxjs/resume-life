import type { DiagnosisRecord } from "@/lib/diagnosis";
import type { ModuleData } from "@/lib/modules";
import { compareDiagnosisScores, compareDiagnosisSnapshots, type DiagnosisContentChange } from "@/lib/diagnosis-comparison";
import { DIMENSIONS } from "@/lib/scores";
import { cardCls } from "@/lib/ui";

export function scoreDelta(value: number): string {
  return value > 0 ? `+${value}` : value === 0 ? "持平" : String(value);
}

function ContentChanges({ rows, beforeLabel, afterLabel }: { rows: DiagnosisContentChange[]; beforeLabel: string; afterLabel: string }) {
  const changes = rows.filter((row) => row.status !== "unchanged");
  return changes.length === 0 ? <p className="mt-2 text-sm text-muted">简历正文未变化</p> : (
    <div className="mt-3 space-y-3">
      {changes.map((row) => (
        <section key={row.key} aria-label={`${row.label}内容变化`} className="rounded-lg border border-line p-3">
          <h4 className="text-sm font-medium">{row.label} · {row.status === "added" ? "新增" : row.status === "removed" ? "删除" : "修改"}{row.moved ? " · 顺序变化" : ""}</h4>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {[{ label: beforeLabel, text: row.before }, { label: afterLabel, text: row.after }].map(({ label, text }) => (
              <div key={label} className="min-w-0">
                <p className="text-xs font-medium text-muted">{label}</p>
                <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-surface p-2 font-sans text-xs leading-relaxed">{text ?? "（无此模块）"}</pre>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function DiagnosisChanges({ current, previous, modules }: { current: DiagnosisRecord; previous: DiagnosisRecord | null; modules: ModuleData[] }) {
  const scores = compareDiagnosisScores(previous, current);
  const changes = compareDiagnosisSnapshots(previous?.resume_snapshot ?? null, current.resume_snapshot);
  const live = compareDiagnosisSnapshots(current.resume_snapshot, { title: current.resume_snapshot.title, modules });
  return (
    <section aria-label="诊断前后变化" className={`${cardCls} p-4`}>
      <h3 className="text-sm font-semibold">与同岗位上次诊断对比</h3>
      {previous ? (
        <>
          <p className="mt-1 text-xs text-muted">对比版本：{new Date(previous.created_at).toLocaleString()} · #{previous.id}</p>
          {scores && (
            <>
              <p className="mt-2 text-sm">岗位匹配度：{previous.report!.match} → {current.report!.match}（{scoreDelta(scores.match)}）</p>
              <div className="mt-3 overflow-x-auto">
                <table aria-label="模块评分变化" className="w-full text-left text-xs">
                  <thead><tr className="border-b border-line"><th className="py-2 pr-3">模块</th>{DIMENSIONS.map((dimension) => <th key={dimension.key} className="px-2 py-2 whitespace-nowrap">{dimension.label}</th>)}</tr></thead>
                  <tbody>{scores.modules.map((module) => <tr key={module.moduleKey} className="border-b border-line last:border-0"><th className="py-2 pr-3 font-medium whitespace-nowrap">{module.label}</th>{DIMENSIONS.map(({ key }) => <td key={key} className="px-2 py-2 font-mono tabular-nums">{scoreDelta(module.scores[key])}</td>)}</tr>)}</tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-faint">评分受 AI 评估波动影响，请结合正文变化判断修改效果；新增或删除模块没有同模块分数对照。</p>
            </>
          )}
          {previous.jd !== current.jd && <details className="mt-3 text-xs"><summary className="cursor-pointer text-accent">岗位 JD 已变化，评分需结合新要求判断</summary><div className="mt-2 grid gap-3 sm:grid-cols-2"><pre className="whitespace-pre-wrap break-words font-sans">上次 JD：{previous.jd}</pre><pre className="whitespace-pre-wrap break-words font-sans">本次 JD：{current.jd}</pre></div></details>}
          {changes && <details className="mt-3"><summary className="cursor-pointer text-sm text-muted">两次诊断间的内容变化（{changes.filter((row) => row.status !== "unchanged").length} 处）</summary><ContentChanges rows={changes} beforeLabel="上次诊断时" afterLabel="本次诊断时" /></details>}
          {previous.report && <p className="mt-3 text-xs text-muted">上次建议已采纳 {previous.adoptions.length} / {previous.report.modules.reduce((sum, module) => sum + module.suggestions.length, 0)} 条；采纳记录表示曾写入，当前保留情况可在该历史报告查看。</p>}
        </>
      ) : <p className="mt-2 text-sm text-muted">这是该岗位的首次诊断，再次诊断后可查看评分和内容变化。</p>}
      {live && <details className="mt-3"><summary className="cursor-pointer text-sm text-muted">本次诊断后当前内容变化（{live.filter((row) => row.status !== "unchanged").length} 处）</summary><ContentChanges rows={live} beforeLabel="诊断时" afterLabel="当前简历" /></details>}
    </section>
  );
}
