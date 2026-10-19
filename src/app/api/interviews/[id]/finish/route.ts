import { withRouteErrorHandling } from "@/lib/api-route";
import { checkModelField, ModelInputBudgetError } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { acquireCommandLock, getDb, inTransaction, now } from "@/lib/db";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { loadResumeContext } from "@/lib/resumes";
import { ResumeNotFoundError } from "@/lib/resume-errors";
import {
  normalizeGeneratedReport,
  normalizeEvaluatorReport,
  safeScores,
  type ScoreMap,
} from "@/lib/scores";
import { interviewStyleOf } from "@/lib/interview";
import { safeChat, LLM_FEATURES, type PromptPart } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const interviewId = Number(id);
  if (!Number.isInteger(interviewId)) {
    return NextResponse.json({ error: "无效的面试 ID" }, { status: 400 });
  }
  const release = acquireCommandLock(`interview-answer:${interviewId}`);
  if (!release) return NextResponse.json({ error: "本场面试正在处理回答或报告，请稍后重试" }, { status: 409 });
  try {
    if (req.signal.aborted) return NextResponse.json({ error: "请求已取消" }, { status: 499 });
    const db = getDb();
    const interviewQuery = db.prepare("SELECT id, resume_id, resume_version_id, jd, rounds, style, status, report, evaluator_report, reverse_interview, finished_at FROM interviews WHERE id = ?");
    const interview = interviewQuery.get(interviewId) as
      | {
          id: number;
          resume_id: number; resume_version_id: number | null;
          jd: string;
          rounds: number;
          style: string;
          status: string;
          report: string;
          evaluator_report: string;
          reverse_interview: string;
          finished_at: string;
        }
      | undefined;
    if (!interview) return NextResponse.json({ error: "面试不存在" }, { status: 404 });
    if (interview.report) {
      try {
        if (normalizeGeneratedReport(JSON.parse(interview.report), interview.style === "mining")) {
          return NextResponse.json({ error: "报告已生成" }, { status: 400 });
        }
      } catch { /* 损坏的历史报告允许重新生成。 */ }
    }

    const turnsQuery = db.prepare(
      "SELECT id, idx, kind, question, answer, comment, scores, answered_at FROM interview_turns WHERE interview_id = ? ORDER BY idx, id"
    );
    const allTurns = turnsQuery.all(interviewId) as {
      id: number;
      idx: number;
      kind: string;
      question: string;
      answer: string;
      comment: string;
      scores: string;
      answered_at: string;
    }[];
    const turns = allTurns.filter((turn) => turn.answered_at !== "");
    if (turns.length === 0) {
      return NextResponse.json({ error: "还没有任何作答，无法生成总结报告" }, { status: 400 });
    }

    const scoreMaps: ScoreMap[] = [];
    const turnParts: PromptPart[] = [];
    turns.forEach((t, index) => {
      const scores = safeScores(t.scores);
      if (scores) scoreMaps.push(scores);
      if (index > 0) turnParts.push({ trust: "trusted", text: "\n\n" });
      turnParts.push(
        { trust: "trusted", text: "【问答记录】\n元数据：" },
        {
          trust: "untrusted",
          tag: "turn_metadata",
          text: JSON.stringify({ idx: t.idx, kind: t.kind, scores }),
        },
        { trust: "trusted", text: "\n题目：" },
        { trust: "untrusted", tag: "interview_question", text: t.question },
        { trust: "trusted", text: "\n回答：" },
        { trust: "untrusted", tag: "candidate_answer", text: t.answer },
        { trust: "trusted", text: "\n点评：" },
        { trust: "untrusted", tag: "model_comment", text: t.comment },
      );
    });

    let resumeContext = "";
    try {
      resumeContext = loadResumeContext(interview.resume_id, interview.resume_version_id);
    } catch (error) {
      if (!(error instanceof ResumeNotFoundError)) throw error;
      resumeContext = "（简历已删除）";
    }

    let reverseContext = "";
    if (interview.reverse_interview) {
      try {
        const rev = JSON.parse(interview.reverse_interview);
        if (rev?.question) {
          reverseContext = `【面试尾声反问环节（加分参考）】\n候选人提问：${rev.question}\n提问水平评分：${rev.evaluation?.score ?? "-"}分（评级：${rev.evaluation?.level ?? "-"}）\n面试官点评：${rev.evaluation?.feedback ?? ""}`;
        }
      } catch {
        reverseContext = "";
      }
    }

    const styleInfo = interviewStyleOf(interview.style);
    const isMining = interview.style === "mining";

    const finishSystemPrompt = isMining
      ? `你是经历挖掘访谈官（${styleInfo.label}风格）兼资深简历教练。本次经历挖掘访谈已结束。
候选人最初只记得“做过这个项目”，在多轮启发式问答中逐步补充了细节。你需要对问答进行全盘复盘，产出两项核心成果与评估表：
1. 候选人复盘总结（岗位匹配分、强项亮点、短板与改进建议）。
2. 【经历全景与草稿清单（mining_summary）】：
   - project_name：本次深挖的项目名称。
   - background：背景与业务痛点（为什么立项、遇到什么业务或技术瓶颈、团队诉求）。
   - actions：核心行动与技术方案（采取了什么架构、攻关了哪些关键模块、候选人亲力亲为的事）。
   - tradeoffs：关键取舍与架构决策（技术选型为何选A不选B、放弃了什么方案、踩了什么坑与妥协代价）。
   - results：量化成果与价值影响（上线后的业务或技术指标提升、效率优化或稳定性表现）。
   - contribution：个人核心贡献与担当角色（候选人不可替代的个人产出与主导职责）。
   - pending_confirmations：待确认材料与信息清单（将访谈中候选人说不清、遗忘、含糊、或建议回溯原工程代码/监控/找同事求证的指标与细节列出，数组包含 category、item、source_hint）。
   - resume_bullets：精修简历描述草稿（3-5条高含金量简历经历描述，严格遵循“动词+背景痛点+技术方案/取舍+量化成效”的优秀STAR范式，可直接复制写入简历）。
3. 【主考官视角】内部提交给 HR 的真实录用与潜力评估报表（evaluator_report）。

输出严格的 JSON 格式：
{
  "jd_match": 0-10 整数,
  "strengths": "强项挖掘总结，2-3 句",
  "weaknesses": "未明细节与表达短板，2-3 句",
  "suggestions": "后续简历与面试建议，2-4 句",
  "mining_summary": {
    "project_name": "项目名称",
    "background": "背景与痛点说明",
    "actions": "核心行动与方案说明",
    "tradeoffs": "关键取舍与决策说明",
    "results": "量化成果说明",
    "contribution": "个人贡献说明",
    "pending_confirmations": [
      { "category": "量化指标", "item": "具体待核实事项", "source_hint": "核对建议渠道" }
    ],
    "resume_bullets": ["精修简历描述1", "精修简历描述2", "精修简历描述3"]
  },
  "evaluator_report": {
    "recommendation": "Strong Hire" | "Hire" | "Lean No" | "No Hire",
    "level": "如 P6 (资深前端工程师)",
    "level_justification": "定级分析说明",
    "summary_for_hr": "呈报HR的核心定调",
    "hire_reasons": ["亮点1", "亮点2"],
    "concerns_and_risks": ["风险1", "风险2"],
    "placement_suggestion": "团队定岗与试用期建议",
    "evidence_quotes": [
      { "turn_idx": 1, "topic": "考察主题", "observation": "面试官实录观察" }
    ]
  }
}
只输出合法 JSON，不要包含任何额外 Markdown 或解释文字。`
      : `你是本次面试的面试官（${styleInfo.label}风格）兼用人部门技术负责人。一场模拟面试已结束，你需要输出两部分内容：
1. 候选人复盘总结（包含岗位匹配分、强弱项与改进建议）。
2. 【面试官视角】内部提交给 HR 的真实录用评估报表（Internal Interview Feedback Sheet），语言客观犀利、专业务实，杜绝泛泛而谈。
   - 录用建议（recommendation）严格限定在：Strong Hire（强烈推荐录用/极力争取）、Hire（建议录用/达标）、Lean No（纠结/可录可不录/建议看备选或加面）、No Hire（不予录用/未达标/有硬伤）。
   - 职级对标（level）统一对标阿里 P 级标准（如：P5 核心开发、P6 资深工程师、P7 技术专家/架构师、P8 高级专家）。
   - level_justification：详细说明判定此职级的核心依据与能力边界（比如为什么给P6而不是P7，缺少了哪些层面的深度或系统权衡）。
   - summary_for_hr：呈报 HR 招聘业务伙伴的一段关键定调总结（2-4句）。
   - hire_reasons：建议录用的核心支撑理由/亮点清单（数组，每项1-2句）。
   - concerns_and_risks：潜在顾虑与风险点清单（数组，如技术死角、沟通风格、真实经历水分等）。
   - placement_suggestion：建议定岗方向及若入职试用期需重点考察/帮扶的目标。
   - evidence_quotes：从实际问答中摘录 1~3 个最具代表性的实录观察（包含 turn_idx、topic 考察点、observation 现场观察与内心判断）。

输出严格的 JSON 格式：
{
  "jd_match": 0-10 整数,
  "strengths": "强项总结，2-3 句",
  "weaknesses": "短板总结，2-3 句",
  "suggestions": "后续改进建议，2-4 句",
  "evaluator_report": {
    "recommendation": "Strong Hire" | "Hire" | "Lean No" | "No Hire",
    "level": "如 P6 (资深前端工程师)",
    "level_justification": "定级分析说明",
    "summary_for_hr": "呈报HR的核心定调",
    "hire_reasons": ["亮点1", "亮点2"],
    "concerns_and_risks": ["风险1", "风险2"],
    "placement_suggestion": "团队定岗与试用期建议",
    "evidence_quotes": [
      { "turn_idx": 1, "topic": "考察主题", "observation": "面试官实录观察" }
    ]
  }
}
只输出合法 JSON，不要包含任何额外 Markdown 或解释文字。`;

    let raw = "";
    try {
      checkModelField(interview.jd, "岗位要求（JD）");
      raw = await safeChat("evaluate", { feature: LLM_FEATURES.interviewFinish, entity: { type: "interview", id: interviewId } }, finishSystemPrompt, [
        {
          role: "user",
          parts: [
            { trust: "trusted", text: "【岗位要求】\n" },
            { trust: "untrusted", tag: "job_description", text: interview.jd },
            { trust: "trusted", text: "\n\n【候选人简历】\n" },
            { trust: "untrusted", tag: "candidate_resume", text: resumeContext },
            { trust: "trusted", text: "\n\n【全部问答】\n" },
            ...turnParts,
            ...(reverseContext
              ? [
                  { trust: "trusted", text: "\n\n" } as const,
                  { trust: "untrusted", tag: "reverse_interview", text: reverseContext } as const,
                ]
              : []),
          ],
        },
      ], { signal: req.signal });
    } catch (err) {
      if (req.signal.aborted) return NextResponse.json({ error: "请求已取消" }, { status: 499 });
      const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
      return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
    }

    let jdMatch: unknown;
    let strengths = "";
    let weaknesses = "";
    let suggestions = "";
    let rawMiningSummary: unknown = null;
    let rawEvaluatorReport: unknown = null;

    try {
      const parsed = extractJson<Record<string, unknown>>(raw);
      jdMatch = parsed.jd_match;
      strengths = typeof parsed.strengths === "string" ? parsed.strengths : "";
      weaknesses = typeof parsed.weaknesses === "string" ? parsed.weaknesses : "";
      suggestions = typeof parsed.suggestions === "string" ? parsed.suggestions : "";
      rawMiningSummary = parsed.mining_summary;
      rawEvaluatorReport = parsed.evaluator_report;
    } catch {
      jdMatch = undefined;
    }

    // 用字面量键元组遍历，可直接按维度键索引评分表，无需对评分对象做强转
    const dimensionKeys = ["depth", "structure", "authenticity", "completeness"] as const;
    const avg: Record<(typeof dimensionKeys)[number], number> = {
      depth: 0,
      structure: 0,
      authenticity: 0,
      completeness: 0,
    };
    for (const d of dimensionKeys) {
      const sum = scoreMaps.reduce((acc, s) => acc + s[d], 0);
      avg[d] = scoreMaps.length ? Math.round((sum / scoreMaps.length) * 10) / 10 : 0;
    }
    const validated = normalizeGeneratedReport({
      depth: avg.depth,
      structure: avg.structure,
      authenticity: avg.authenticity,
      completeness: avg.completeness,
      jd_match: jdMatch,
      strengths,
      weaknesses,
      suggestions,
      mining_summary: rawMiningSummary,
    }, isMining);
    if (!validated) {
      return NextResponse.json({ error: "AI 总结结果异常（缺少有效岗位匹配分、完整总结或经历挖掘成果），请重试" }, { status: 502 });
    }

    const evaluatorReport = normalizeEvaluatorReport(rawEvaluatorReport);

    const ts = now();
    // 模型等待期间不持有事务；提交前重新核对场次和全部题目，防止写入过期总结。
    const status = inTransaction(() => {
      if (req.signal.aborted) return 499;
      if (JSON.stringify(interviewQuery.get(interviewId)) !== JSON.stringify(interview) ||
          JSON.stringify(turnsQuery.all(interviewId)) !== JSON.stringify(allTurns)) return 409;
      db.prepare(
        "UPDATE interviews SET status = 'finished', report = ?, evaluator_report = ?, finished_at = ? WHERE id = ?"
      ).run(JSON.stringify(validated), evaluatorReport ? JSON.stringify(evaluatorReport) : "", ts, interviewId);
      return 200;
    });
    if (status !== 200) {
      return NextResponse.json({ error: status === 499 ? "请求已取消" : "面试状态或问答已变更，请刷新后重新生成报告" }, { status });
    }
    return NextResponse.json({
      report: validated,
      evaluator_report: evaluatorReport,
      finished_at: ts,
    });
  } finally {
    release();
  }
}

export const POST = withRouteErrorHandling("POST /api/interviews/[id]/finish", handlePost);
