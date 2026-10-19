"use client";

import { useEffect, useState } from "react";
import type { ResumeOption } from "@/hooks/use-resume-options";

/** 首次选择简历时默认最新发布版；列表刷新后保留已经选定的版本。 */
export function useResumeVersionSelection(
  resume: ResumeOption | undefined,
  preferredVersionId?: number | null,
) {
  const [selection, setSelection] = useState<{ key: string; id: number | "" } | null>(null);
  const key = `${resume?.id ?? ""}:${preferredVersionId ?? ""}`;
  const versions = resume?.versions ?? [];
  const latest = versions.reduce<(typeof versions)[number] | undefined>(
    (current, version) => !current || version.version > current.version ? version : current,
    undefined,
  );
  const candidate = selection?.key === key ? selection.id : preferredVersionId ?? latest?.id ?? "";
  const resumeVersionId = versions.some((version) => version.id === candidate) ? candidate : "";

  useEffect(() => {
    if (!resume || selection?.key === key) return;
    // 外部简历列表首次就绪时固定默认版本，后续刷新不会跟随最新发布版。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelection({ key, id: resumeVersionId });
  }, [resume, key, resumeVersionId, selection?.key]);

  return {
    resumeVersionId,
    setResumeVersionId: (id: number) => setSelection({ key, id }),
  };
}
