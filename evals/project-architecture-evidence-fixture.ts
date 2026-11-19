import { projectChallengeBoundaryCases } from "./project-challenge-boundaries-fixture";
import { projectChallengeAdmissionCases } from "./project-challenge-admission-fixture";
import { projectPersonalScopeCases } from "./project-personal-scope-fixture";
import { projectWorkStateCases } from "./project-work-state-fixture";

export const PROJECT_ARCHITECTURE_EVIDENCE_BASELINE_LINE = '  "architecture": "实际模块、数据流与协作机制",';
export const PROJECT_ARCHITECTURE_EVIDENCE_CANDIDATE_LINE = '  "architecture": "有明确实现证据的模块、数据流或协作机制；职责分工和计划本身不证明架构",';
const fieldPrefix = '  "architecture": ';

/** Change one full-mode example value; preserve every byte outside that member line. */
export function buildProjectArchitectureEvidenceSystems(production: string): { baseline: string; candidate: string } {
  const baselineCount = production.split(PROJECT_ARCHITECTURE_EVIDENCE_BASELINE_LINE).length - 1;
  const candidateCount = production.split(PROJECT_ARCHITECTURE_EVIDENCE_CANDIDATE_LINE).length - 1;
  const remainingText = production
    .replace(PROJECT_ARCHITECTURE_EVIDENCE_BASELINE_LINE, "")
    .replace(PROJECT_ARCHITECTURE_EVIDENCE_CANDIDATE_LINE, "");
  if (production.split(fieldPrefix).length !== 2 || baselineCount + candidateCount !== 1 ||
      remainingText.includes("architecture只写有明确实现证据的模块") ||
      remainingText.includes("职责分工和计划本身不证明架构")) {
    throw new Error("project-architecture-evidence requires one known full-mode field definition without this candidate");
  }
  const baseline = candidateCount === 1
    ? production.replace(PROJECT_ARCHITECTURE_EVIDENCE_CANDIDATE_LINE, PROJECT_ARCHITECTURE_EVIDENCE_BASELINE_LINE)
    : production;
  return {
    baseline,
    candidate: baseline.replace(PROJECT_ARCHITECTURE_EVIDENCE_BASELINE_LINE, PROJECT_ARCHITECTURE_EVIDENCE_CANDIDATE_LINE),
  };
}

const lookup = <T extends { id: string }>(samples: readonly T[], id: string): T => {
  const sample = samples.find(entry => entry.id === id);
  if (!sample) throw new Error("Missing fixed project architecture evidence sample: " + id);
  return sample;
};

const logProgress = lookup(projectChallengeBoundaryCases, "log-progress");
const csvUnverified = lookup(projectChallengeBoundaryCases, "csv-unverified");
const implementedFlow = lookup(projectWorkStateCases, "implemented-flow-current-role-not-authorship");
const implementedChange = lookup(projectPersonalScopeCases, "implemented-change-known-author");
const documentationRole = lookup(projectPersonalScopeCases, "documentation-known-role");
const observedIssue = lookup(projectChallengeAdmissionCases, "observed-issue-without-cause-or-solution");

const processRubric = "审阅流程（不计模型语义判据）：完整原稿逐项标记pass/fail/uncertain并引用输入与输出原文；缺稿标记不可观察，不把协议通过当作语义通过。";

function caseRubric(target: string, boundary: string, preservation: string, brief: string) {
  return [target, boundary, preservation, brief, processRubric];
}

/** Six fixed sources, four model criteria and one separately counted review-process requirement each. */
export const projectArchitectureEvidenceCases = [
  {
    id: logProgress.id, projectName: logProgress.projectName, source: logProgress.source,
    expectedArchitecture: "empty",
    rubric: caseRubric(
      "architecture直接目标：本例只有本人负责筛选逻辑、同事负责界面以及日志整理和说明文档；没有已实现模块划分、数据流或协作机制，architecture应空，不能把两项职责改写成两个架构模块。",
      "职责和工作项不能单独证明实现；不得补功能存在、实现者、架构、状态或收益。保留项目用途与技术栈的明示事实，不从项目名和筛选职责推演内部结构。",
      "保留本人整理8条合成日志并补充操作说明、工具未发布和整体验收未完成的事实及范围；未完成状态不能抹去文档工作，也不能被写成技术难点。",
      "brief及每条achievement独立可读；采用个人工作时保留本人范围、8条合成日志和未发布等相关限定，不把职责写成已实现功能，也不为避免归属疑义删掉可靠文档工作。",
    ),
  },
  {
    id: csvUnverified.id, projectName: csvUnverified.projectName, source: csvUnverified.source,
    expectedArchitecture: "empty",
    rubric: caseRubric(
      "architecture直接目标：材料明确字段转义代码修改已提交，但只给字段责任分工，没有已实现模块、数据流或协作机制；architecture应空，不把本人负责字段转义、同事负责页面改写成两个模块。",
      "区分实际提交的字段转义修改与既有架构证据；不扩成页面或导出模块已实现，不推断原实现者、原因、测试结果或收益。",
      "保留姓名含逗号被拆列的实际问题、双引号字段转义修改已提交、修复后未测试且问题是否消除未确认、未发布及未用真实名单验证；不写成已解决或删掉已完成修改。",
      "brief和每条achievement分别保留其采用工作适用的本人分工、修复未验证、未发布及合成数据范围；状态不得只放在其他字段，也不删掉可靠工作。",
    ),
  },
  {
    id: implementedFlow.id, projectName: implementedFlow.projectName, source: implementedFlow.source,
    expectedArchitecture: "preserve-flow",
    rubric: caseRubric(
      "architecture直接目标：保留明确已实现的扫描模块读取图片路径→索引模块按扩展名建立列表→预览模块展示列表这一数据流；不得因为原实现者未知而留空。",
      "区分已实现数据流、当前个人/同事职责与未知原实现者；不把当前负责范围写成原作者，也不把本人文档工作扩成模块实现。",
      "保留本人补充扩展名说明文档、仅本地4条合成路径核对且执行者未知、未用真实目录验证和未发布限定；不把有限核对升级为真实使用或整体验收。",
      "brief及每条achievement独立可读；采用数据流或核对时分别保留可知的作者、执行者和验证范围，不把未知人名替换成本人，也不因此删除已知个人文档工作。",
    ),
  },
  {
    id: implementedChange.id, projectName: implementedChange.projectName, source: implementedChange.source,
    expectedArchitecture: "preserve-flow-separate-change",
    rubric: caseRubric(
      "architecture直接目标：保留已实现的读取→按日期分组→导出文本文件数据流；新增记录编号是单独的近期代码修改，不得并入原有模块职责或把它说成新架构模块。",
      "只将本人完成记录编号修改归给本人；原有模块实现者未知，不得归给本人或同事。已提交且修改后未运行测试不能改成测试通过。",
      "保留工具供值班员导出巡检记录、TypeScript、未发布及修改后未测试；未提供业务收益，不新增指标、实现者或验证结论。",
      "brief和每条achievement独立可读；采用编号修改时保留本人完成、已提交、修改后未测试和未发布等限定，不将该修改扩大为本人实现整条既有数据流。",
    ),
  },
  {
    id: documentationRole.id, projectName: documentationRole.projectName, source: documentationRole.source,
    expectedArchitecture: "empty",
    rubric: caseRubric(
      "architecture直接目标：用途仍是计划，提醒规则与页面实现状态未确认；职责分工和已补充字段说明文档不证明任何架构，architecture应空。",
      "不得把本人负责规则、同事负责页面改成已实现模块，也不得将计划中的提醒用途写成已实现功能；不补数据流或技术方案。",
      "保留本人补充字段说明文档及工具未发布；提醒规则与页面实现状态维持未知，文档工作不能被误写为功能实现，也不构成技术难点。",
      "brief及每条achievement独立可读；采用文档工作时保留本人执行范围与未发布状态，不借用职责来推断规则或页面实现，也不因架构留空而删除文档工作。",
    ),
  },
  {
    id: observedIssue.id, projectName: observedIssue.projectName, source: observedIssue.source,
    expectedArchitecture: "empty",
    rubric: caseRubric(
      "architecture直接目标：材料明确没有模块划分或数据流；即使记录了本地合成文档条目数不符的真实问题，architecture仍应空，不把问题现象补成模块架构。",
      "不猜根因、模块、修复方案或修复者；原因尚未定位、没有提出或实施修复、没有修复验证均保持原样。",
      "challenges须保留应显示3条而实际只显示2条的复现，以及根因未定位、未修复和未验证状态；同时保留本人操作说明和本地3份合成文档的范围、未发布及未用真实文档验证。",
      "brief和每条achievement独立可读；只采用事实时分别保留本人工作、工具未发布、本地合成数据及对应未知状态，不删掉全部可靠个人工作来规避事实限定。",
    ),
  },
] as const;
