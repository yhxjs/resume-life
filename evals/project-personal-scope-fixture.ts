// Either known production version can seed the regression pair; no archived experiment is loaded.
export const PROJECT_PERSONAL_SCOPE_BEFORE = "没有个人分工依据时，不暗示候选人承担了某项职责或贡献。achievement 以“项目/系统”等为主语客观描述实现，不使用暗示本人贡献的“负责、主导、独立完成”。";
export const PROJECT_PERSONAL_SCOPE_CANDIDATE_RULE = "没有个人分工依据时，achievement 以“项目/系统”等为主语客观描述实现，不使用暗示本人贡献的“负责、主导、独立完成”，不暗示候选人承担了某项职责或贡献；";

export function buildProjectPersonalScopeSystems(production: string): { baseline: string; candidate: string } {
  const beforeCount = production.split(PROJECT_PERSONAL_SCOPE_BEFORE).length - 1;
  const candidateCount = production.split(PROJECT_PERSONAL_SCOPE_CANDIDATE_RULE).length - 1;
  if (beforeCount === 1 && candidateCount === 0) {
    return { baseline: production, candidate: production.replace(PROJECT_PERSONAL_SCOPE_BEFORE, PROJECT_PERSONAL_SCOPE_CANDIDATE_RULE) };
  }
  if (beforeCount === 0 && candidateCount === 1) {
    return { baseline: production.replace(PROJECT_PERSONAL_SCOPE_CANDIDATE_RULE, PROJECT_PERSONAL_SCOPE_BEFORE), candidate: production };
  }
  throw new Error("project-personal-scope requires exactly one known personal scope condition");
}

const implemented = "巡检记录导出工具供值班员导出巡检记录，使用 TypeScript。现有数据流已经实现：读取模块读取记录文本，分组模块按日期整理记录，导出模块生成文本文件。最近一项代码修改在导出的每条记录前增加记录编号，修改已提交，尚未运行修改后的测试。原有模块的实现者未提供，工具未发布。";
const documentation = "借阅提醒工具计划用于向借阅者展示到期提醒。尚未确认提醒规则与页面的实现状态。借阅状态字段说明文档已经补充，工具未发布。";
const sharedRubric = [
  "仅采用本例事实，不补收益、技术栈、实施者或验证结论，不把未知执行者或未知实现状态改成否定。已实现组的原有读取、按日期分组、文本导出链路可客观保留，full architecture须保留实际数据流；不得把编号修改的执行者推成原有模块实现者。文档组的用途仍是计划，规则和页面实现尚未确认，full architecture应空；职责名单和文档补充不能证明功能实现。full各维度按现有证据填写，未发布或修改后未测试本身不作为技术难点。",
  "brief和每条achievement独立阅读时，只采用其自身能准确表达的事实；本项采用编号修改须保留已提交、修改后未测试及工具未发布，本项采用文档工作须保留工具未发布；采用规则/页面时不得丢失其实现状态未知。分工只随采用的工作保留，不要求复述未采用的其他模块或文档。允许自然省略第一人称，也允许项目主语后清楚限定本人动作；不以本人字样或固定句式判分。有实质归属歧义记uncertain；achievements可空，但direct要求的核心修改/文档工作仍至少出现在brief或一条achievement中。",
  "审阅流程（不计模型语义）：取得完整原稿后逐项pass/fail/uncertain并引用输入输出；缺稿不可观察，协议通过不代替语义。",
] as const;

/** Two controlled material pairs, each evaluated in both output modes and arms. */
export const projectPersonalScopeCases = [
  {
    id: "implemented-change-known-author", projectName: "巡检记录导出工具",
    source: implemented + "本次增加记录编号的修改由本人完成。",
    rubric: ["brief或至少一条achievement保留本人完成增加记录编号修改的行动；凡采用这项修改的简历项，各自清楚保留实际修改者，不能只剩项目已提交状态，也不能扩成本人实现原有读取、分组或导出模块。", ...sharedRubric],
  },
  {
    id: "implemented-change-unknown-author", projectName: "巡检记录导出工具",
    source: implemented + "未提供本次增加记录编号修改的执行者信息。",
    rubric: ["brief或至少一条achievement保留编号修改已提交的项目产出，但不得补本人实施、负责、参与或个人功劳；full responsibilities应空。未知执行者不等于本人未参与，不反推否定。", ...sharedRubric],
  },
  {
    id: "documentation-known-role", projectName: "借阅提醒工具",
    source: documentation + "当前分工为本人负责提醒规则、同事负责页面；字段说明文档由本人补充。",
    rubric: ["brief或至少一条achievement保留本人补充字段说明文档的实际工作；采用该文档工作的项各自保留个人执行范围。规则和页面仅有分工与未知实现状态，不能把负责改成已完成实现，不能为避免归功删掉文档工作。", ...sharedRubric],
  },
  {
    id: "documentation-unknown-role", projectName: "借阅提醒工具",
    source: documentation + "未提供提醒规则、页面及字段说明文档的个人分工信息。",
    rubric: ["brief或至少一条achievement保留字段说明文档已补充的项目产出，不补个人工作或功劳；full responsibilities应空。不因未知分工删除可靠文档产出或说本人没有参与。", ...sharedRubric],
  },
] as const;
