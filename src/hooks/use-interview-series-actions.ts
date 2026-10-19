"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { usePreparationHref } from "@/hooks/use-preparation-href";

/**
 * 面试详情页的两个「跳走」动作：把弱项生成排雷练习、推进到进阶面试的下一轮。
 * 二者都只是发起请求后导航，不参与本页的作答状态，因此单独持有。
 */
export function useInterviewSeriesActions({
  interviewId,
  seriesId,
  isCurrent,
}: {
  interviewId: number | null;
  seriesId: number | null;
  isCurrent: () => boolean;
}) {
  const router = useRouter();
  const preparationHref = usePreparationHref();
  const [remediating, setRemediating] = useState(false);
  const [remedialError, setRemedialError] = useState("");
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState("");
  const [stateId, setStateId] = useState(interviewId);
  if (stateId !== interviewId) {
    setStateId(interviewId);
    setRemediating(false);
    setRemedialError("");
    setAdvancing(false);
    setAdvanceError("");
  }

  async function startRemediation() {
    if (!isCurrent() || interviewId === null) return;
    setRemediating(true);
    setRemedialError("");
    try {
      const result = await jsonFetch<{ id: number }>("/api/drills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "interview", interview_id: interviewId, count: 5 }),
      });
      if (!isCurrent()) return;
      router.push(`/drills/${result.id}`);
    } catch (reason) {
      if (isCurrent()) {
        setRemedialError(errorMessage(reason));
        setRemediating(false);
      }
    }
  }

  async function advance() {
    if (!isCurrent() || seriesId === null) return;
    setAdvancing(true);
    setAdvanceError("");
    try {
      const result = await jsonFetch<{ id: number }>(`/api/interviews/series/${seriesId}/advance`, {
        method: "POST",
      });
      if (!isCurrent()) return;
      router.push(preparationHref(`/interviews/${result.id}`));
    } catch (reason) {
      if (isCurrent()) {
        setAdvanceError(errorMessage(reason));
        setAdvancing(false);
      }
    }
  }

  return { remediating, remedialError, advancing, advanceError, startRemediation, advance };
}
