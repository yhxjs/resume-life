import { INTERVIEW_STYLES, type InterviewStyleKey } from "./interview";

export const INTERVIEW_QUESTION_GRAPH_DRAFT_KEY = "resume-life:interview-question-graph-draft";

export type InterviewQuestionGraphDraft = {
  resumeId: number | null;
  resumeVersionId: number | null;
  jd: string;
  style: InterviewStyleKey;
};

function isNullablePositiveId(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

export function parseInterviewQuestionGraphDraft(value: unknown): InterviewQuestionGraphDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  if (!isNullablePositiveId(draft.resumeId) || !isNullablePositiveId(draft.resumeVersionId) ||
    typeof draft.jd !== "string" || !INTERVIEW_STYLES.some((style) => style.key === draft.style)) return null;
  return {
    resumeId: draft.resumeId,
    resumeVersionId: draft.resumeVersionId,
    jd: draft.jd,
    style: draft.style as InterviewStyleKey,
  };
}
