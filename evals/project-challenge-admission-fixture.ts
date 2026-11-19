import { projectChallengeBoundaryCases } from "./project-challenge-boundaries-fixture";
import { projectWorkStateCases } from "./project-work-state-fixture";

export const PROJECT_CHALLENGE_ADMISSION_BASELINE_LINE = `  "challenges": "已知问题、应对方式与有证据的结果",`;
export const PROJECT_CHALLENGE_ADMISSION_CANDIDATE_LINE = `  "challenges": "仅材料明确记录的实际问题；处理和结果只写已知内容；无实际问题时为空字符串",`;
const fieldPrefix = `  "challenges": `;

/** Change one full-mode example value; preserve every byte outside that member line. */
export function buildProjectChallengeAdmissionSystems(production: string): { baseline: string; candidate: string } {
  const baselineCount = production.split(PROJECT_CHALLENGE_ADMISSION_BASELINE_LINE).length - 1;
  const candidateCount = production.split(PROJECT_CHALLENGE_ADMISSION_CANDIDATE_LINE).length - 1;
  if (production.split(fieldPrefix).length !== 2 || baselineCount + candidateCount !== 1 ||
      production.includes("职责分工只说明责任范围") ||
      production.includes("纯进度或阶段状态本身不是难点")) {
    throw new Error("project-challenge-admission requires one known full-mode field definition without previous additions");
  }
  const baseline = candidateCount === 1
    ? production.replace(PROJECT_CHALLENGE_ADMISSION_CANDIDATE_LINE, PROJECT_CHALLENGE_ADMISSION_BASELINE_LINE)
    : production;
  return {
    baseline,
    candidate: baseline.replace(PROJECT_CHALLENGE_ADMISSION_BASELINE_LINE, PROJECT_CHALLENGE_ADMISSION_CANDIDATE_LINE),
  };
}

const processRubric = projectWorkStateCases[0].rubric.at(-1)!;
const problemIds = new Set(["log-unresolved", "csv-verified", "csv-unverified"]);
const noProblemDirect = "难点直接目标：本例没有提供已发生的实际技术问题，challenges应空；分工、未知作者、文档产出、未完成、未测试、未发布或验收状态不能独立成为难点。不得反推项目没有问题或已通过验证，可靠工作继续保留。";
const problemDirect = "难点直接目标：challenges保留本例具体实际问题，处理、结果及未解决或未验证限定按材料填写；原因未知、没有方案、未运行修复测试或问题已经有限复测通过均不能成为删除真实问题的理由，不补根因、方案或成功结论。";
const inherited = [
  ...projectWorkStateCases,
  ...projectChallengeBoundaryCases.filter(sample => sample.id === "log-progress" || sample.id === "csv-unverified"),
] as const;

/** Position is one-based. Original sources and all inherited rubric entries remain intact. */
export const projectChallengeAdmissionCases = [
  ...inherited.map(sample => ({
    ...sample,
    expectedChallenge: problemIds.has(sample.id) ? "problem" : "empty",
    challengeCriterionPosition: sample.rubric.length,
    rubric: [
      ...sample.rubric.slice(0, -1),
      problemIds.has(sample.id) ? problemDirect : noProblemDirect,
      sample.rubric.at(-1)!,
    ],
  })),
  {
    id: "risk-without-observed-failure",
    projectName: "本地归档目录工具",
    source: "本地归档目录工具计划供资料管理员整理归档目录，项目使用TypeScript。本人已补充风险登记说明，其中仅提出假设：若将来处理同名文件，可能发生目录条目覆盖。材料未记录已发生的条目覆盖或其他技术故障；尚未进行运行检查，功能实施状态未提供。工具未发布。",
    expectedChallenge: "empty",
    challengeCriterionPosition: 4,
    rubric: [
      "brief或至少一条achievement保留本人已补充风险登记说明的工作，不能改成实现或解决目录覆盖；项目用途仍为计划，功能实施未知不变成肯定或否定。",
      "仅采用目标材料事实；假设风险不证明已发生故障、存在对应模块或已采用解决方案。没有模块数据流和已实现方案证据时architecture与highlights为空，不补收益、验证通过或作者。",
      "brief与每条achievement独立保留所采用工作适用的本人文档范围、工具未发布及未运行检查状态，不借其他字段的限定；不为形式通过删除全部可靠个人工作。",
      "难点直接目标：仅有未来假设风险且未记录实际问题，challenges为空；不得将风险转成既成故障，也不能反推项目没有技术问题。",
      processRubric,
    ],
  },
  {
    id: "observed-issue-without-cause-or-solution",
    projectName: "本地文档目录工具",
    source: "本地文档目录工具供资料管理员查看文档条目，使用TypeScript。本人已补充操作说明。本人在本地用3份合成文档复现：目录按需求应显示3个条目，实际只显示2个。原因尚未定位，没有提出或实施修复，也没有修复效果验证。工具未发布，未用真实文档验证。材料没有提供模块划分或数据流。",
    expectedChallenge: "problem",
    challengeCriterionPosition: 4,
    rubric: [
      "保留本人已补充操作说明及本地3份合成文档的实际复现，至少在brief或achievement采用可靠个人工作；未修复不否定已完成的文档和复现。",
      "只采用目标项目有依据的事实；不猜同名覆盖、索引冲突等原因，不补修复方案、成功结论、模块或数据流，architecture与highlights为空。",
      "brief与每条achievement独立保留其采用事实适用的本人动作、工具未发布、本地3份合成文档、真实文档未验证及未修复状态；仅采用操作说明时不强加未采用的故障细节，不删掉全部可靠工作。",
      "难点直接目标：challenges保留应显示3条实际只显示2条的问题，并保留原因未定位、没有方案或实施修复、没有修复验证的限定；不能因缺少原因或处理结果而留空，也不能补造它们。",
      processRubric,
    ],
  },
] as const;
