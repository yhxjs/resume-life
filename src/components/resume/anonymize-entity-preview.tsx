"use client";

import type { AnonymizeStatistics, IdentifiedResumeEntity } from "@/lib/resume-anonymize";
import type { BasicContent } from "@/lib/modules";

export type AnonymizeEntityOverrides = Record<string, { enabled?: boolean; replacement?: string }>;

interface AnonymizeEntityEditorProps {
  autoEntities: IdentifiedResumeEntity[];
  entityOverrides: AnonymizeEntityOverrides;
  onToggleEntity: (source: string, enabled: boolean) => void;
  onReplacementChange: (source: string, replacement: string) => void;
}

interface AnonymizePreviewProps {
  stats: AnonymizeStatistics;
  originalBasic: Partial<BasicContent>;
  anonymizedBasic: Partial<BasicContent>;
  avatarEnabled: boolean;
}

export function AnonymizeEntityEditor({
  autoEntities,
  entityOverrides,
  onToggleEntity,
  onReplacementChange,
}: AnonymizeEntityEditorProps) {
  const autoCompanies = autoEntities.filter((e) => e.kind === "company");
  const autoProjects = autoEntities.filter((e) => e.kind === "project");
  const autoSchools = autoEntities.filter((e) => e.kind === "school");

  return (
    <>
    {/* 2. 自动识别的简历公司与机构名称 */}
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted flex items-center gap-1.5">
          <span>🏢</span>
          <span>自动识别的公司与机构名称 ({autoCompanies.length})</span>
        </h3>
        {autoCompanies.length > 0 && (
          <div className="flex items-center gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => autoCompanies.forEach((c) => onToggleEntity(c.source, true))}
              className="text-primary hover:underline"
            >
              全选脱敏
            </button>
            <span className="text-muted">·</span>
            <button
              type="button"
              onClick={() => autoCompanies.forEach((c) => onToggleEntity(c.source, false))}
              className="text-muted hover:underline"
            >
              取消全选
            </button>
          </div>
        )}
      </div>

      {autoCompanies.length > 0 ? (
        <div className="space-y-2">
          {autoCompanies.map((comp) => {
            const override = entityOverrides[comp.source];
            const isEnabled = override?.enabled !== undefined ? override.enabled : true;
            const rep = override?.replacement ?? comp.defaultReplacement;
            return (
              <div
                key={comp.source}
                className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 rounded-xl border border-line bg-card p-2.5 text-xs"
              >
                <label className="flex items-center gap-2 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    onChange={(e) => onToggleEntity(comp.source, e.target.checked)}
                    className="rounded border-line text-primary focus:ring-primary h-4 w-4"
                  />
                  <span className="font-semibold text-ink font-mono">{comp.source}</span>
                </label>
                <div className="flex items-center gap-2 flex-1 max-w-sm">
                  <span className="text-muted text-[11px] shrink-0">脱敏替换为:</span>
                  <input
                    type="text"
                    disabled={!isEnabled}
                    value={rep}
                    onChange={(e) => onReplacementChange(comp.source, e.target.value)}
                    className="flex-1 rounded-lg border border-line bg-surface/50 px-2 py-1 text-xs outline-none focus:border-primary disabled:opacity-40"
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-[11px] text-muted italic">未在经历中检测到公司名称。</p>
      )}
    </section>

    {/* 3. 自动识别的项目名称与代号 */}
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted flex items-center gap-1.5">
          <span>🚀</span>
          <span>自动识别的项目名称与代号 ({autoProjects.length})</span>
        </h3>
        {autoProjects.length > 0 && (
          <div className="flex items-center gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => autoProjects.forEach((p) => onToggleEntity(p.source, true))}
              className="text-primary hover:underline"
            >
              全选脱敏
            </button>
            <span className="text-muted">·</span>
            <button
              type="button"
              onClick={() => autoProjects.forEach((p) => onToggleEntity(p.source, false))}
              className="text-muted hover:underline"
            >
              取消全选
            </button>
          </div>
        )}
      </div>

      {autoProjects.length > 0 ? (
        <div className="space-y-2">
          {autoProjects.map((proj) => {
            const override = entityOverrides[proj.source];
            const isEnabled = override?.enabled !== undefined ? override.enabled : true;
            const rep = override?.replacement ?? proj.defaultReplacement;
            return (
              <div
                key={proj.source}
                className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 rounded-xl border border-line bg-card p-2.5 text-xs"
              >
                <label className="flex items-center gap-2 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    onChange={(e) => onToggleEntity(proj.source, e.target.checked)}
                    className="rounded border-line text-primary focus:ring-primary h-4 w-4"
                  />
                  <span className="font-semibold text-ink font-mono">{proj.source}</span>
                </label>
                <div className="flex items-center gap-2 flex-1 max-w-sm">
                  <span className="text-muted text-[11px] shrink-0">脱敏替换为:</span>
                  <input
                    type="text"
                    disabled={!isEnabled}
                    value={rep}
                    onChange={(e) => onReplacementChange(proj.source, e.target.value)}
                    className="flex-1 rounded-lg border border-line bg-surface/50 px-2 py-1 text-xs outline-none focus:border-primary disabled:opacity-40"
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-[11px] text-muted italic">未在经历中检测到项目名称。</p>
      )}
    </section>

    {/* 4. 自动识别的学校名称 (可选脱敏) */}
    {autoSchools.length > 0 && (
      <section className="space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted flex items-center gap-1.5">
          <span>🎓</span>
          <span>就读院校 ({autoSchools.length})</span>
        </h3>
        <div className="space-y-2">
          {autoSchools.map((sch) => {
            const override = entityOverrides[sch.source];
            const isEnabled = override?.enabled !== undefined ? override.enabled : false;
            const rep = override?.replacement ?? sch.defaultReplacement;
            return (
              <div
                key={sch.source}
                className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 rounded-xl border border-line bg-card p-2.5 text-xs"
              >
                <label className="flex items-center gap-2 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    onChange={(e) => onToggleEntity(sch.source, e.target.checked)}
                    className="rounded border-line text-primary focus:ring-primary h-4 w-4"
                  />
                  <span className="font-semibold text-ink font-mono">{sch.source}</span>
                </label>
                <div className="flex items-center gap-2 flex-1 max-w-sm">
                  <span className="text-muted text-[11px] shrink-0">脱敏替换为:</span>
                  <input
                    type="text"
                    disabled={!isEnabled}
                    value={rep}
                    onChange={(e) => onReplacementChange(sch.source, e.target.value)}
                    className="flex-1 rounded-lg border border-line bg-surface/50 px-2 py-1 text-xs outline-none focus:border-primary disabled:opacity-40"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>
    )}
    </>
  );
}

export function AnonymizePreview({
  stats,
  originalBasic,
  anonymizedBasic,
  avatarEnabled,
}: AnonymizePreviewProps) {
  return (
    <section className="rounded-xl border border-primary/20 bg-primary-soft/30 p-3.5 space-y-2">
      <div className="flex items-center justify-between text-xs font-bold text-primary">
        <span>🔍 实时脱敏检测与对比摘要</span>
        <span>
          已脱敏 {stats.maskedBasicCount} 项身份信息
          {stats.replacedOccurrencesCount > 0 && `，模块标题与正文替换 ${stats.replacedOccurrencesCount} 处敏感实体/词`}
        </span>
      </div>
      <div className="text-xs text-ink/80 space-y-1 pt-1 border-t border-primary/10">
        <div className="flex items-baseline gap-2">
          <span className="text-muted shrink-0 text-[11px]">身份脱敏:</span>
          <span className="font-mono text-xs">
            {[
              anonymizedBasic.name,
              anonymizedBasic.phone,
              anonymizedBasic.email,
              anonymizedBasic.location,
              anonymizedBasic.birthday,
            ]
              .filter(Boolean)
              .join(" · ") || "(未填写联系方式)"}
          </span>
        </div>
        {originalBasic.avatar && avatarEnabled && (
          <div className="text-[11px] text-muted flex items-center gap-1">
            <span>👤</span>
            <span>原始头像照片已安全剥离，输出排版将自动调整。</span>
          </div>
        )}
      </div>
    </section>
  );
}
