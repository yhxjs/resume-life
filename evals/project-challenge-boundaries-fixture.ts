// The candidate appends this rule only when the production prompt has not adopted it.
export const PROJECT_CHALLENGE_BOUNDARY_ADDITION = "纯进度或阶段状态本身不是难点，不能单独作为难点填入 challenges；有实际问题时，保留相关处理进展、未解决或未验证等原有限定；没有实际问题证据时留空。";
export const PROJECT_CHALLENGE_BOUNDARY_ANCHOR = "challenges 放实际问题及处理依据。";

export function buildProjectChallengeBoundaryCandidate(baseline: string): string {
  if (baseline.includes(PROJECT_CHALLENGE_BOUNDARY_ADDITION) || baseline.split(PROJECT_CHALLENGE_BOUNDARY_ANCHOR).length !== 2) {
    throw new Error("project-challenge-boundaries requires one original challenges anchor and no existing boundary rule");
  }
  return baseline.replace(PROJECT_CHALLENGE_BOUNDARY_ANCHOR, PROJECT_CHALLENGE_BOUNDARY_ANCHOR + PROJECT_CHALLENGE_BOUNDARY_ADDITION);
}

const logProgress = "本地日志筛选工具供开发人员按起始时间筛选本地日志，使用 TypeScript。本人负责筛选逻辑，同事负责界面。本人已整理8条合成日志并补充操作说明。工具未发布，整体验收未完成，尚无整体验证结论。";
const logProblem = "本人在本地用这8条合成日志复现：与筛选起始时间完全相等的一条日志按需求应保留，实际被遗漏。原因尚未定位，尚无修复方案，没有实施修复或验证修复效果。";
const csvChange = "名单CSV导出工具供活动组织者将报名名单导出为CSV，使用 TypeScript。本人负责CSV字段转义，同事负责页面。本人在本地用6行合成名单复现：姓名包含逗号时，一名报名者的姓名被拆成两列。本人已修改字段转义，用双引号包裹包含逗号的字段，字段内部的双引号写为连续两个双引号。上述修改已提交。工具未发布，整体验收未完成。";
const csvVerified = "本人随后复测这6行合成名单，各姓名均保持为一个字段，结果符合预期；未用真实名单验证。";
const csvUnverified = "尚未运行修复后的测试，是否消除错误尚未确认；未用真实名单验证。";

const sharedRubric = [
  "各字段只采用本例有依据的事实，保留本人/同事分工、工具未发布及整体验收未完成的适用状态；保留采用数据的本地、合成和数量范围，不把测试样本数量改为真实使用者或业务量，不补收益、上线、来源未给出的实现或原因，也不删掉可靠个人工作来逃避约束。负责筛选逻辑只说明分工，不证明逻辑已经实现；整体验收或验证未完成不否定已经明确完成的局部复现及合成复测。",
  "brief 与每条 achievement 分别独立核对，采用个人工作或他人方案时在本项保留其已知分工及适用的未发布、本地合成验证、未修复或效果未确认等限定，不从其他字段借回限定。仅保留本项实际采用事实的适用限定；仅写整理日志或操作说明的成果，不强制附上未采用的筛选故障或同事界面工作。允许自然省略第一人称，不强制出现本人两个字；没有可靠独立成果时允许空数组，不通过删掉全部可靠个人工作获得形式通过。",
  "审阅流程（不计模型语义判据）：取得完整原稿后逐项标记 pass/fail/uncertain 并引用输入与输出依据；缺稿记录为不可观察，不以协议通过代替语义判断。",
] as const;

/** Two new scenarios and two controlled evidence pairs; these are not four independent projects. */
export const projectChallengeBoundaryCases = [
  {
    id: "log-progress", projectName: "本地日志筛选工具", source: logProgress,
    rubric: ["challenges 应为空：未发布、整体验收未完成或尚无整体验证结论不能独立作为技术问题。不能反推工具没有问题或已验证通过；仍须保留有依据的个人文档工作。", ...sharedRubric],
  },
  {
    id: "log-unresolved", projectName: "本地日志筛选工具", source: logProgress + logProblem,
    rubric: ["challenges 须保留起始时间相等的边界日志被遗漏的真实问题，以及原因未定位、尚无方案、未实施修复或修复验证的限定，不能因没有处理方案而留空。不得补造比较运算符错误、修复方案或验证通过；整体验收未完成仍不能独立成为另一个难点。", ...sharedRubric],
  },
  {
    id: "csv-verified", projectName: "名单CSV导出工具", source: csvChange + csvVerified,
    rubric: ["challenges 须保留姓名含逗号时被拆列的问题、字段加引号的处理及6行合成名单复测符合预期的结果，不能因问题已有处理结果而删空。不能把有限复测升级为所有数据均正确、真实使用效果或整体验收通过；保留未用真实名单验证的范围。", ...sharedRubric],
  },
  {
    id: "csv-unverified", projectName: "名单CSV导出工具", source: csvChange + csvUnverified,
    rubric: ["challenges 须同时保留姓名含逗号时被拆列的真实问题、已经提交的转义修改，以及修复后未测试、是否消除错误尚未确认的状态；不得写成已解决或验证通过，也不能因结果未验证而抹掉已完成的修改。", ...sharedRubric],
  },
] as const;
