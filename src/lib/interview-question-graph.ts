import { INTERVIEW_QUESTION_MAX_CHARS } from "@/lib/prompt-guidelines";
import { hasQuestionContent, questionComparisonKey } from "@/lib/question-normalization";
import { parseModelJson } from "@/lib/model-json";
import { ModelProtocolError, validateInterviewQuestion } from "@/lib/model-protocol";
import type { InterviewStyleKey } from "@/lib/interview";

export const INTERVIEW_QUESTION_GRAPH_MAX_DEPTH = 3;
export const INTERVIEW_QUESTION_GRAPH_BRANCH_LIMIT = 2;
export const INTERVIEW_QUESTION_GRAPH_FRONTIER_LIMIT = 2;
export const INTERVIEW_QUESTION_GRAPH_HISTORY_LIMIT = 20;
export const INTERVIEW_QUESTION_GRAPH_QUESTION_MAX_CHARS = INTERVIEW_QUESTION_MAX_CHARS;
export const INTERVIEW_QUESTION_GRAPH_ANSWER_MAX_CHARS = 1_000;
export const INTERVIEW_QUESTION_GRAPH_LABEL_MAX_CHARS = 80;

export type InterviewQuestionGraphScenario = {
  label: string;
  predicted_answer: string;
  followup_question: string;
};

export type InterviewQuestionGraphBranch = {
  id: string;
  label: string;
  predictedAnswer: string;
  followup: InterviewQuestionGraphNode;
};

export type InterviewQuestionGraphAnswer = {
  id: string;
  label: string;
  predictedAnswer: string;
};

export type InterviewQuestionGraphNode = {
  id: string;
  depth: number;
  question: string;
  parentQuestion?: string;
  answerScenario?: string;
  branches: InterviewQuestionGraphBranch[];
  predictedAnswers?: InterviewQuestionGraphAnswer[];
};

export type InterviewQuestionGraphAnswerScenario = {
  label: string;
  predicted_answer: string;
};

export type InterviewQuestionGraphStart = {
  question: string;
  branches: InterviewQuestionGraphScenario[];
};

export type InterviewQuestionGraphFrontier = {
  question_id: string;
  depth: 2 | 3;
  question: string;
  parent_question: string;
  answer_scenario: string;
};

export type InterviewQuestionGraphExpansion = {
  question_id: string;
  branches: InterviewQuestionGraphScenario[];
};

export type InterviewQuestionGraphExpand = {
  expansions: InterviewQuestionGraphExpansion[];
};

export type InterviewQuestionGraphCreated = InterviewQuestionGraphStart & {
  graph_id: number;
  revision: number;
};

export type InterviewQuestionGraphExpanded = InterviewQuestionGraphExpand & {
  graph_id: number;
  revision: number;
};

export type InterviewQuestionGraphPrediction = {
  question_id: string;
  answers: InterviewQuestionGraphAnswerScenario[];
};

export type InterviewQuestionGraphPredict = {
  predictions: InterviewQuestionGraphPrediction[];
};

export type InterviewQuestionGraphPredicted = InterviewQuestionGraphPredict & {
  graph_id: number;
  revision: number;
};

export type SavedInterviewQuestionGraph = {
  id: number;
  resume_id: number;
  resume_version_id: number | null;
  resume_title: string;
  jd: string;
  style: InterviewStyleKey;
  question: string;
  graph: InterviewQuestionGraphNode;
  history: InterviewQuestionGraphNode[];
  revision: number;
  created_at: string;
  updated_at: string;
};

function parseObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseModelJson(raw.trim());
  } catch {
    throw new ModelProtocolError(`${label}不是有效 JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelProtocolError(`${label}必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

function rejectUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ModelProtocolError(`${label}包含未声明字段`);
  }
}

function nonEmptyText(value: unknown, field: string, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ModelProtocolError(`${label}字段 ${field} 必须是非空字符串`);
  }
  const text = value.trim();
  if (text.length > max || !hasQuestionContent(text)) {
    throw new ModelProtocolError(`${label}字段 ${field} 内容无效或超过 ${max} 字符`);
  }
  return text;
}

function validateBranches(value: unknown, label: string): InterviewQuestionGraphScenario[] {
  if (!Array.isArray(value) || value.length !== INTERVIEW_QUESTION_GRAPH_BRANCH_LIMIT) {
    throw new ModelProtocolError(`${label}必须恰有 ${INTERVIEW_QUESTION_GRAPH_BRANCH_LIMIT} 条回答分支`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ModelProtocolError(`${label}第 ${index + 1} 条分支必须是对象`);
    }
    const branch = entry as Record<string, unknown>;
    rejectUnexpectedKeys(branch, ["label", "predicted_answer", "followup_question"], label);
    return {
      label: nonEmptyText(branch.label, "label", INTERVIEW_QUESTION_GRAPH_LABEL_MAX_CHARS, label),
      predicted_answer: nonEmptyText(branch.predicted_answer, "predicted_answer", INTERVIEW_QUESTION_GRAPH_ANSWER_MAX_CHARS, label),
      followup_question: validateInterviewQuestion(branch.followup_question),
    };
  });
}

function validateAnswerScenarios(value: unknown, label: string): InterviewQuestionGraphAnswerScenario[] {
  if (!Array.isArray(value) || value.length !== INTERVIEW_QUESTION_GRAPH_BRANCH_LIMIT) {
    throw new ModelProtocolError(`${label}必须恰有 ${INTERVIEW_QUESTION_GRAPH_BRANCH_LIMIT} 条预测回答`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ModelProtocolError(`${label}第 ${index + 1} 条预测回答必须是对象`);
    }
    const answer = entry as Record<string, unknown>;
    rejectUnexpectedKeys(answer, ["label", "predicted_answer"], label);
    return {
      label: nonEmptyText(answer.label, "label", INTERVIEW_QUESTION_GRAPH_LABEL_MAX_CHARS, label),
      predicted_answer: nonEmptyText(answer.predicted_answer, "predicted_answer", INTERVIEW_QUESTION_GRAPH_ANSWER_MAX_CHARS, label),
    };
  });
}

function assertNewQuestions(questions: readonly string[], knownQuestions: readonly string[] = []): void {
  const seen = new Set(knownQuestions.map(questionComparisonKey));
  for (const question of questions) {
    const key = questionComparisonKey(question);
    if (seen.has(key)) {
      throw new ModelProtocolError("AI 题目图谱包含重复题目，请重试");
    }
    seen.add(key);
  }
}

export function validateInterviewQuestionGraphStart(value: unknown): InterviewQuestionGraphStart {
  const label = "AI 题目图谱首题";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelProtocolError(`${label}必须是 JSON 对象`);
  }
  const parsed = value as Record<string, unknown>;
  rejectUnexpectedKeys(parsed, ["question", "branches"], label);
  const result = {
    question: validateInterviewQuestion(parsed.question),
    branches: validateBranches(parsed.branches, label),
  };
  assertNewQuestions([result.question, ...result.branches.map((branch) => branch.followup_question)]);
  return result;
}

export function parseInterviewQuestionGraphStart(raw: string): InterviewQuestionGraphStart {
  return validateInterviewQuestionGraphStart(parseObject(raw, "AI 题目图谱首题"));
}

function graphBranch(scenario: InterviewQuestionGraphScenario, id: string, questionId: string, depth: number, parentQuestion: string): InterviewQuestionGraphBranch {
  return {
    id,
    label: scenario.label,
    predictedAnswer: scenario.predicted_answer,
    followup: {
      id: questionId,
      depth,
      question: scenario.followup_question,
      parentQuestion,
      answerScenario: scenario.predicted_answer,
      branches: [],
      ...(depth === INTERVIEW_QUESTION_GRAPH_MAX_DEPTH ? { predictedAnswers: [] } : {}),
    },
  };
}

export function createInterviewQuestionGraphRoot(start: InterviewQuestionGraphStart): InterviewQuestionGraphNode {
  return {
    id: "q1",
    depth: 1,
    question: start.question,
    branches: start.branches.map((scenario, index) => graphBranch(scenario, `a1-${index + 1}`, `q2-${index + 1}`, 2, start.question)),
  };
}

function updateQuestion(
  node: InterviewQuestionGraphNode,
  questionId: string,
  scenarios: InterviewQuestionGraphScenario[],
): InterviewQuestionGraphNode {
  if (node.id === questionId) {
    return {
      ...node,
      branches: scenarios.map((scenario, index) => graphBranch(
        scenario,
        `a3-${questionId}-${index + 1}`,
        `q3-${questionId}-${index + 1}`,
        INTERVIEW_QUESTION_GRAPH_MAX_DEPTH,
        node.question,
      )),
    };
  }
  let changed = false;
  const branches = node.branches.map((branch) => {
    const followup = updateQuestion(branch.followup, questionId, scenarios);
    changed ||= followup !== branch.followup;
    return followup === branch.followup ? branch : { ...branch, followup };
  });
  return changed ? { ...node, branches } : node;
}

export function expandInterviewQuestionGraph(
  root: InterviewQuestionGraphNode,
  expansions: InterviewQuestionGraphExpansion[],
): InterviewQuestionGraphNode {
  return expansions.reduce((current, expansion) => updateQuestion(current, expansion.question_id, expansion.branches), root);
}

function updatePredictions(
  node: InterviewQuestionGraphNode,
  questionId: string,
  answers: InterviewQuestionGraphAnswerScenario[],
): InterviewQuestionGraphNode {
  if (node.id === questionId) {
    return {
      ...node,
      predictedAnswers: answers.map((answer, index) => ({
        id: `a4-${questionId}-${index + 1}`,
        label: answer.label,
        predictedAnswer: answer.predicted_answer,
      })),
    };
  }
  let changed = false;
  const branches = node.branches.map((branch) => {
    const followup = updatePredictions(branch.followup, questionId, answers);
    changed ||= followup !== branch.followup;
    return followup === branch.followup ? branch : { ...branch, followup };
  });
  return changed ? { ...node, branches } : node;
}

export function predictInterviewQuestionGraphAnswers(
  root: InterviewQuestionGraphNode,
  predictions: InterviewQuestionGraphPrediction[],
): InterviewQuestionGraphNode {
  return predictions.reduce((current, prediction) => updatePredictions(current, prediction.question_id, prediction.answers), root);
}

export function findInterviewQuestionGraphNode(root: InterviewQuestionGraphNode, questionId: string): InterviewQuestionGraphNode | null {
  if (root.id === questionId) return root;
  for (const branch of root.branches) {
    const found = findInterviewQuestionGraphNode(branch.followup, questionId);
    if (found) return found;
  }
  return null;
}

export function collectInterviewQuestionGraphTexts(root: InterviewQuestionGraphNode): string[] {
  return [root.question, ...root.branches.flatMap((branch) => collectInterviewQuestionGraphTexts(branch.followup))];
}

export function collectInterviewQuestionGraphTextsExcludingDescendants(
  root: InterviewQuestionGraphNode,
  questionIds: readonly string[],
): string[] {
  const excluded = new Set(questionIds);
  function collect(node: InterviewQuestionGraphNode): string[] {
    if (excluded.has(node.id)) return [node.question];
    return [node.question, ...node.branches.flatMap((branch) => collect(branch.followup))];
  }
  return collect(root);
}

export function parseInterviewQuestionGraphDocument(value: unknown): InterviewQuestionGraphNode {
  const ids = new Set<string>();
  const questions: string[] = [];
  function parseNode(input: unknown, expectedDepth: number, expectedParentQuestion?: string, expectedAnswerScenario?: string): InterviewQuestionGraphNode {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ModelProtocolError("保存的题目图谱节点无效");
    const node = input as Record<string, unknown>;
    rejectUnexpectedKeys(node, ["id", "depth", "question", "parentQuestion", "answerScenario", "branches", "predictedAnswers"], "保存的题目图谱节点");
    if (typeof node.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(node.id) || ids.has(node.id)) {
      throw new ModelProtocolError("保存的题目图谱包含无效或重复 ID");
    }
    if (node.depth !== expectedDepth || expectedDepth > INTERVIEW_QUESTION_GRAPH_MAX_DEPTH) {
      throw new ModelProtocolError("保存的题目图谱深度无效");
    }
    ids.add(node.id);
    const question = validateInterviewQuestion(node.question);
    questions.push(question);
    if (expectedDepth === 1) {
      if (node.parentQuestion !== undefined || node.answerScenario !== undefined) throw new ModelProtocolError("主问题不能包含父题信息");
    } else {
      const parentQuestion = nonEmptyText(node.parentQuestion, "parentQuestion", INTERVIEW_QUESTION_GRAPH_QUESTION_MAX_CHARS, "保存的题目图谱");
      const answerScenario = nonEmptyText(node.answerScenario, "answerScenario", INTERVIEW_QUESTION_GRAPH_ANSWER_MAX_CHARS, "保存的题目图谱");
      if (parentQuestion !== expectedParentQuestion || answerScenario !== expectedAnswerScenario) {
        throw new ModelProtocolError("保存的题目图谱父题关系无效");
      }
    }
    if (!Array.isArray(node.branches) ||
      (expectedDepth === 1 && node.branches.length !== INTERVIEW_QUESTION_GRAPH_BRANCH_LIMIT) ||
      (node.branches.length !== 0 && node.branches.length !== INTERVIEW_QUESTION_GRAPH_BRANCH_LIMIT) ||
      (expectedDepth === INTERVIEW_QUESTION_GRAPH_MAX_DEPTH && node.branches.length !== 0)) {
      throw new ModelProtocolError("保存的题目图谱分支数量无效");
    }
    const branches = node.branches.map((inputBranch) => {
      if (!inputBranch || typeof inputBranch !== "object" || Array.isArray(inputBranch)) throw new ModelProtocolError("保存的题目图谱分支无效");
      const branch = inputBranch as Record<string, unknown>;
      rejectUnexpectedKeys(branch, ["id", "label", "predictedAnswer", "followup"], "保存的题目图谱分支");
      if (typeof branch.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(branch.id) || ids.has(branch.id)) {
        throw new ModelProtocolError("保存的题目图谱包含无效或重复 ID");
      }
      ids.add(branch.id);
      const label = nonEmptyText(branch.label, "label", INTERVIEW_QUESTION_GRAPH_LABEL_MAX_CHARS, "保存的题目图谱");
      const predictedAnswer = nonEmptyText(branch.predictedAnswer, "predictedAnswer", INTERVIEW_QUESTION_GRAPH_ANSWER_MAX_CHARS, "保存的题目图谱");
      const followup = parseNode(branch.followup, expectedDepth + 1, question, predictedAnswer);
      return { id: branch.id, label, predictedAnswer, followup };
    });
    if (expectedDepth !== INTERVIEW_QUESTION_GRAPH_MAX_DEPTH && node.predictedAnswers !== undefined) {
      throw new ModelProtocolError("预测回答只能出现在最深层题目");
    }
    let predictedAnswers: InterviewQuestionGraphAnswer[] | undefined;
    if (expectedDepth === INTERVIEW_QUESTION_GRAPH_MAX_DEPTH) {
      const inputAnswers = node.predictedAnswers === undefined ? [] : node.predictedAnswers;
      if (!Array.isArray(inputAnswers) || (inputAnswers.length !== 0 && inputAnswers.length !== INTERVIEW_QUESTION_GRAPH_BRANCH_LIMIT)) {
        throw new ModelProtocolError("保存的题目图谱预测回答数量无效");
      }
      predictedAnswers = inputAnswers.map((inputAnswer) => {
        if (!inputAnswer || typeof inputAnswer !== "object" || Array.isArray(inputAnswer)) throw new ModelProtocolError("保存的题目图谱预测回答无效");
        const answer = inputAnswer as Record<string, unknown>;
        rejectUnexpectedKeys(answer, ["id", "label", "predictedAnswer"], "保存的题目图谱预测回答");
        if (typeof answer.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(answer.id) || ids.has(answer.id)) {
          throw new ModelProtocolError("保存的题目图谱包含无效或重复 ID");
        }
        ids.add(answer.id);
        return {
          id: answer.id,
          label: nonEmptyText(answer.label, "label", INTERVIEW_QUESTION_GRAPH_LABEL_MAX_CHARS, "保存的题目图谱"),
          predictedAnswer: nonEmptyText(answer.predictedAnswer, "predictedAnswer", INTERVIEW_QUESTION_GRAPH_ANSWER_MAX_CHARS, "保存的题目图谱"),
        };
      });
    }
    return {
      id: node.id,
      depth: expectedDepth,
      question,
      ...(expectedDepth > 1 ? { parentQuestion: node.parentQuestion as string, answerScenario: node.answerScenario as string } : {}),
      branches,
      ...(predictedAnswers ? { predictedAnswers } : {}),
    };
  }

  const root = parseNode(value, 1);
  assertNewQuestions(questions);
  return root;
}

export function validateInterviewQuestionGraphCreated(value: unknown): InterviewQuestionGraphCreated {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelProtocolError("题目图谱保存响应无效");
  const response = value as Record<string, unknown>;
  rejectUnexpectedKeys(response, ["question", "branches", "graph_id", "revision"], "题目图谱保存响应");
  if (!Number.isSafeInteger(response.graph_id) || (response.graph_id as number) <= 0 || response.revision !== 0) {
    throw new ModelProtocolError("题目图谱保存响应缺少有效记录编号");
  }
  const result = validateInterviewQuestionGraphStart({ question: response.question, branches: response.branches });
  return { ...result, graph_id: response.graph_id as number, revision: 0 };
}

export function validateSavedInterviewQuestionGraph(value: unknown): SavedInterviewQuestionGraph {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelProtocolError("题目图谱历史记录无效");
  const row = value as Record<string, unknown>;
  const styles: InterviewStyleKey[] = ["gentle", "stress", "deep", "manager", "hr", "mining"];
  if (!Number.isSafeInteger(row.id) || (row.id as number) < 1 ||
    !Number.isSafeInteger(row.resume_id) || (row.resume_id as number) < 1 ||
    !(row.resume_version_id === null || (Number.isSafeInteger(row.resume_version_id) && (row.resume_version_id as number) > 0)) ||
    typeof row.resume_title !== "string" || typeof row.jd !== "string" || !styles.includes(row.style as InterviewStyleKey) ||
    typeof row.question !== "string" || !Number.isSafeInteger(row.revision) || (row.revision as number) < 0 ||
    typeof row.created_at !== "string" || typeof row.updated_at !== "string" || !Array.isArray(row.history) || row.history.length > INTERVIEW_QUESTION_GRAPH_HISTORY_LIMIT) {
    throw new ModelProtocolError("题目图谱历史记录字段无效");
  }
  const graph = parseInterviewQuestionGraphDocument(row.graph);
  const history = row.history.map(parseInterviewQuestionGraphDocument);
  if (row.question !== graph.question) throw new ModelProtocolError("题目图谱历史记录主问题不匹配");
  return {
    id: row.id as number,
    resume_id: row.resume_id as number,
    resume_version_id: row.resume_version_id as number | null,
    resume_title: row.resume_title,
    jd: row.jd,
    style: row.style as InterviewStyleKey,
    question: row.question,
    graph,
    history,
    revision: row.revision as number,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function validateInterviewQuestionGraphExpanded(
  value: unknown,
  expectedQuestionIds: readonly string[],
  knownQuestions: readonly string[],
  expectedGraphId: number,
): InterviewQuestionGraphExpanded {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelProtocolError("题目图谱扩展响应无效");
  const response = value as Record<string, unknown>;
  rejectUnexpectedKeys(response, ["expansions", "graph_id", "revision"], "题目图谱扩展响应");
  if (response.graph_id !== expectedGraphId || !Number.isSafeInteger(response.revision) || (response.revision as number) < 1) {
    throw new ModelProtocolError("题目图谱扩展响应与当前历史记录不符");
  }
  const result = validateInterviewQuestionGraphExpand({ expansions: response.expansions }, expectedQuestionIds, knownQuestions);
  return { ...result, graph_id: expectedGraphId, revision: response.revision as number };
}

export function validateInterviewQuestionGraphExpand(
  value: unknown,
  expectedQuestionIds: readonly string[],
  knownQuestions: readonly string[],
): InterviewQuestionGraphExpand {
  const label = "AI 题目图谱追问";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelProtocolError(`${label}必须是 JSON 对象`);
  }
  const parsed = value as Record<string, unknown>;
  rejectUnexpectedKeys(parsed, ["expansions"], label);
  if (!Array.isArray(parsed.expansions) || parsed.expansions.length !== expectedQuestionIds.length) {
    throw new ModelProtocolError(`${label}未完整覆盖待扩展题目`);
  }
  const actualIds = new Set<string>();
  const expansions = parsed.expansions.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ModelProtocolError(`${label}第 ${index + 1} 项必须是对象`);
    }
    const expansion = entry as Record<string, unknown>;
    rejectUnexpectedKeys(expansion, ["question_id", "branches"], label);
    if (typeof expansion.question_id !== "string" || !expectedQuestionIds.includes(expansion.question_id) || actualIds.has(expansion.question_id)) {
      throw new ModelProtocolError(`${label}包含未知或重复的待扩展题目`);
    }
    actualIds.add(expansion.question_id);
    return {
      question_id: expansion.question_id,
      branches: validateBranches(expansion.branches, label),
    };
  });
  if (expectedQuestionIds.some((id) => !actualIds.has(id))) {
    throw new ModelProtocolError(`${label}未完整覆盖待扩展题目`);
  }
  assertNewQuestions(expansions.flatMap((expansion) => expansion.branches.map((branch) => branch.followup_question)), knownQuestions);
  return { expansions };
}

export function parseInterviewQuestionGraphExpand(
  raw: string,
  expectedQuestionIds: readonly string[],
  knownQuestions: readonly string[],
): InterviewQuestionGraphExpand {
  return validateInterviewQuestionGraphExpand(parseObject(raw, "AI 题目图谱追问"), expectedQuestionIds, knownQuestions);
}

export function validateInterviewQuestionGraphPredictions(
  value: unknown,
  expectedQuestionIds: readonly string[],
): InterviewQuestionGraphPredict {
  const label = "AI 题目图谱预测回答";
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelProtocolError(`${label}必须是 JSON 对象`);
  const parsed = value as Record<string, unknown>;
  rejectUnexpectedKeys(parsed, ["predictions"], label);
  if (!Array.isArray(parsed.predictions) || parsed.predictions.length !== expectedQuestionIds.length) {
    throw new ModelProtocolError(`${label}未完整覆盖待生成题目`);
  }
  const actualIds = new Set<string>();
  const predictions = parsed.predictions.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ModelProtocolError(`${label}第 ${index + 1} 项必须是对象`);
    const prediction = entry as Record<string, unknown>;
    rejectUnexpectedKeys(prediction, ["question_id", "answers"], label);
    if (typeof prediction.question_id !== "string" || !expectedQuestionIds.includes(prediction.question_id) || actualIds.has(prediction.question_id)) {
      throw new ModelProtocolError(`${label}包含未知或重复的待生成题目`);
    }
    actualIds.add(prediction.question_id);
    return { question_id: prediction.question_id, answers: validateAnswerScenarios(prediction.answers, label) };
  });
  if (expectedQuestionIds.some((id) => !actualIds.has(id))) throw new ModelProtocolError(`${label}未完整覆盖待生成题目`);
  return { predictions };
}

export function parseInterviewQuestionGraphPredictions(raw: string, expectedQuestionIds: readonly string[]): InterviewQuestionGraphPredict {
  return validateInterviewQuestionGraphPredictions(parseObject(raw, "AI 题目图谱预测回答"), expectedQuestionIds);
}

export function validateInterviewQuestionGraphPredicted(
  value: unknown,
  expectedQuestionIds: readonly string[],
  expectedGraphId: number,
): InterviewQuestionGraphPredicted {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelProtocolError("题目图谱预测响应无效");
  const response = value as Record<string, unknown>;
  rejectUnexpectedKeys(response, ["predictions", "graph_id", "revision"], "题目图谱预测响应");
  if (response.graph_id !== expectedGraphId || !Number.isSafeInteger(response.revision) || (response.revision as number) < 1) {
    throw new ModelProtocolError("题目图谱预测响应与当前历史记录不符");
  }
  const result = validateInterviewQuestionGraphPredictions({ predictions: response.predictions }, expectedQuestionIds);
  return { ...result, graph_id: expectedGraphId, revision: response.revision as number };
}
