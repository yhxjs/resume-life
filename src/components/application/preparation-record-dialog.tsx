"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Modal } from "@/components/common/modal";
import { Loading } from "@/components/common/ui-bits";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import type { DiagnosisHistoryResponse } from "@/lib/diagnosis";
import type { PreparationResource } from "@/lib/application-preparation-types";
import { btnGhost, btnPrimary } from "@/lib/ui";

type NotebookRecord = { question: string; answer: string; comment: string; reference: string };
export function PreparationRecordDialog({ kind, record, applicationId, onClose }: {
  kind: "diagnosis" | "notebook"; record: PreparationResource; applicationId: number; onClose: () => void;
}) {
  const [diagnosis, setDiagnosis] = useState<DiagnosisHistoryResponse | null>(null);
  const [notebook, setNotebook] = useState<NotebookRecord | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const request = kind === "diagnosis"
      ? jsonFetch<DiagnosisHistoryResponse>(`/api/resumes/${record.resume_id}/diagnose?diagnosis_id=${record.id}`, { signal: controller.signal }).then(setDiagnosis)
      : jsonFetch<NotebookRecord>(`/api/notebook/${record.id}`, { signal: controller.signal }).then(setNotebook);
    request.catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [kind, record.id, record.resume_id, attempt]);
  const report = diagnosis?.current?.report;
  return <Modal open onClose={onClose} title={kind === "diagnosis" ? "简历诊断报告" : "错题回顾"}>
    <div className="flex items-center justify-between gap-3">
      <h2 className="font-serif text-lg font-bold">{kind === "diagnosis" ? "简历诊断报告" : "错题回顾"}</h2>
      <button type="button" className={btnGhost} onClick={onClose}>关闭</button>
    </div>
    {error ? <p role="alert" className="mt-4 text-sm text-danger">{error} <button className={btnGhost} onClick={() => { setError(""); setAttempt((value) => value + 1); }}>重试</button></p> : !diagnosis && !notebook ? <Loading /> : null}
    <div className="mt-4 max-h-[60dvh] space-y-5 overflow-y-auto break-words text-sm leading-relaxed">
      {report && <>
        <p className="font-semibold">岗位匹配度 <span className="font-mono text-xl text-primary">{report.match}</span> / 10</p>
        <p>{report.summary}</p>
        {report.modules.map((module) => <section key={module.moduleKey} className="border-t border-line pt-4">
          <h3 className="font-semibold">{module.label}</h3><p className="mt-2 text-muted">{module.gaps}</p>
          {module.suggestions.map((suggestion, index) => <details key={index} className="mt-2"><summary className="cursor-pointer">{suggestion.reason}</summary><p className="mt-2 whitespace-pre-wrap rounded-lg bg-surface p-3">{Array.isArray(suggestion.draft) ? suggestion.draft.join("\n") : suggestion.draft}</p></details>)}
        </section>)}
      </>}
      {diagnosis && !report && <p className="text-muted">报告无法读取，可返回准备页重新诊断。</p>}
      {notebook && <><h3 className="font-semibold">{notebook.question}</h3>{([ ["我的回答", notebook.answer], ["点评", notebook.comment], ["参考答案", notebook.reference] ] as const).map(([label, text]) => <section key={label}><h4 className="font-semibold">{label}</h4><p className="mt-2 whitespace-pre-wrap text-muted">{text || "暂无记录"}</p></section>)}</>}
    </div>
    {report && <Link className={`${btnPrimary} mt-5`} href={`/resumes/${record.resume_id}?diagnosisId=${record.id}&applicationId=${applicationId}`}>到简历中采纳建议</Link>}
  </Modal>;
}
