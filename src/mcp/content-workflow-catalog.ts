import { step, type Workflow } from "./workflow-catalog-types";

export const MCP_CONTENT_WORKFLOWS: Workflow[] = [
  { id: "intro-generation", title: "生成自我介绍并核对正式稿", prerequisites: ["指定 resumeId、已发布 versionId、目标岗位 jd", "读完上下文后由外部 Agent 提供包含 30s 和 2min 的 generatedIntro"], dependencies: ["get_resume"], steps: [
    step("get_intro_generation_context", "读取固定简历、岗位及结果格式", { source: { mode: "create", resumeId: "$resumeId", versionId: "$versionId", jd: "$jd" } }, "$basis.revision"),
    step("save_generated_intro", "按同一来源保存双版本", { source: { mode: "create", resumeId: "$resumeId", versionId: "$versionId", jd: "$jd" }, expectedRevision: "$basis.revision", result: "$generatedIntro", idempotencyKey: "$persisted.introKey" }, "$intro.id"),
    step("get_intro", "读取正式稿及全文入口", { id: "$intro.id" }, "$introRecord"),
    step("read_record_section", "读完正式介绍全文", { kind: "intro", id: "$intro.id" }, "$savedIntro"),
  ] },
  { id: "project-summary", title: "生成项目总结并选择采纳", prerequisites: ["已有 projectId 与事实材料", "generatedSummary 来自完整上下文；acceptedKeys 为用户选择的变更字段"], dependencies: ["get_project", "list_project_materials"], steps: [
    step("get_project_summary_context", "读取全文材料和生成规则", { projectId: "$projectId", mode: "full" }, "$basis.revision"),
    step("preview_project_summary", "核对事实及所选字段差异", { projectId: "$projectId", mode: "full", expectedRevision: "$basis.revision", result: "$generatedSummary", acceptedKeys: "$acceptedKeys" }, "$preview.previewToken"),
    step("save_project_summary", "原子保存同一提案及历史", { projectId: "$projectId", mode: "full", expectedRevision: "$basis.revision", result: "$generatedSummary", acceptedKeys: "$acceptedKeys", previewToken: "$preview.previewToken", idempotencyKey: "$persisted.summaryKey" }, "$history.id"),
    step("list_project_summary_history", "分页核对已保存历史", { projectId: "$projectId" }, "$historyItems"),
  ] },
  { id: "practice-generation", title: "岗位出题、作答及评分", prerequisites: ["direction、jd、questionCount 与外部生成 generatedQuestions", "遍历 questions，为每道题选择 questionId、原答 answer 和外部 evaluation；每题使用独立 answerKey"], dependencies: ["get_practice_question", "list_practice_sessions"], steps: [
    step("get_practice_generation_context", "读取岗位出题要求", { source: { kind: "job", direction: "$direction", jd: "$jd", count: "$questionCount" } }, "$basis.revision"),
    step("save_generated_practice", "保存新题与场次", { source: { kind: "job", direction: "$direction", jd: "$jd", count: "$questionCount" }, expectedRevision: "$basis.revision", result: "$generatedQuestions", idempotencyKey: "$persisted.practiceKey" }, "$session.id"),
    step("list_practice_questions", "按场次遍历全部新题", { drillId: "$session.id" }, "$questions"),
    step("get_practice_answer_context", "读取当前题目评分版本", { questionId: "$questionId" }, "$answerBasis"),
    step("read_record_section", "完整读取评分背景", { kind: "practice_answer_context", id: "$questionId" }, "$fullAnswerBasis"),
    step("submit_practice_answer", "保存原答和完整评分", { questionId: "$questionId", expectedRevision: "$answerBasis.revision", answer: "$answer", evaluation: "$evaluation", idempotencyKey: "$persisted.answerKey" }, "$answered.id"),
  ] },
  { id: "review-practice", title: "到期复习与提交找回", prerequisites: ["timeZone 为用户时区；从到期卡片中选择 cardId", "用户提供 answer 和自评 grade；提交前持久保存 UUID requestId"], dependencies: [], steps: [
    step("list_review_cards", "遍历到期卡片", { scope: "due", timeZone: "$timeZone" }, "$cards"),
    step("get_review_card", "取得最新次数与历史", { id: "$cardId", timeZone: "$timeZone" }, "$card"),
    step("read_record_section", "读完题目、参考和来源", { kind: "review_card", id: "$cardId", timeZone: "$timeZone" }, "$fullCard"),
    step("submit_review", "只推进一次复习排期", { cardId: "$cardId", answer: "$answer", grade: "$grade", expectedReviewCount: "$card.review_count", requestId: "$persisted.requestId", timeZone: "$timeZone" }, "$attempt.id"),
    step("get_review_submission", "重连后用原 requestId 核对", { cardId: "$cardId", requestId: "$persisted.requestId" }, "$submission"),
  ] },
  { id: "series-create", title: "创建三轮面试系列", prerequisites: ["指定固定发布版、jd 与每场题数 rounds；firstQuestion 来自完整上下文"], dependencies: ["get_resume"], steps: [
    step("get_interview_series_context", "读取一面规则和固定简历", { source: { kind: "create", resumeId: "$resumeId", versionId: "$versionId", jd: "$jd", rounds: "$rounds" } }, "$basis.revision"),
    step("save_interview_series_result", "创建系列和第一场首题", { source: { kind: "create", resumeId: "$resumeId", versionId: "$versionId", jd: "$jd", rounds: "$rounds" }, expectedRevision: "$basis.revision", result: { question: "$firstQuestion" }, idempotencyKey: "$persisted.seriesKey" }, "$series.id"),
    step("get_interview_series", "找到第一场 ID，进入 series-round", { id: "$series.id" }, "$seriesRecord"),
    step("read_record_section", "完整读取系列及场次入口", { kind: "interview_series", id: "$series.id" }, "$fullSeries"),
  ] },
  { id: "series-round", title: "完成系列的一场面试", prerequisites: ["seriesId 与 interviewId 来自系列记录；逐题重复前四步", "至少作答一题后可结束；末题 evaluation.next_question 为空；每次提交使用独立 answerKey"], dependencies: ["get_interview", "get_resume", "get_interview_series"], steps: [
    step("get_series_interview_state", "读取当前回合和来源令牌", { seriesId: "$seriesId", interviewId: "$interviewId" }, "$state"),
    step("read_record_section", "读取已发生问答", { kind: "interview", id: "$interviewId" }, "$fullInterview"),
    step("answer_series_interview", "保存原答、评分及下一题", { seriesId: "$seriesId", interviewId: "$interviewId", turnId: "$state.currentTurnId", expectedRevision: "$state.revision", answer: "$answer", evaluation: "$evaluation", idempotencyKey: "$persisted.answerKey" }, "$answerReceipt.id"),
    step("get_series_interview_state", "重新读取作答后的版本", { seriesId: "$seriesId", interviewId: "$interviewId" }, "$afterAnswer"),
    step("finish_series_interview", "保存本场报告", { seriesId: "$seriesId", interviewId: "$interviewId", expectedRevision: "$afterAnswer.revision", report: "$report", idempotencyKey: "$persisted.reportKey" }, "$interviewId"),
  ] },
  { id: "series-advance", title: "推进系列到下一场", prerequisites: ["前一场已完成报告；三面前使用本流程", "firstQuestion 须区别于前轮全部问题"], dependencies: ["get_interview", "get_resume", "get_interview_series"], steps: [
    step("get_interview_series_context", "完整读取前轮问答和后轮要求", { source: { kind: "advance", seriesId: "$seriesId", fromInterviewId: "$interviewId" } }, "$basis.revision"),
    step("save_interview_series_result", "保存下一场首题，再进入 series-round", { source: { kind: "advance", seriesId: "$seriesId", fromInterviewId: "$interviewId" }, expectedRevision: "$basis.revision", result: { question: "$firstQuestion" }, idempotencyKey: "$persisted.advanceKey" }, "$nextInterview.id"),
  ] },
  { id: "series-finalize", title: "汇总完整三轮面试", prerequisites: ["三场报告均已完成；generatedReport 包含 verdict/strengths/weaknesses/suggestions"], dependencies: ["get_interview", "get_resume", "get_interview_series"], steps: [
    step("get_interview_series_context", "完整读取三轮报告", { source: { kind: "finalize", seriesId: "$seriesId" } }, "$basis.revision"),
    step("save_interview_series_result", "保存系列总报告，分数由服务端计算", { source: { kind: "finalize", seriesId: "$seriesId" }, expectedRevision: "$basis.revision", result: "$generatedReport", idempotencyKey: "$persisted.finalizeKey" }, "$seriesId"),
  ] },
  { id: "salary-training", title: "谈薪模拟开场、回合和总结", prerequisites: ["createSource.kind=salary-create，并提供 targetRole、expectedSalary 等工具契约字段", "openingResult、turnResult、finalResult 为外部 Agent 结果；每轮 userMessage 来自用户；重复中间两步需新 turnKey"], dependencies: [], steps: [
    step("get_career_workflow_context", "读取模拟开场规则", { source: "$createSource" }, "$openingBasis.revision"),
    step("save_career_result", "保存开场及谈判主记录", { source: "$createSource", expectedRevision: "$openingBasis.revision", result: "$openingResult", idempotencyKey: "$persisted.salaryKey" }, "$negotiation.id"),
    step("get_career_workflow_context", "绑定本轮用户原话并读取完整记录", { source: { kind: "salary-turn", negotiationId: "$negotiation.id", userMessage: "$userMessage" } }, "$turnBasis.revision"),
    step("save_career_result", "保存本轮模拟回复及点评", { source: { kind: "salary-turn", negotiationId: "$negotiation.id", userMessage: "$userMessage" }, expectedRevision: "$turnBasis.revision", result: "$turnResult", idempotencyKey: "$persisted.turnKey" }, "$turn.id"),
    step("get_career_workflow_context", "读取最终模拟条件及全部回合", { source: { kind: "salary-finalize", negotiationId: "$negotiation.id", finalWords: "$finalWords", agreedPackage: "$agreedPackage" } }, "$finalBasis.revision"),
    step("save_career_result", "保存最终报告", { source: { kind: "salary-finalize", negotiationId: "$negotiation.id", finalWords: "$finalWords", agreedPackage: "$agreedPackage" }, expectedRevision: "$finalBasis.revision", result: "$finalResult", idempotencyKey: "$persisted.finalizeKey" }, "$negotiation.id"),
    step("get_career_record", "完整读取正式存档及关联回合", { kind: "salary_negotiation", id: "$negotiation.id" }, "$salaryRecord"),
  ] },
];
