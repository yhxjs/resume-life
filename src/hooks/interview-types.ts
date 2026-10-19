"use client";

import type { ReviewTurnData } from "@/components/interview/review-turn";
import type { ReverseInterviewData } from "@/lib/interview";
import type { EvaluatorReport, InterviewReport } from "@/lib/scores";
import type { ResumeVersionBinding } from "@/components/resume/resume-version-badge";

export type InterviewTurn = ReviewTurnData;

export type SeriesRoundBrief = { id: number; round_no: number; status: string; overall: number | null };

export type InterviewData = ResumeVersionBinding & {
  id: number;
  resume_title: string;
  jd: string;
  rounds: number;
  style: string;
  series_id: number | null;
  round_no: number;
  series_status: string | null;
  series_rounds: SeriesRoundBrief[];
  status: string;
  report: InterviewReport | null;
  evaluator_report: EvaluatorReport | null;
  reverse_interview: ReverseInterviewData | null;
  created_at: string;
  finished_at: string;
  turns: InterviewTurn[];
};
