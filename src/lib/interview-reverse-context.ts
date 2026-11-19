import { getDb } from "@/lib/db";
import { interviewStyleOf } from "@/lib/interview";
import { ResumeNotFoundError } from "@/lib/resume-errors";
import { loadResumeContext } from "@/lib/resumes";

type ReverseInterviewSource = {
  id: number;
  resume_id: number;
  resume_version_id: number | null;
  jd: string;
  style: string;
};

/** 初次组装与提交复核读取相同材料；不把旧点评、草稿或展示元数据加入比较。 */
export function loadReverseInterviewContext(interview: ReverseInterviewSource) {
  let resumeContext = "";
  try {
    resumeContext = loadResumeContext(interview.resume_id, interview.resume_version_id);
  } catch (error) {
    if (!(error instanceof ResumeNotFoundError)) throw error;
    resumeContext = "（简历已删除）";
  }
  const turns = getDb().prepare(`SELECT idx, kind, question, answer FROM interview_turns
    WHERE interview_id = ? AND answered_at != '' ORDER BY idx, id`)
    .all(interview.id) as { idx: number; kind: string; question: string; answer: string }[];
  return {
    resumeId: interview.resume_id,
    resumeVersionId: interview.resume_version_id,
    jd: interview.jd,
    persona: interviewStyleOf(interview.style).persona,
    resumeContext,
    turns,
  };
}
