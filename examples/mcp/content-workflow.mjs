import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readContext } from "./helpers.mjs";
export { readContext } from "./helpers.mjs";

/** Concatenate every UTF-16 page before parsing or generating. A conflict requires a fresh first page. */

// These are synthetic outputs for protocol verification, not generated advice or candidate facts.
const scores = { depth: 8, structure: 7, authenticity: 9, completeness: 6 };
const report = { jd_match: 7, strengths: "说明了边界。", weaknesses: "缺少验证实例。", suggestions: "补充已发生的实例。" };
const salaryTurn = { hr_response: "模拟报价尚需审批，请核对保证薪数。", hr_tactics: "澄清条件",
  hr_mindset: { looseness: 20, current_attitude: "待审批", estimated_package: "模拟30k×12", tactics_label: "澄清", internal_pressure: "审批待定" },
  mentor_analysis: { user_argument_score: 7, strengths: ["区分条件"], vulnerabilities: ["条件待确认"], tactical_tips: "核实保证薪数。",
    suggested_replies: [{ title: "澄清", content: "请确认保证薪数。", rationale: "避免混用口径" }] } };

function recorder(call) {
  const receipts = [];
  return { receipts, save: async (name, args) => {
    const result = await call(name, args); receipts.push({ name, args, result }); return result;
  } };
}

/** Runs with the authoring preset; the fixture provides a published, synthetic resume. */
export async function runAuthoringWorkflow(call, { resumeId, versionId, prefix = randomUUID() }) {
  const { save, receipts } = recorder(call);
  const source = { mode: "create", resumeId, versionId, jd: "维护本地数据库" };
  const intro = await save("save_generated_intro", { source, expectedRevision: (await readContext(call, "get_intro_generation_context", { source })).revision,
    result: { versions: ["30s", "2min"].map(kind => ({ kind, sentences: [{ text: "我参与维护本地数据库，希望从事相关工作。", comment: "按事实和意向分别表达。" }] })) }, idempotencyKey: prefix + ":intro" });
  const regenerate = { mode: "regenerate", introId: intro.id, kind: "30s" };
  await save("save_generated_intro", { source: regenerate, expectedRevision: (await readContext(call, "get_intro_generation_context", { source: regenerate })).revision,
    result: { versions: [{ kind: "30s", sentences: [{ text: "我参与维护本地数据库。", comment: "保留参与程度。" }] }] }, idempotencyKey: prefix + ":regenerate" });
  const comment = { mode: "comment", introId: intro.id, kind: "30s" };
  await save("save_intro_comments", { introId: intro.id, kind: "30s", expectedRevision: (await readContext(call, "get_intro_generation_context", { source: comment })).revision,
    comments: ["保留了原有事实。"], idempotencyKey: prefix + ":comments" });
  assert.ok((await call("list_intros", { resumeId, q: "数据库" })).items.some(item => item.id === intro.id));
  await call("list_jd_portraits", { q: "数据库" });

  const project = await save("create_project", { name: "完整内容示例", idempotencyKey: prefix + ":project" });
  await save("add_project_material", { projectId: project.id, title: "事实材料", content: "参与本地数据库维护，使用 SQLite。",
    expectedRevision: (await call("get_project", { id: project.id })).project.revision, idempotencyKey: prefix + ":material" });
  const proposal = { projectId: project.id, mode: "full", expectedRevision: (await readContext(call, "get_project_summary_context", { projectId: project.id })).revision,
    result: { overview: "本地数据库维护", architecture: "使用 SQLite", highlights: "", responsibilities: "参与维护", challenges: "",
      techStack: "SQLite", brief: "本地数据库维护", achievements: ["参与本地数据库维护。"] } };
  const preview = await readContext(call, "preview_project_summary", proposal, true);
  const summary = await save("save_project_summary", { ...proposal, previewToken: preview.previewToken, idempotencyKey: prefix + ":summary" });
  assert.ok((await call("list_project_summary_history", { projectId: project.id })).items.some(item => item.id === summary.id));

  const basis = await readContext(call, "get_resume_draft_context", { resumeId });
  const draft = await save("create_resume_draft", { title: "示例岗位草稿", source: { resumeId, expectedRevision: basis.revision }, idempotencyKey: prefix + ":copy" });
  const edit = { resumeId: draft.id, expectedRevision: (await readContext(call, "get_resume_draft_context", { resumeId: draft.id })).revision,
    modules: [{ key: "skills", type: "skills", label: "技能", content: { items: ["维护本地数据库"] } }] };
  const draftPreview = await readContext(call, "preview_resume_draft_edit", edit, true);
  await save("save_resume_draft_edit", { ...edit, previewToken: draftPreview.previewToken, idempotencyKey: prefix + ":draft" });
  return { receipts, projectId: project.id, introId: intro.id, draftId: draft.id, prefix };
}

/** Runs with the training preset; no server model calls are enabled. */
export async function runExtendedTrainingWorkflow(call, { resumeId, versionId, projectId, prefix = randomUUID() }) {
  const { save, receipts } = recorder(call);
  const generated = async (contextTool, saveTool, source, result, key) => save(saveTool, { source, result,
    expectedRevision: (await readContext(call, contextTool, { source })).revision, idempotencyKey: prefix + ":" + key });
  await call("list_bank_directions");
  const practice = await generated("get_practice_generation_context", "save_generated_practice", { kind: "project", projectId, count: 1 },
    { questions: ["如何验证 SQLite 维护结果？"] }, "practice");
  const question = (await call("list_practice_questions", { drillId: practice.id })).items[0];
  await save("submit_practice_answer", { questionId: question.id, expectedRevision: (await call("get_practice_answer_context", { questionId: question.id })).revision,
    answer: "对比维护前后记录并检查事务。", evaluation: { ...scores, comment: "说明了校验方式。", reference: "根据实际情况说明事务和记录校验。" }, idempotencyKey: prefix + ":practice-answer" });
  await generated("get_practice_generation_context", "save_generated_practice", { kind: "job", jd: "维护数据库", count: 1 },
    { questions: [{ kind: "tech", question: "如何分析数据库锁等待？" }] }, "job-practice");

  const mock = await save("start_mock_interview", { resumeId, versionId, expectedRevision: (await call("get_resume", { id: resumeId, versionId })).resume.revision,
    jd: "维护数据库", rounds: 1, firstQuestion: "如何处理维护风险？", idempotencyKey: prefix + ":mock" });
  const state = await call("get_mock_interview_state", { interviewId: mock.id });
  await save("answer_mock_interview", { interviewId: mock.id, turnId: state.currentTurnId, expectedRevision: state.revision, answer: "先核对事务边界。",
    evaluation: { ...scores, comment: "说明了边界。", next_kind: "question", next_question: "" }, idempotencyKey: prefix + ":mock-answer" });
  await generated("get_interview_training_context", "save_interview_training_result", { kind: "retry", interviewId: mock.id, turnId: state.currentTurnId, answer: "还要核对提交前后的记录。" },
    { ...scores, depth: 9, comment: "补充了核对方法。", reference: "说明事务边界与核对步骤。" }, "retry");
  await generated("get_interview_training_context", "save_interview_training_result", { kind: "reference", interviewId: mock.id, turnId: state.currentTurnId },
    { reference: "根据实际情况说明事务边界与核对步骤。" }, "reference");
  await generated("get_interview_training_context", "save_interview_training_result", { kind: "reverse", interviewId: mock.id, question: "团队如何核对维护风险？" },
    { answer: "模拟团队会先核对变更范围。", evaluation: { score: 8, insight: "问题关联工作。", feedback: "问题具体。", suggestions: "可以追问核对流程。" } }, "reverse");
  await save("finish_mock_interview", { interviewId: mock.id, expectedRevision: (await call("get_mock_interview_state", { interviewId: mock.id })).revision,
    report, idempotencyKey: prefix + ":mock-finish" });
  await generated("get_practice_generation_context", "save_generated_practice", { kind: "interview", interviewId: mock.id, count: 1 },
    { questions: [{ kind: "tech", question: "怎样给事务回滚设计故障注入用例？" }] }, "weakness-practice");

  const series = await generated("get_interview_series_context", "save_interview_series_result", { kind: "create", resumeId, versionId, jd: "维护数据库", rounds: 1 },
    { question: "怎样核对事务？" }, "series");
  let interviewId = (await call("get_interview_series", { id: series.id })).interviews[0].id;
  for (let round = 1; round <= 3; round++) {
    const current = await call("get_series_interview_state", { seriesId: series.id, interviewId });
    await save("answer_series_interview", { seriesId: series.id, interviewId, turnId: current.currentTurnId, expectedRevision: current.revision,
      answer: "我会结合实际情况核对职责和验证方式。", evaluation: { ...scores, comment: "明确了边界。", next_kind: "question", next_question: "" }, idempotencyKey: `${prefix}:round-${round}` });
    await save("finish_series_interview", { seriesId: series.id, interviewId, expectedRevision: (await call("get_series_interview_state", { seriesId: series.id, interviewId })).revision,
      report, idempotencyKey: `${prefix}:report-${round}` });
    if (round < 3) interviewId = (await generated("get_interview_series_context", "save_interview_series_result", { kind: "advance", seriesId: series.id, fromInterviewId: interviewId },
      { question: round === 1 ? "如何安排协作？" : "期待怎样的团队？" }, `advance-${round}`)).id;
  }
  await generated("get_interview_series_context", "save_interview_series_result", { kind: "finalize", seriesId: series.id },
    { verdict: "具备基本表达能力。", strengths: "表达明确。", weaknesses: "需要具体实例。", suggestions: "补充真实实例。" }, "series-finalize");
  assert.ok((await call("list_interview_series", { resumeId })).items.some(item => item.id === series.id));

  const defense = await generated("get_career_workflow_context", "save_career_result", { kind: "defense", material: { type: "text", content: "参与本地数据库维护。" } },
    { risk_level: "medium", overall_roast: "需要核对职责。", items: [{ original_text: "参与本地数据库维护。", section_hint: "经历", risk_level: "medium", risk_type: "scope_ambiguity",
      interviewer_roast: "请说明具体职责。", deadly_questions: ["你负责哪部分？", "如何核对效果？"], defense_plan: { interviewer_intent: "核实职责", standard_defense: "按实际参与程度说明。", taboo_mistakes: ["编造职责"] } }] }, "defense");
  const record = (await readContext(call, "get_career_record", { kind: "resume_defense", id: defense.id })).value;
  const item = JSON.parse(record.record.scanned_items)[0];
  await generated("get_career_workflow_context", "save_career_result", { kind: "defense-drill", defenseId: defense.id, itemId: item.id, question: "你负责哪部分？", answer: "我参与维护，具体范围需要进一步核对。" },
    { defense_score: 70, interviewer_roast: "还需要具体范围。", defense_critique: "保留了不确定性。", improved_answer: "说明实际职责，避免编造。" }, "defense-drill");
  const script = { label: "真实表达", applicable_scene: "面试", script: "我有一段空档，希望按真实安排解释。", key_points: ["不编造经历"] };
  await generated("get_career_workflow_context", "save_career_result", { kind: "gap", rawStory: "有一段空档。" },
    { title: "解释空档", punchline: "按事实表达。", hr_mindset_analysis: { core_concerns: [], risk_points: [], what_hr_wants_to_hear: "具体关注点需要核实。" },
      reframe_formula: { fact_acknowledgment: "有一段空档。", positive_attribution: "原因待补充。", growth_and_value: "没有提供产出。", motivation_alignment: "岗位动机待补充。" },
      scripts: { concise: script, detailed: script, pivoting: script }, drills: [], forbidden_list: ["编造经历"], closing_tips: ["补充真实安排。"] }, "gap");
  const salary = await generated("get_career_workflow_context", "save_career_result", { kind: "salary-create", targetRole: "工程师", expectedSalary: "模拟30k×14" },
    { ...salaryTurn, initial_offer: "模拟30k×12，待审批", mentor_analysis: { ...salaryTurn.mentor_analysis, user_argument_score: 5 } }, "salary");
  await generated("get_career_workflow_context", "save_career_result", { kind: "salary-turn", negotiationId: salary.id, userMessage: "请核对保证薪数。" }, salaryTurn, "salary-turn");
  await generated("get_career_workflow_context", "save_career_result", { kind: "salary-finalize", negotiationId: salary.id },
    { final_package_summary: "模拟条件未达成一致。", score: 70, leverage_efficiency: "核对了条件。", turn_critiques: [{ turn_no: 2, gain_or_loss: "neutral", summary: "核对薪数", key_point: "仍需审批" }],
      real_world_tips: ["核对正式书面条件。"], mentor_summary: "没有把模拟回复当作承诺。" }, "salary-finalize");
  return { receipts, seriesId: series.id, salaryId: salary.id, mockId: mock.id, prefix };
}

/** After reconnect, replay exact saved requests and verify durable records. */
export async function resumeContentWorkflow(call, ...workflows) {
  for (const workflow of workflows) for (const { name, args, result } of workflow.receipts) assert.deepEqual(await call(name, args), result);
  const training = workflows.find(workflow => workflow.seriesId);
  if (training) {
    assert.equal((await call("get_interview_series", { id: training.seriesId })).status, "finished");
    assert.equal((await readContext(call, "get_career_record", { kind: "salary_negotiation", id: training.salaryId })).value.record.status, "finished");
    assert.equal((await call("get_interview", { id: training.mockId })).interview.report.depth, scores.depth);
  }
}
