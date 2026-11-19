import { projectPersonalScopeCases } from "./project-personal-scope-fixture";
import { projectChallengeBoundaryCases } from "./project-challenge-boundaries-fixture";

const scopeMarker = "工作范围：\n";
export const PROJECT_WORK_STATE_ADDITION = "- 职责分工只说明责任范围，不证明相关工作已实施或完成；未给实施状态时保持未知，不补成已实现或改成未实现。有独立实现证据时照常保留，不要求实现者已知。\n";

/** One added definition; preserve the rest of either known prompt byte for byte. */
export function buildProjectWorkStateSystems(production: string): { baseline: string; candidate: string } {
  const count = (text: string) => production.split(text).length - 1;
  const additions = count(PROJECT_WORK_STATE_ADDITION);
  if (count(scopeMarker) !== 1 || additions > 1 ||
      count("职责分工只说明责任范围") !== additions ||
      (additions === 1 && !production.includes(scopeMarker + PROJECT_WORK_STATE_ADDITION))) {
    throw new Error("project-work-state requires one known work-scope definition");
  }
  const baseline = additions === 1 ? production.replace(PROJECT_WORK_STATE_ADDITION, "") : production;
  return { baseline, candidate: baseline.replace(scopeMarker, scopeMarker + PROJECT_WORK_STATE_ADDITION) };
}

const processRubric = "审阅流程（不计模型语义）：完整原稿逐项pass/fail/uncertain并引用输入输出；缺稿单列不可观察，不以协议通过代替语义，不回填原pending。";
const newProtection = [
  "仅采用目标项目已有证据，保留各动作的实际状态、执行者和验证范围；未知不是未实施，未发布不是没有实现，不补技术、收益、故障或因果。full五维依证据归类，单纯进度或未知状态不独立成为技术难点；不能把人物分工当作架构。",
  "brief与每条achievement独立阅读，只保留其采用事实适用的本人/同事分工、本地合成验证数量、真实材料未验证、工作未完成/尚未开始及工具未发布等限定，不从别的字段借限定，不扩大局部状态；不得删掉全部可靠工作来形式通过。不以固定人称或字样判分，有实质归属歧义保留uncertain。",
] as const;

const inherited = [
  ...projectPersonalScopeCases,
  projectChallengeBoundaryCases[1],
  projectChallengeBoundaryCases[2],
] as const;
const inheritedDirect = [
  "状态直接目标：保留已明确完成的本人编号修改及已有读取→日期分组→文本导出链路；full architecture保留实际数据流。不能因未测试或原模块作者未知而抹去实现，也不能把编号修改者推成原模块作者。",
  "状态直接目标：保留已完成的编号修改和实际数据流，但编号修改者及原模块实现者均未知，不从项目产出补个人归功；full architecture仍保留链路，responsibilities应空。",
  "状态直接目标：本人负责规则、同事负责页面只说明分工，规则/页面的实施仍未知；不得写成已实现，也不得改成未实现。保留本人已补充文档，brief或至少一条achievement须采用该可靠工作。",
  "状态直接目标：保留已补充的项目文档，个人分工未知则不补本人工作，full responsibilities应空；规则/页面实施未知不变成肯定或否定实现，可靠文档仍至少进入brief或一条achievement。",
  "状态直接目标：本人负责筛选逻辑、同事负责界面不能被改为本人/同事已实现；保留本地8条合成日志的实际复现和本人日志/说明工作，不能把原因未定位、未修复或整体验收未完成反写成没有完成这些局部行动。",
  "状态直接目标：本人已修改CSV字段转义的明确行动及本地6行合成复测可保留；同事负责页面不证明页面由同事实现。不能因为分工不是完成证据而删掉有独立证据的修改、转义方案或复测结论。",
] as const;

/** Six unchanged sources/rubrics plus two fresh controls; both output modes use each source. */
export const projectWorkStateCases = [
  ...inherited.map((sample, index) => ({
    ...sample,
    rubric: [...sample.rubric.slice(0, -1), inheritedDirect[index]!, sample.rubric.at(-1)!],
  })),
  {
    id: "started-work-distinct-from-complete", projectName: "报表参数检查工具",
    source: "报表参数检查工具计划供分析人员检查报表期间参数，使用TypeScript。当前分工为本人负责参数校验逻辑，同事负责预览页面。本人已开始编写参数校验逻辑，尚未完成；预览页面尚未开始实现。本人已补充参数说明文档。工具未发布，没有运行验证。",
    rubric: [
      "brief或至少一条achievement保留本人已开始但未完成参数校验逻辑，以及已补充参数说明的可靠工作；可合为一条，不把进行中写成完成或未开始。用途仍为计划，页面明确尚未开始，不能降为实施未知；full没有模块/数据流或具体技术方案证据时architecture/highlights应空。",
      ...newProtection,
      "状态直接目标：分工、已开始但未完成、明确尚未开始与已完成文档分别保留，不能统一推成已实现、尚未实现或状态未知；已开始的个人行动和已完成文档均不能全部删掉。",
      processRubric,
    ],
  },
  {
    id: "implemented-flow-current-role-not-authorship", projectName: "图像清单索引工具",
    source: "图像清单索引工具供设计人员按扩展名查看图片路径列表，使用TypeScript。当前版本已实现数据流：扫描模块读取图片路径，索引模块按扩展名建立列表，预览模块展示列表。上述实现者未提供。当前分工为本人负责扫描与索引逻辑，同事负责预览页面。本人已补充扩展名说明文档。仅在本地用4条合成路径核对过列表展示，结果符合预期；核对执行者未提供，未使用真实图片目录验证。工具未发布。",
    rubric: [
      "保留明确存在的扫描→按扩展名建列表→预览数据流，full architecture须保留这条机制，不能因作者未知抹去实现；当前负责范围不证明这些实现由本人/同事完成。保留本人已完成说明文档，brief或至少一条achievement须采用；不能把未知核对执行者写成本人核对。",
      ...newProtection,
      "状态直接目标：区分现有实现、当前责任分工、未知原实现者/核对者与已知本人文档行动；不从负责推出作者，也不为避免归功把已经实现和已知个人工作留空。",
      processRubric,
    ],
  },
] as const;
