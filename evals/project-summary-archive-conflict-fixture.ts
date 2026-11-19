import { unclarifiedProjectArchiveConflict } from "./project-archive-conflict-fixture";
import { emptySummary, type ProjectSummary } from "@/lib/summary";
import type { ProjectMaterialRecordSource } from "@/lib/project-material-record";
import { PROJECT_SUMMARY_ARCHIVE_CONFLICT_V7_RULE } from "@/lib/project-summary-llm";

const archiveConflictRule = "未澄清的档案与原始材料冲突，只在直接相关的一个五维字段说明待核实，不散布到多个维度；无法确定归属时留空。简历字段省略或弱化有争议的说法，不选择更强结论，也不自动把旧成果作为本次可靠成果保留。已明确更正时采用更正后的事实，不要求复述撤回历史。";
export const PROJECT_SUMMARY_ARCHIVE_CONFLICT_ADDITION = "职责归属冲突须在responsibilities中并列注明材料与档案的各自说法并标待核，其他字段不得把任一方改写成确定分工。档案与材料并存时，仅见于档案且材料未提供测量依据的指标不作为已证实成果，也不把‘未说明／需核对’放入challenges；challenges只写材料明确记录的实际问题及其处理依据。";
export const PROJECT_SUMMARY_ARCHIVE_CONFLICT_V2_ADDITION = "同一项目中并列的文档工作与功能实现分别陈述；只有原文明确说明用途或配套关系时才将二者关联，不从材料名称或同条出现推断关系。";
export const PROJECT_SUMMARY_ARCHIVE_CONFLICT_V3_ADDITION = "职责归属未澄清时，brief与achievements只写材料独立支持的无争议个人工作，不在简历字段选档案或材料任何一方为确定分工；不得因此删掉可分离的无争议工作。材料只说‘未说明／需核对’是信息缺口，不是实际项目问题，未记录实际问题及处理依据时challenges留空；不把该缺口改述后填入简历字段。";
export const PROJECT_SUMMARY_ARCHIVE_CONFLICT_V4_ADDITION = "若原文只分别说本人实现某功能、本人补充某说明，不得写成‘为该功能补充说明’、‘功能提供说明’或‘说明与功能配套’；只有材料明确写出说明用途、对象或配套关系时才能关联。";
export const PROJECT_SUMMARY_ARCHIVE_CONFLICT_V5_ADDITION = "文档名称沿用材料原有指称，不补加材料未写的模块名、功能名或用途限定；只在同一项目中并列出现的功能实现与文档工作分别陈述，不用改写文档名称暗示其归属。CSV、JSON等文件格式不作为techStack；材料未说明实际使用的语言、框架、库或工具时techStack留空。";
export const PROJECT_SUMMARY_ARCHIVE_CONFLICT_V6_ADDITION = "未澄清职责冲突时，responsibilities并列档案与材料说法并标待核；brief/achievements只写材料独立支持的无争议个人工作，不选任一方为确定事实。‘未说明／需核对’仅为信息缺口，不是实际问题；没有实际问题和处理依据时challenges留空，不能把缺口改述后写入简历。功能实现和文档工作分别描述，仅当原文明确用途或配套关系时才关联；文档名称不添加材料未写的模块名或功能名。CSV、JSON等文件格式本身不是techStack；未说明实际使用的语言、框架、库或工具时techStack留空。";

/** Rebuild the baseline and experimental prompt arms from any known form. */
export function buildProjectSummaryArchiveConflictSystems(production: string): { baseline: string; candidate: string; candidateV2: string; candidateV3: string; candidateV4: string; candidateV5: string; candidateV6: string; candidateV7: string } {
  const candidateRule = archiveConflictRule + PROJECT_SUMMARY_ARCHIVE_CONFLICT_ADDITION;
  const candidateV2Rule = candidateRule + PROJECT_SUMMARY_ARCHIVE_CONFLICT_V2_ADDITION;
  const candidateV3Rule = candidateV2Rule + PROJECT_SUMMARY_ARCHIVE_CONFLICT_V3_ADDITION;
  const candidateV4Rule = candidateV3Rule + PROJECT_SUMMARY_ARCHIVE_CONFLICT_V4_ADDITION;
  const candidateV5Rule = candidateV4Rule + PROJECT_SUMMARY_ARCHIVE_CONFLICT_V5_ADDITION;
  const candidateV6Rule = archiveConflictRule + PROJECT_SUMMARY_ARCHIVE_CONFLICT_V6_ADDITION;
  const candidateV7Rule = PROJECT_SUMMARY_ARCHIVE_CONFLICT_V7_RULE;
  const additionCounts = [
    PROJECT_SUMMARY_ARCHIVE_CONFLICT_ADDITION,
    PROJECT_SUMMARY_ARCHIVE_CONFLICT_V2_ADDITION,
    PROJECT_SUMMARY_ARCHIVE_CONFLICT_V3_ADDITION,
    PROJECT_SUMMARY_ARCHIVE_CONFLICT_V4_ADDITION,
    PROJECT_SUMMARY_ARCHIVE_CONFLICT_V5_ADDITION,
  ].map(addition => production.split(addition).length - 1);
  const candidateV6Count = production.split(PROJECT_SUMMARY_ARCHIVE_CONFLICT_V6_ADDITION).length - 1;
  if ((production.split(archiveConflictRule).length - 1) !== 1 ||
      additionCounts.some((count, index) => count > 1 || (index > 0 && count > (additionCounts[index - 1] ?? 0))) ||
      candidateV6Count > 1 || (candidateV6Count > 0 && additionCounts.some(Boolean))) {
    throw new Error("project-summary-archive-conflict requires one known archive-conflict rule");
  }
  const sequentialAdditions = [
    PROJECT_SUMMARY_ARCHIVE_CONFLICT_ADDITION,
    PROJECT_SUMMARY_ARCHIVE_CONFLICT_V2_ADDITION,
    PROJECT_SUMMARY_ARCHIVE_CONFLICT_V3_ADDITION,
    PROJECT_SUMMARY_ARCHIVE_CONFLICT_V4_ADDITION,
    PROJECT_SUMMARY_ARCHIVE_CONFLICT_V5_ADDITION,
  ];
  const knownAdditions = candidateV6Count > 0
    ? PROJECT_SUMMARY_ARCHIVE_CONFLICT_V6_ADDITION
    : sequentialAdditions.slice(0, additionCounts.filter(Boolean).length).join("");
  const baseline = production.replace(archiveConflictRule + knownAdditions, archiveConflictRule);
  const outputAnchor = "不编造内容绕过校验。\n目标与来源：";
  if (baseline.split(outputAnchor).length - 1 !== 1) {
    throw new Error("project-summary-archive-conflict requires one output/source boundary");
  }
  const candidateV7 = baseline
    .replace(archiveConflictRule, "")
    .replace(outputAnchor, `不编造内容绕过校验。\n${candidateV7Rule}\n目标与来源：`);
  return {
    baseline,
    candidate: baseline.replace(archiveConflictRule, candidateRule),
    candidateV2: baseline.replace(archiveConflictRule, candidateV2Rule),
    candidateV3: baseline.replace(archiveConflictRule, candidateV3Rule),
    candidateV4: baseline.replace(archiveConflictRule, candidateV4Rule),
    candidateV5: baseline.replace(archiveConflictRule, candidateV5Rule),
    candidateV6: baseline.replace(archiveConflictRule, candidateV6Rule),
    candidateV7,
  };
}

const archive = { ...emptySummary(), responsibilities: "本人独立实现缓存模块。", achievements: ["P95下降40%。"] };
const actualIssue = "本地文档目录工具供资料管理员查看文档条目，使用TypeScript。本人已补充操作说明。本人在本地用3份合成文档复现：目录按需求应显示3个条目，实际只显示2个。原因尚未定位，没有提出或实施修复，也没有修复效果验证。工具未发布，未用真实文档验证。材料没有提供模块划分或数据流。";

type ArchiveConflictCase = {
  id: string;
  projectName: string;
  archive: ProjectSummary;
  materials: ProjectMaterialRecordSource[];
  rubric: string[];
};

const sharedFactsRule = "只用输入证据，保留个人分工、指标依据、未知状态和适用范围；不得将档案重复当作独立核实，不得用无关字段替代争议字段。";
const processRule = "审阅流程（不计模型语义）：依据完整raw逐项判据并引用原文；协议通过不等于语义通过。";

/** Unresolved archive conflicts with correction, issue, and document-scope controls. */
export const projectSummaryArchiveConflictCases: ArchiveConflictCase[] = [
  {
    id: "unclarified-role-and-metric-conflict",
    ...unclarifiedProjectArchiveConflict,
    rubric: [
      "职责直接目标：当前访谈称缓存模块由同事实现，档案称本人独立实现，且没有明确更正；responsibilities须并列来源并标待核，不能在responsibilities、brief或其他字段选任一方为确定事实。",
      "未知记录直接目标：材料没有说明P95是否测量；不能断言已测或未测，也不能把该信息缺口填进challenges。P95下降40%仅见档案，不能作为可靠成果。没有实际问题及处理记录时challenges应为空。",
      "保护目标：brief或achievement至少保留本人补充并交付运行手册；不得因职责冲突删掉该无争议工作，也不得把缓存或P95归给本人。",
      sharedFactsRule,
      processRule,
    ],
  },
  {
    id: "explicit-role-and-metric-correction",
    projectName: "订单接口改造",
    archive,
    materials: [{
      title: "明确更正",
      content: "更正同一项目本次版本的旧档案：改造方案由其他成员负责，我只参与回归测试；本次版本尚未上线，旧档案中的P95下降40%未经验证，应撤回。",
    }],
    rubric: [
      "按材料明确更正后的事实整理：本人只参与回归测试、方案由其他成员负责、版本尚未上线，旧档案P95下降40%未经验证并撤回；不得继续标成待核或恢复旧职责和指标。",
      "没有材料记录实际项目难点及处理结果，challenges应为空；未上线或指标撤回本身不是项目难点。",
      "brief或achievement采用个人工作时保留‘只参与回归测试’和未上线范围；不能因旧档案冲突而删掉该明确的个人工作。",
      sharedFactsRule,
      processRule,
    ],
  },
  {
    id: "unclarified-role-and-rate-conflict",
    projectName: "接口防护服务",
    archive: { ...emptySummary(), responsibilities: "本人独立实现限流功能。", achievements: ["错误率下降30%。"] },
    materials: [
      { title: "当前访谈", content: "限流工作由平台组同事实现。当前访谈未说明错误率是否有测量记录，需核对。" },
      { title: "交付记录", content: "本人整理并提交限流配置检查表。" },
    ],
    rubric: [
      "职责直接目标：当前访谈称限流由平台组同事实现，档案称本人独立实现，且没有明确更正；responsibilities须并列两来源并标待核，不能确定采用任一说法。没有模块功能、数据流或技术方案材料，architecture与highlights应为空。",
      "未知指标直接目标：当前访谈没有说明错误率是否测量，档案的30%下降也没有测量依据；不能断言测过或未测，不能把未知测量记录写入challenges或简历成果。没有实际项目问题及处理记录时challenges应为空。",
      "保护目标：brief或achievement须保留本人整理并提交限流配置检查表这一无争议工作；不得因其他职责冲突删掉它。",
      sharedFactsRule,
      processRule,
    ],
  },
  {
    id: "documented-issue-remains-a-challenge",
    projectName: "本地文档目录工具",
    archive: emptySummary(),
    materials: [{ title: "复现记录", content: actualIssue }],
    rubric: [
      "challenges须保留本地合成文档中应显示3个条目但只显示2个的实际问题，并保留原因尚未定位、没有修复及没有修复验证的状态；不得因缺少原因或修复方案而留空。",
      "保留本人已补充操作说明以及本地3份合成文档的复现范围；不得编造修复、通过结论或真实文档验证。",
      "没有模块和数据流证据时architecture与highlights应为空；不把问题复现扩大成根因或实现方案。",
      sharedFactsRule,
      processRule,
    ],
  },
  {
    id: "reverse-unclarified-role-conflict",
    projectName: "报表平台",
    archive: { ...emptySummary(), responsibilities: "CSV导出模块由后端同事实现。" },
    materials: [{
      title: "工作记录",
      content: "本人实现CSV导出模块，支持生成日结表格。本人补充并交付了导出字段使用说明。",
    }],
    rubric: [
      "职责直接目标：当前工作记录称本人实现CSV导出模块，档案称由后端同事实现，且没有明确更正；responsibilities须并列来源并标待核，不能在任何字段选任一方为确定事实。",
      "没有材料支持已发生的项目问题及处理，challenges应为空；不能把冲突本身改写成实施故障或成果指标。",
      "保护目标：brief或achievement须保留本人补充并交付导出字段使用说明这一独立、无争议的工作；不能因模块职责冲突删掉文档工作。原文没有说明使用说明与CSV导出模块的用途或配套关系，不得将其说成‘为CSV导出模块’编写或该模块提供的说明，也不得把原文文档名扩写为‘CSV导出字段使用说明’。材料未说明实际使用的语言、框架、库或工具，techStack应为空；CSV文件格式本身不是技术栈。",
      sharedFactsRule,
      processRule,
    ],
  },
  {
    id: "holdout-retry-role-and-timeout-conflict",
    projectName: "消息投递平台",
    archive: { ...emptySummary(), responsibilities: "本人独立实现重试调度模块。", achievements: ["超时请求下降28%。"] },
    materials: [
      { title: "当前访谈", content: "重试调度由SRE组同事负责实现。访谈没有说明超时请求是否有测量记录，需核对。" },
      { title: "交付记录", content: "本人编写并交付值班操作手册。" },
    ],
    rubric: [
      "职责直接目标：当前访谈称重试调度由SRE组同事实现，档案称本人独立实现，且没有明确更正；responsibilities须并列来源并标待核，brief与achievement不能选任一方为确定事实。",
      "超时请求下降28%只见档案，材料未说明测量记录；不能作为可靠成果或写入简历，测量待核也不是实际难点，没有问题及处理依据时challenges应为空。",
      "brief或achievement须保留本人编写并交付值班操作手册这一无争议工作；不得因职责冲突删掉它。",
      sharedFactsRule,
      processRule,
    ],
  },
  {
    id: "holdout-document-name-and-csv-format",
    projectName: "名单导入工具",
    archive: emptySummary(),
    materials: [{
      title: "功能与交付记录",
      content: "名单导入工具接收CSV格式名单。本人实现导入时的必填项校验，缺项会显示字段名称。本人另行编写并交付《字段映射使用说明》。材料没有说明说明的适用对象，也没有提供核心开发语言或框架。",
    }],
    rubric: [
      "保护目标：保留本人实现必填项校验及另行编写、交付《字段映射使用说明》两项工作；原文没有说明说明的用途或配套关系，不得把它说成‘为名单导入工具’编写，也不得扩写文档名称。",
      "CSV是输入文件格式，不是techStack；材料没有说明实际使用的语言、框架、库或工具，techStack应为空。",
      "没有材料记录实际项目问题及处理依据，challenges应为空；不能把‘缺项时显示字段名称’这一已实现功能改写成故障或难点。",
      sharedFactsRule,
      processRule,
    ],
  },
];
