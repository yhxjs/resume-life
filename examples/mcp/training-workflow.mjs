import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const scores = { depth: 8, structure: 7, authenticity: 9, completeness: 6 };
const evaluation = { ...scores, comment: "解释了事务边界。", reference: "先在事务内复核输入，再提交业务变更。" };

/** Caller supplies an isolated fixture with a bank entry, category, published resume and both intro versions. */
export async function runTrainingWorkflow(call, { direction, resumeId, versionId, introId, prefix = randomUUID() }) {
  const bank = await call("list_bank_entries", { direction, kind: "tech", limit: 1 });
  const entry = bank.items[0]; assert.ok(entry);
  const selected = { entries: [{ id: entry.id, revision: entry.revision }], idempotencyKey: prefix + ":selected" };
  const session = await call("create_practice_session", selected);
  assert.deepEqual(await call("create_practice_session", selected), session);
  const question = (await call("list_practice_questions", { drillId: session.id })).items[0];
  assert.equal(question.question, entry.question);
  const basis = await call("get_practice_answer_context", { questionId: question.id });
  const answer = { questionId: question.id, answer: "我会在同一事务内校验和提交。", expectedRevision: basis.revision, evaluation, idempotencyKey: prefix + ":answer" };
  await call("submit_practice_answer", answer);
  const categories = await call("list_notebook_categories", { limit: 1 });
  const bookmark = await call("bookmark_practice_question", { source: "drill", sourceId: question.id, categoryId: categories.items[0].id, idempotencyKey: prefix + ":bookmark" });
  const notebook = await call("get_notebook_entry", { id: bookmark.id });
  assert.equal(notebook.answer, answer.answer);
  const card = await call("get_review_card", { id: notebook.review.review_card_id });
  const review = { cardId: card.id, expectedReviewCount: card.review_count, requestId: randomUUID(), grade: "good", answer: "业务修改和回执需原子提交。" };
  await call("submit_review", review);

  const project = await call("create_project", { name: "训练示例项目", idempotencyKey: prefix + ":project" });
  const projectRevision = (await call("get_project", { id: project.id })).project.revision;
  const material = await call("add_project_material", { projectId: project.id, expectedRevision: projectRevision, title: "项目笔记", content: "本项目使用短事务。", idempotencyKey: prefix + ":material" });
  const part = await call("read_record_section", { kind: "project_material", id: material.id });
  assert.equal(part.nextOffset, null); assert.equal(JSON.parse(part.text).source, "paste");
  assert.equal(JSON.parse(part.text).content, "本项目使用短事务。");
  const intro = await call("get_intro", { id: introId });
  const edit = { introId, kind: "30s", expectedRevision: intro.versions.find(version => version.kind === "30s").revision, texts: ["我参与维护本地数据库。"] };
  const preview = await call("preview_intro_edit", edit);
  assert.equal(preview.changes[0].after, edit.texts[0]);
  await call("save_intro_edit", { ...edit, previewToken: preview.previewToken, idempotencyKey: prefix + ":intro" });
  const edited = await call("get_intro", { id: introId });
  assert.equal(edited.versions.find(version => version.kind === "30s").sentences[0].text, edit.texts[0]);
  assert.deepEqual(edited.versions.find(version => version.kind === "2min"), intro.versions.find(version => version.kind === "2min"));

  const resume = await call("get_resume", { id: resumeId, versionId });
  const mock = await call("start_mock_interview", { resumeId, versionId, expectedRevision: resume.resume.revision, jd: "维护数据库", rounds: 2,
    firstQuestion: "如何确认并发写入结果？", idempotencyKey: prefix + ":mock" });
  const initial = await call("get_mock_interview_state", { interviewId: mock.id });
  const turn = { interviewId: mock.id, turnId: initial.currentTurnId, expectedRevision: initial.revision, answer: "比较事务提交后的版本。",
    evaluation: { ...scores, comment: "说明了版本校验。", next_kind: "followup", next_question: "版本冲突时如何处理？" }, idempotencyKey: prefix + ":turn" };
  await call("answer_mock_interview", turn);
  return { answer, review, selected, session, material, mock, turn, prefix };
}

/** Same requests, same receipts even if the client and server processes were restarted. */
export async function resumeTrainingWorkflow(call, { answer, review, selected, session, mock, turn, prefix }) {
  assert.deepEqual(await call("create_practice_session", selected), session);
  assert.deepEqual(await call("submit_practice_answer", answer), { id: answer.questionId });
  assert.equal((await call("get_practice_question", { id: answer.questionId })).answer, answer.answer);
  const savedReview = await call("submit_review", review);
  const checked = await call("get_review_submission", { cardId: review.cardId, requestId: review.requestId });
  assert.equal(checked.attempt.id, savedReview.id); assert.equal(checked.card.review_count, 1);
  assert.deepEqual(await call("answer_mock_interview", turn), { id: turn.turnId });
  const next = await call("get_mock_interview_state", { interviewId: mock.id });
  assert.equal(next.answered, 1); assert.equal(next.currentIndex, 2);
  await call("answer_mock_interview", { ...turn, expectedRevision: next.revision, turnId: next.currentTurnId, answer: "重新读取记录，不能覆盖其他修改。",
    evaluation: { ...turn.evaluation, depth: 9, next_kind: "question", next_question: "" }, idempotencyKey: prefix + ":turn-two" });
  const end = await call("get_mock_interview_state", { interviewId: mock.id });
  assert.equal(end.currentTurnId, null); assert.equal(end.reportSaved, false);
  const report = { interviewId: mock.id, expectedRevision: end.revision, idempotencyKey: prefix + ":finish",
    report: { jd_match: 8, strengths: "能解释并发冲突。", weaknesses: "没有列出重试条件。", suggestions: "补充重试实例。" } };
  assert.deepEqual(await call("finish_mock_interview", report), mock);
  assert.deepEqual(await call("finish_mock_interview", report), mock);
  const persisted = await call("get_interview", { id: mock.id });
  assert.equal(persisted.interview.report.depth, 8.5); assert.equal(persisted.turns.length, 2);
}
