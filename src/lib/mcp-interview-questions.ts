import { getApplicationInterviewById } from "./applications";
import { getInterviewQuestionInput, saveInterviewQuestions, type InterviewReviewQuestion } from "./application-interview-review";
import { inTransaction } from "./db";
import { McpOperationError } from "./mcp-errors";
import { mcpRevision } from "./mcp-revision";

export function getMcpInterviewQuestions(applicationId: number, interviewId: number) {
  return inTransaction(() => {
    const review = getInterviewQuestionInput(applicationId, interviewId);
    const value = { applicationId, interviewId, roundName: review.round_name, questions: review.questions,
      inputHash: review.input_hash, materialError: review.material_error };
    return { ...value, revision: mcpRevision("interview-questions", value),
      fullContent: { tool: "read_record_section", kind: "application_interview_questions", id: interviewId } };
  });
}

export function getMcpInterviewQuestionsRecord(interviewId: number) {
  const round = getApplicationInterviewById(interviewId);
  return round ? getMcpInterviewQuestions(round.application_id, interviewId) : null;
}

export function saveMcpInterviewQuestions(input: { applicationId: number; interviewId: number; expectedRevision: string; questions: InterviewReviewQuestion[] }) {
  return inTransaction(() => {
    const current = getMcpInterviewQuestions(input.applicationId, input.interviewId);
    if (current.revision !== input.expectedRevision) throw new McpOperationError("CONFLICT", "逐题记录或面试资料已更新，请重新读取后再提交");
    if (current.inputHash === null) throw new McpOperationError("INVALID_ARGUMENT", current.materialError || "面试资料无法校验，请先修复资料");
    saveInterviewQuestions(input.applicationId, input.interviewId, input.questions, current.inputHash);
    return { id: input.interviewId };
  });
}
