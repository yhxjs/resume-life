import { projectChallengeAdmissionCases } from "./project-challenge-admission-fixture";
import { projectChallengeBoundaryCases } from "./project-challenge-boundaries-fixture";
import { projectPersonalScopeCases } from "./project-personal-scope-fixture";
import { projectWorkStateCases } from "./project-work-state-fixture";

export const PROJECT_INDEPENDENT_ACHIEVEMENT_ANCHOR =
  "八字段全部返回，不加键或 null；七个文本字段均为字符串，信息不足时用空字符串，不放空白项；";
export const PROJECT_INDEPENDENT_ACHIEVEMENT_ADDITION =
  "每条achievement独立供简历采用；写个人工作时，本条保留该工作归属及适用环境、样本范围和状态，不依赖brief或responsibilities补足；无个人分工依据时用项目主语。";
const insertedText = PROJECT_INDEPENDENT_ACHIEVEMENT_ANCHOR + PROJECT_INDEPENDENT_ACHIEVEMENT_ADDITION;

/** Insert one sentence adjacent to the full-mode output contract; preserve all other bytes. */
export function buildProjectIndependentAchievementSystems(production: string): { baseline: string; candidate: string } {
  const anchorCount = production.split(PROJECT_INDEPENDENT_ACHIEVEMENT_ANCHOR).length - 1;
  const insertedCount = production.split(insertedText).length - 1;
  const additionCount = production.split(PROJECT_INDEPENDENT_ACHIEVEMENT_ADDITION).length - 1;
  const remainingText = production.replace(insertedText, "");
  if (anchorCount !== 1 || additionCount > 1 || additionCount !== insertedCount ||
      !production.includes("achievements 为字符串数组") ||
      remainingText.includes("每条achievement独立供简历采用")) {
    throw new Error("project-independent-achievement requires one known full-mode output contract without this addition");
  }
  const baseline = production.replace(insertedText, PROJECT_INDEPENDENT_ACHIEVEMENT_ANCHOR);
  return {
    baseline,
    candidate: baseline.replace(PROJECT_INDEPENDENT_ACHIEVEMENT_ANCHOR, insertedText),
  };
}

const lookup = <T extends { id: string }>(samples: readonly T[], id: string): T => {
  const sample = samples.find(entry => entry.id === id);
  if (!sample) throw new Error("Missing fixed independent-achievement sample: " + id);
  return sample;
};

const csvUnverified = lookup(projectChallengeBoundaryCases, "csv-unverified");
const knownChange = lookup(projectPersonalScopeCases, "implemented-change-known-author");
const unknownChange = lookup(projectPersonalScopeCases, "implemented-change-unknown-author");
const implementedFlow = lookup(projectWorkStateCases, "implemented-flow-current-role-not-authorship");
const observedIssue = lookup(projectChallengeAdmissionCases, "observed-issue-without-cause-or-solution");
const startedWork = lookup(projectWorkStateCases, "started-work-distinct-from-complete");

const processRubric = "审阅流程（不计模型语义判据）：完整原稿逐项标记pass/fail/uncertain并引用输入与输出原文；缺稿标记不可观察，不把协议通过当作语义通过。";

function caseRubric(independent: string, attribution: string, scope: string, preservation: string) {
  return [independent, attribution, scope, preservation, processRubric];
}

/** Six fixed sources, four model criteria and one separately counted review-process requirement each. */
export const projectIndependentAchievementCases = [
  {
    id: csvUnverified.id, projectName: csvUnverified.projectName, source: csvUnverified.source,
    rubric: caseRubric(
      "独立成果直接目标：brief与每条achievement分别阅读；若achievement采用字段转义工作，必须在本条保留本人修改并已提交，不能只在responsibilities或brief交代。",
      "本人负责CSV字段转义、同事负责页面；不把页面归本人，也不把单独的字段修改写成原有模块由本人实现。",
      "采用姓名逗号拆列问题或修改时，本条保留适用的本地6行合成名单范围、修复后未测试/效果待确认、未发布和未用真实名单验证状态。",
      "保留实际问题、已提交修改和合成复现工作；不补修复成功、真实名单效果、收益或未提供的实现结构，不为规避限定删掉可靠成果。",
    ),
  },
  {
    id: knownChange.id, projectName: knownChange.projectName, source: knownChange.source,
    rubric: caseRubric(
      "独立成果直接目标：brief和每条achievement如采用记录编号修改，均独立写明该修改由本人完成及已提交，不能依赖responsibilities或另一个条目补充。",
      "只把增加记录编号修改归给本人；读取、分组和导出原有模块的实施者未知，不推给本人或同事。",
      "每条采用该修改的成果保留修改后测试尚未运行和工具未发布；不把未测写成通过，也不把状态限定挪到另一字段。",
      "保留记录编号代码修改和导出用途，不把这次修改并入既有架构，不补实际收益、测试结果或新模块。",
    ),
  },
  {
    id: unknownChange.id, projectName: unknownChange.projectName, source: unknownChange.source,
    rubric: caseRubric(
      "独立成果直接目标：brief和每条achievement如采用已提交记录编号修改，均保留项目成果；在本条不得添加本人执行、负责、参与或个人功劳。",
      "执行者与个人分工未知；responsibilities不得补本人职责。保持项目主语，不能把未知写成本人未参与。",
      "每条采用该修改时保留修改后测试尚未运行及工具未发布状态；未知作者不改变这些状态，也不证明完成了测试。",
      "保留可确认的已提交修改，不补个人归属、旧模块作者、收益或测试结论；没有可靠个人成果时允许achievement为空。",
    ),
  },
  {
    id: implementedFlow.id, projectName: implementedFlow.projectName, source: implementedFlow.source,
    rubric: caseRubric(
      "独立成果直接目标：brief和每条achievement分别采用数据流或本人文档/核对工作时，都须在本条明确其自身事实与个人归属，不借用其他字段。",
      "扫描→索引→预览的数据流已实现但原实现者未知；当前分工不能证明本人实现扫描/索引或同事实现页面，核对者也未知。",
      "采用本人文档或局部核对时保留本人已补充说明、本地4条合成路径及执行者未知、真实目录未验证、工具未发布等相关范围。",
      "full architecture保留明确数据流；简历字段不把未知执行者改成本人，也不把个人文档扩成模块实现或删除可靠工作。",
    ),
  },
  {
    id: observedIssue.id, projectName: observedIssue.projectName, source: observedIssue.source,
    rubric: caseRubric(
      "独立成果直接目标：brief和每条achievement单独采用复现或文档工作；采用故障复现时，本条保留本人实际行动和相关未知状态，不依赖challenges补充。",
      "保留本人补充操作说明及本地用3份合成文档复现实际条目数不符；不得推断根因或将他人/未知工作归本人。",
      "每条采用问题复现时都保留原因未定位、没有提出/实施修复、没有修复验证、真实文档未验证及工具未发布；只写文档时不强加未采用的故障细节。",
      "保留实际为3条却只显示2条的问题；不补模块、解决方案、验证成功或收益，也不因未修复删掉已完成复现和文档工作。",
    ),
  },
  {
    id: startedWork.id, projectName: startedWork.projectName, source: startedWork.source,
    rubric: caseRubric(
      "独立成果直接目标：brief和每条achievement采用参数校验工作时，均在本条写清已开始但未完成；不能只在responsibilities说明状态。",
      "本人开始写参数校验逻辑、同事负责预览页面；不能把分工改成模块已完成，也不能把同事工作归本人。",
      "采用参数校验时保留尚未完成；采用预览页面时保留尚未开始；采用参数说明文档时保留本人已补充及其文档范围。工具未发布且没有运行验证。",
      "不得将进行中改为完成、未开始或状态未知；没有实际技术问题时challenges留空，可靠个人工作仍可进入简历字段。",
    ),
  },
] as const;
