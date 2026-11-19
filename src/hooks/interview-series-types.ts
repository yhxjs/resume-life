import type { ResumeVersionBinding } from "@/components/resume/resume-version-badge";
import type { InterviewReport } from "@/lib/scores";
import type { SeriesReport } from "@/lib/series";

export type SeriesEntry = {
  interview_id: number;
  round_no: number;
  style: string;
  status: string;
  rounds: number;
  answered: number;
  report: InterviewReport | null;
};

export type SeriesData = ResumeVersionBinding & {
  id: number;
  resume_title: string;
  jd: string;
  rounds: number;
  rounds_total: number;
  status: string;
  created_at: string;
  finished_at: string;
  final_report: SeriesReport | null;
  entries: SeriesEntry[];
};
