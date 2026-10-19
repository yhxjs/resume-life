import { acquireCommandLock, getDb, inTransaction, now } from "@/lib/db";
import { DataGenerationConflictError } from "@/lib/data-generation";
import { interviewStyleOf } from "@/lib/interview";
import { LlmConfigError } from "@/lib/llm";
import { checkModelField } from "@/lib/llm-input-budget";
import {
  ModelProtocolError,
  parseInterviewAnswerDecision,
} from "@/lib/model-protocol";
import { loadResumeContext } from "@/lib/resumes";
import { ResumeNotFoundError } from "@/lib/resume-errors";
import { checkSafeModelInput, LLM_FEATURES, safeChatStream, type SafeMessage } from "@/lib/safe-llm";
import { normalizeReport } from "@/lib/scores";
import type { SseEmitter } from "@/lib/sse";
import { InterviewCommandError } from "./errors";
import { errorMessage } from "@/lib/error-message";
import { logServerError } from "@/lib/server-errors";
import { syncNotebookSnapshot } from "@/lib/notebook";

const ANSWER_PROMPT = (persona: string, style?: string) => {
  if (style === "mining") {
    return `你是经历挖掘访谈官（你的人设：${persona}）。候选人提交了当前题目的书面回答。你的核心目标是帮候选人挖掘出项目的真实难点、架构决策与个人贡献。
请完成两件事：
1) 评分并启发点评：四个维度各 0-10 整数——depth（挖掘出的技术深度与复杂度）、structure（表达条理性与要素完整度）、authenticity（项目细节与工程真实感）、completeness（信息挖掘覆盖度）；comment 为 2-3 句点评，明确肯定已说清的要点，并明确指出依然模糊或缺失的关键信息（如缺少量化指标、没讲清替代方案、或分工边界不清）。
2) 决定下一步：
   - 动态推进四步链条：【背景与业务痛点】→【核心行动与技术方案】→【关键取舍与架构难点决策】→【量化结果与个人核心贡献】。
   - 检查历史问答，若当前阶段信息仍单薄或候选人说“记不清/时间太久”，给予常见技术场景示例进行启发性追问；若当前阶段已挖掘充分，顺势推进到下一阶段。
   - next_kind 为 "followup"（深挖当前阶段未清细节）或 "question"（推进到下一挖掘阶段）；next_question 给出富有启发性、针对性的追问或阶段推进题目。
输出 JSON：{"comment":"...","next_question":"...","next_kind":"followup","depth":n,"structure":n,"authenticity":n,"completeness":n}。务必优先输出 comment 与 next_question，只输出 JSON。`;
  }
  return `你是面试官（你的人设：${persona}）。候选人提交了当前题目的书面回答，你的点评与追问语气都要符合这个人设。
请完成两件事：
1) 评分并点评：四个维度各 0-10 整数——depth 技术深度（原理与取舍）、structure 结构表达（STAR 与条理）、authenticity 真实性（与简历/项目材料的一致性，发现编造给低分）、completeness 完整度（覆盖问题要点）；comment 为 2-3 句点评。
2) 决定下一步：next_kind 为 "followup"（对回答中的疑点/亮点继续追问）或 "question"（换下一道题）；并给出非空的 next_question（追问或新题，围绕岗位要求与简历，避免与历史题目重复）。
输出 JSON：{"comment":"...","next_question":"...","next_kind":"followup","depth":n,"structure":n,"authenticity":n,"completeness":n}。务必优先输出 comment 与 next_question，只输出 JSON。`;
};

export type AnswerInterviewExecution = (emitter: SseEmitter) => Promise<void>;

export function prepareAnswerInterview(args: {
  interviewId: number;
  turnId: number;
  answer: string;
  requestSignal: AbortSignal;
  requestId?: string;
}): AnswerInterviewExecution {
  const { interviewId, turnId, answer, requestSignal, requestId } = args;
  try { checkModelField(answer, "回答"); }
  catch (error) { throw new InterviewCommandError(errorMessage(error), 413); }
  const db = getDb();
  const interview = db.prepare("SELECT id, resume_id, resume_version_id, jd, rounds, style, series_id, round_no, status FROM interviews WHERE id = ?").get(interviewId) as
    | { id: number; resume_id: number; resume_version_id: number | null; jd: string; rounds: number; style: string; series_id: number | null; round_no: number; status: string }
    | undefined;
  if (!interview) throw new InterviewCommandError("面试不存在", 404);
  if (interview.status !== "ongoing") throw new InterviewCommandError("面试已结束", 400);
  const turn = db.prepare("SELECT id, idx, question FROM interview_turns WHERE id = ? AND interview_id = ? AND answered_at = ''")
    .get(turnId, interviewId) as { id: number; idx: number; question: string } | undefined;
  if (!turn) throw new InterviewCommandError("该题已作答或不存在", 400);
  let resumeContext = "";
  try { resumeContext = loadResumeContext(interview.resume_id, interview.resume_version_id); }
  catch (error) {
    if (!(error instanceof ResumeNotFoundError)) throw error;
    resumeContext = "（简历已删除）";
  }
  const history = db.prepare("SELECT idx, kind, question, answer, comment FROM interview_turns WHERE interview_id = ? AND answered_at != '' ORDER BY idx")
    .all(interviewId) as { idx: number; kind: string; question: string; answer: string; comment: string }[];
  let priorFeedback = "";
  if (interview.series_id && interview.round_no > 1) {
    const rounds = db.prepare("SELECT round_no, style, report FROM interviews WHERE series_id = ? AND round_no < ? AND report != '' ORDER BY round_no")
      .all(interview.series_id, interview.round_no) as { round_no: number; style: string; report: string }[];
    priorFeedback = rounds.map((row) => {
      try {
        const report = normalizeReport(JSON.parse(row.report));
        return report ? `第${row.round_no}轮（${interviewStyleOf(row.style).label}，总分 ${report.overall}）：强项 ${report.strengths}；短板 ${report.weaknesses}` : "";
      } catch { return ""; }
    }).filter(Boolean).join("\n");
  }
  const systemPrompt = ANSWER_PROMPT(interviewStyleOf(interview.style).persona, interview.style);
  const messages: SafeMessage[] = [
    {
      role: "user",
      parts: [
        { trust: "trusted", text: "【岗位要求】\n" },
        { trust: "untrusted", tag: "job_description", text: interview.jd },
        { trust: "trusted", text: "\n\n【候选人简历】\n" },
        { trust: "untrusted", tag: "candidate_resume", text: resumeContext },
        ...(priorFeedback
          ? [
              { trust: "trusted", text: "\n\n【前几轮面试官反馈】\n" } as const,
              { trust: "untrusted", tag: "prior_interview_feedback", text: priorFeedback } as const,
            ]
          : []),
      ],
    },
  ];
  for (const item of history) {
    messages.push(
      {
        role: "assistant",
        parts: [
          { trust: "trusted", text: "【历史题目】\n" },
          {
            trust: "untrusted",
            tag: "interview_question",
            text: JSON.stringify({ idx: item.idx, kind: item.kind, question: item.question }),
          },
        ],
      },
      {
        role: "user",
        parts: [{ trust: "untrusted", tag: "candidate_answer", text: item.answer }],
      },
      {
        role: "assistant",
        parts: [
          { trust: "trusted", text: "【历史点评】\n" },
          { trust: "untrusted", tag: "model_comment", text: item.comment },
        ],
      },
    );
  }
  messages.push(
    {
      role: "assistant",
      parts: [
        { trust: "trusted", text: "【当前题目】\n" },
        {
          trust: "untrusted",
          tag: "current_question",
          text: JSON.stringify({ idx: turn.idx, question: turn.question }),
        },
      ],
    },
    {
      role: "user",
      parts: [
        { trust: "untrusted", tag: "candidate_answer", text: answer },
        { trust: "trusted", text: "\n\n请严格按上述安全规则与格式要求评分点评并决定下一步。" },
        ...(turn.idx >= interview.rounds
          ? [{
              trust: "trusted",
              text: "注意：这是最后一轮，next_kind 必须为 \"question\"；虽然不会再出题，仍须按格式给出非空的 next_question 字段。",
            } as const]
          : []),
      ],
    },
  );
  try {
    checkModelField(interview.jd, "岗位要求（JD）");
    checkSafeModelInput(systemPrompt, messages);
  } catch (error) {
    throw new InterviewCommandError(errorMessage(error), 413);
  }
  const release = acquireCommandLock(`interview-answer:${interviewId}`);
  if (!release) throw new InterviewCommandError("本场面试正在处理回答，请稍后重试", 409);

  return async (emitter) => {
    try {
      let raw: string;
      try { raw = await safeChatStream("evaluate", { feature: LLM_FEATURES.seriesAnswerGrade, entity: { type: "interview", id: interviewId } }, systemPrompt, messages, (delta) => emitter.sendDelta(delta), { signal: emitter.signal, requestId }); }
      catch (error) {
        if (error instanceof LlmConfigError || error instanceof DataGenerationConflictError) {
          emitter.sendError(error.message);
        } else {
          const loggedId = logServerError("sse.interviews.answer", error, { requestId, status: 500 });
          emitter.sendError(`服务端处理失败（${loggedId}）`);
        }
        return;
      }
      let parsed;
      try { parsed = parseInterviewAnswerDecision(raw); }
      catch (error) {
        if (error instanceof ModelProtocolError) {
          emitter.sendError(`AI 评分结果协议错误：${error.message}`);
        } else {
          const loggedId = logServerError("sse.interviews.answer", error, { requestId, status: 500 });
          emitter.sendError(`服务端处理失败（${loggedId}）`);
        }
        return;
      }
      const scores = {
        depth: parsed.depth,
        structure: parsed.structure,
        authenticity: parsed.authenticity,
        completeness: parsed.completeness,
      };
      const comment = parsed.comment;
      const nextKind = parsed.next_kind;
      const nextQuestion = parsed.next_question;
      const finished = turn.idx >= interview.rounds;
      inTransaction(() => {
        emitter.signal.throwIfAborted();
        requestSignal.throwIfAborted();
        const updated = db.prepare(`UPDATE interview_turns SET answer = ?, comment = ?, scores = ?, answered_at = ?
          WHERE id = ? AND interview_id = ? AND answered_at = '' AND question = ?
            AND EXISTS (SELECT 1 FROM interviews WHERE id = ? AND status = 'ongoing')
            AND NOT EXISTS (SELECT 1 FROM interview_turns WHERE interview_id = ? AND idx > ?)`)
          .run(answer, comment, JSON.stringify(scores), now(), turnId, interviewId, turn.question, interviewId, interviewId, turn.idx);
        if (updated.changes !== 1) throw new Error("面试状态已变更或该题已作答，请刷新后重试");
        syncNotebookSnapshot(db, "interview", turnId, {
          answer,
          comment,
          scores: JSON.stringify(scores),
        });
        if (!finished) db.prepare("INSERT INTO interview_turns (interview_id, idx, kind, question) VALUES (?, ?, ?, ?)").run(interviewId, turn.idx + 1, nextKind, nextQuestion);
        else db.prepare("UPDATE interviews SET status = 'finished', finished_at = ? WHERE id = ?").run(now(), interviewId);
      });
      emitter.sendDone({ scores, comment, next_question: nextQuestion, next_kind: nextKind, finished, natural_finished: finished });
    } finally {
      release();
    }
  };
}
