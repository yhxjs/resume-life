"use client";

import Link from "next/link";
import { useId } from "react";
import type { ResumeOption } from "@/hooks/use-resume-options";
import { inputCls, labelCls } from "@/lib/ui";

export function ResumeVersionSelect({ resume, value, onChange, disabled = false }: {
  resume: ResumeOption | undefined;
  value: number | "";
  onChange: (id: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  if (!resume) return null;
  const versions = resume.versions ?? [];
  return <div className="space-y-1">
    <label htmlFor={id} className={labelCls}>已发布版本</label>
    <select id={id} className={inputCls} value={value} disabled={disabled || versions.length === 0} onChange={(event) => onChange(Number(event.target.value))} aria-describedby={`${id}-hint`}>
      {value === "" && <option value="" disabled>{versions.length ? "请选择可用版本" : "尚未发布版本"}</option>}
      {[...versions].sort((a, b) => b.version - a.version).map((version) => <option key={version.id} value={version.id}>v{version.version} · {version.name}</option>)}
    </select>
    <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted">
      {versions.length ? "使用此版本的固定内容，后续草稿修改不会影响已有记录。" : <>请先<Link className="rounded text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-primary" href={`/resumes/${resume.id}`}>到简历编辑器发布版本</Link>，再继续使用。</>}
    </p>
  </div>;
}
