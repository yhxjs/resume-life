import { projectChallengeAdmissionCases } from "./project-challenge-admission-fixture";
import { projectChallengeBoundaryCases } from "./project-challenge-boundaries-fixture";
import { projectPersonalScopeCases } from "./project-personal-scope-fixture";
import { projectWorkStateCases } from "./project-work-state-fixture";

export const PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_ARCHITECTURE =
  '  "architecture": "实际模块、数据流与协作机制",';
export const PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_ARCHITECTURE =
  '  "architecture": "有明确实现证据的模块、数据流或协作机制；职责分工和计划本身不证明架构",';
export const PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_CHALLENGES =
  '  "challenges": "已知问题、应对方式与有证据的结果",';
export const PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_CHALLENGES =
  '  "challenges": "仅材料明确记录的实际问题；处理和结果只写已知内容；无实际问题时为空字符串",';

const fields = [
  {
    baseline: PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_ARCHITECTURE,
    candidate: PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_ARCHITECTURE,
    prefix: '  "architecture": ',
  },
  {
    baseline: PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_CHALLENGES,
    candidate: PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_CHALLENGES,
    prefix: '  "challenges": ',
  },
] as const;

/** Rebuild exactly the joint candidate from either known arm; reject a partial combination. */
export function buildProjectSummaryFieldBoundariesSystems(production: string): { baseline: string; candidate: string } {
  const counts = fields.map(field => ({
    baseline: production.split(field.baseline).length - 1,
    candidate: production.split(field.candidate).length - 1,
    prefix: production.split(field.prefix).length - 1,
  }));
  const baselineSeed = counts.every(count => count.baseline === 1 && count.candidate === 0 && count.prefix === 1);
  const candidateSeed = counts.every(count => count.baseline === 0 && count.candidate === 1 && count.prefix === 1);
  if (!baselineSeed && !candidateSeed) {
    throw new Error("project-summary-field-boundaries requires one known full-mode joint arm");
  }
  let baseline = production;
  if (candidateSeed) {
    for (const field of fields) baseline = baseline.replace(field.candidate, field.baseline);
  }
  let candidate = baseline;
  for (const field of fields) candidate = candidate.replace(field.baseline, field.candidate);
  return { baseline, candidate };
}

const lookup = <T extends { id: string }>(samples: readonly T[], id: string): T => {
  const sample = samples.find(entry => entry.id === id);
  if (!sample) throw new Error("Missing fixed summary field-boundary sample: " + id);
  return sample;
};

const logProgress = lookup(projectChallengeBoundaryCases, "log-progress");
const csvUnverified = lookup(projectChallengeBoundaryCases, "csv-unverified");
const implementedFlow = lookup(projectWorkStateCases, "implemented-flow-current-role-not-authorship");
const implementedChange = lookup(projectPersonalScopeCases, "implemented-change-known-author");
const observedIssue = lookup(projectChallengeAdmissionCases, "observed-issue-without-cause-or-solution");
const startedWork = lookup(projectWorkStateCases, "started-work-distinct-from-complete");

const processRubric = "审阅流程（不计模型语义判据）：完整原稿逐项标记pass/fail/uncertain并引用输入与输出原文；缺稿标记不可观察，不把协议通过当作语义通过。";

function caseRubric(architecture: string, challenge: string, sourceBoundary: string, independentUse: string) {
  return [architecture, challenge, sourceBoundary, independentUse, processRubric];
}

/** Six fixed sources, four model criteria and one separately counted review-process requirement each. */
export const projectSummaryFieldBoundariesCases = [
  {
    id: logProgress.id, projectName: logProgress.projectName, source: logProgress.source,
    rubric: caseRubric(
      "architecture直接目标：材料只有本人负责筛选逻辑、同事负责界面，没有已实现模块划分、数据流或协作机制，architecture应空。",
      "challenges直接目标：只有未发布、整体验收未完成和没有整体验证结论，未记录实际技术问题，challenges应空；不能反推项目没有问题或已验证通过。",
      "保留本人整理8条合成日志和补充操作说明、项目用途及TypeScript；职责不证明模块，状态不证明技术问题。",
      "brief和每条achievement独立保留实际采用的本人工作与未发布/验收状态；不把职责写成已实现功能，也不删除可靠文档工作。",
    ),
  },
  {
    id: csvUnverified.id, projectName: csvUnverified.projectName, source: csvUnverified.source,
    rubric: caseRubric(
      "architecture直接目标：职责分工和已提交字段转义修改不构成模块/数据流证据，architecture应空。",
      "challenges直接目标：保留姓名含逗号被拆列的实际问题、已提交双引号转义修改、修复后未测/是否解决未知及真实名单未验证状态。",
      "区分本人负责字段转义、同事负责页面与已提交代码修改；不得把页面或字段任务改成两个实现模块，不补根因或收益。",
      "brief和每条achievement若采用该工作，分别保留本人修改归属、本地6行合成名单范围、修复未验证及未发布/真实名单未验证状态。",
    ),
  },
  {
    id: implementedFlow.id, projectName: implementedFlow.projectName, source: implementedFlow.source,
    rubric: caseRubric(
      "architecture直接目标：保留扫描读取路径→索引按扩展名建表→预览展示的已实现数据流，原作者未知不构成留空理由。",
      "challenges直接目标：局部核对符合预期不是实际技术问题；未用真实目录验证、工具未发布或核对者未知不能独立成为challenges。",
      "当前本人/同事分工不证明原实现者；保留本地4条合成路径、核对者未知、真实目录未验证和本人补充文档。",
      "brief与每条achievement分别保留所采用数据流或本人文档的事实；未知作者和执行者不改写成本人，也不抹去个人文档工作。",
    ),
  },
  {
    id: implementedChange.id, projectName: implementedChange.projectName, source: implementedChange.source,
    rubric: caseRubric(
      "architecture直接目标：保留读取→按日期分组→导出文本文件的既有数据流；新增记录编号修改是独立代码改动，不并入原有模块。",
      "challenges直接目标：没有材料记录的实际技术问题；测试未运行和工具未发布是状态，不应单独填入challenges。",
      "只把已提交记录编号修改归本人；原有模块作者未知。保留TypeScript、未发布和修改后测试未运行，不补收益或测试结论。",
      "brief和每条achievement采用本人改动时各自保留本人完成、已提交、测试未运行和未发布限定；不依赖其他字段补足。",
    ),
  },
  {
    id: observedIssue.id, projectName: observedIssue.projectName, source: observedIssue.source,
    rubric: caseRubric(
      "architecture直接目标：材料明示没有模块划分或数据流，architecture应空；问题现象不能被转成根因或架构。",
      "challenges直接目标：保留应显示3条却只显示2条的本地合成文档问题；原因未定位、没有修复方案/实施修复/修复验证均保留。",
      "保留本人补充操作说明及3份合成文档复现；不补根因、模块、实现者、成功修复或真实文档效果。",
      "brief和每条achievement独立阅读；采用问题复现时保留本人动作和对应未知/未修复/未验证状态，只写文档时不强加未采用的故障细节。",
    ),
  },
  {
    id: startedWork.id, projectName: startedWork.projectName, source: startedWork.source,
    rubric: caseRubric(
      "architecture直接目标：工作计划、本人开始编写逻辑、同事负责页面和文档工作均不证明架构，architecture应空。",
      "challenges直接目标：参数校验进行中、预览页面未开始、未发布及没有运行验证是进度/状态，没有实际问题时challenges应空。",
      "区分本人已开始但未完成、页面尚未开始、文档已补充与项目未发布；不把它们统一写成已完成、未开始或未知。",
      "brief和每条achievement只写其采用的个人工作及相应状态；参数说明文档保持文档范围，不把尚未完成/未开始扩成技术难点。",
    ),
  },
] as const;
