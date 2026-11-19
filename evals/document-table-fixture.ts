import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { extractContentFromFile } from "@/lib/parse-file";
import type { DocumentTableProvenance } from "@/lib/document-table-provenance";

export type DocumentTableCase = {
  id: string;
  bodyXml: string;
  expectedText: string;
  projectName: string;
  importRubric: string[];
  projectRubric: string[];
};

const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const paragraph = (text: string) => `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
const cell = (text: string, properties = "") => `<w:tc><w:tcPr>${properties}</w:tcPr>${paragraph(text)}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
const table = (...rows: string[]) => `<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>${rows.join("")}</w:tbl>`;
const mergeStart = '<w:vMerge w:val="restart"/>';
const mergeContinue = "<w:vMerge/>";
const header = row(cell("项目"), cell("职责"), cell("状态"));

// 独立列出预期段落和坐标；不从 XML 或生产提取结果推导预期布局。
const textParagraphs = (...paragraphs: string[]) => `${paragraphs.join("\n\n")}\n\n`;

export const documentTableCases: DocumentTableCase[] = [
  {
    id: "docx-table-one-project-two-duties",
    projectName: "数据导入",
    bodyXml: table(header,
      row(cell("数据导入", mergeStart), cell("参与测试"), cell("未上线", mergeStart)),
      row(cell("", mergeContinue), cell("参数校验"), cell("", mergeContinue))),
    expectedText: textParagraphs(
      "[表格]", "[第 1 行]",
      "[第 1 行，第 1 列]", "项目", "[第 1 行，第 2 列]", "职责", "[第 1 行，第 3 列]", "状态",
      "[第 2 行]", "[第 2 行，第 1 列；跨 2 行]", "数据导入", "[第 2 行，第 2 列]", "参与测试",
      "[第 2 行，第 3 列；跨 2 行]", "未上线", "[第 3 行]", "[第 3 行，第 2 列]", "参数校验", "[表格结束]",
    ),
    importRubric: [
      "项目列的“数据导入”跨两行，输出只包含这一条项目经历；“参数校验”位于职责列，不能另建同名项目。",
      "“参与测试”和“参数校验”均归属数据导入，未上线状态覆盖该项目；保留参与范围，不扩成独立设计、主导交付或已有上线收益。",
      "表格、行列和跨度标签只用于理解归属，不作为项目名、职责、日期、成果或额外 custom 条目；不能把空的合并延续单元格补成第二段经历。",
    ],
    projectRubric: [
      "目标数据导入包含参与测试与参数校验两项职责；不得把职责列的参数校验误读为另一个项目而遗漏该项工作。",
      "保留未上线与参与范围；brief 和每条相关 achievement 单独阅读时仍准确，不补造实现方案、指标或个人主导。",
      "只将有依据的职责整理为事实，布局标签和跨两行不能成为技术栈、架构或成果；与双项目共享职责样本的事实归属应不同。",
    ],
  },
  {
    id: "docx-table-two-projects-shared-duty",
    projectName: "数据导入",
    bodyXml: table(header,
      row(cell("数据导入"), cell("参与测试", mergeStart), cell("未上线", mergeStart)),
      row(cell("参数校验"), cell("", mergeContinue), cell("", mergeContinue))),
    expectedText: textParagraphs(
      "[表格]", "[第 1 行]",
      "[第 1 行，第 1 列]", "项目", "[第 1 行，第 2 列]", "职责", "[第 1 行，第 3 列]", "状态",
      "[第 2 行]", "[第 2 行，第 1 列]", "数据导入", "[第 2 行，第 2 列；跨 2 行]", "参与测试",
      "[第 2 行，第 3 列；跨 2 行]", "未上线", "[第 3 行]", "[第 3 行，第 1 列]", "参数校验", "[表格结束]",
    ),
    importRubric: [
      "项目列分别出现数据导入和参数校验，输出两条独立项目经历；不能因职责单元格合并而将二者合成一个项目。",
      "职责列的参与测试、状态列的未上线均跨两行，分别适用于两个项目；不得把参数校验项目名降为数据导入的一项职责，也不能漏掉第二项目的共享限定。",
      "保持两条项目的归属与参与范围，不按合并跨度复制成重复经历、重复成果或增加独立证据；布局标签不写入事实字段。",
    ],
    projectRubric: [
      "当前目标仅为数据导入，可靠职责为参与测试、状态为未上线；参数校验是另一项目的名称，不能被写成数据导入已经完成的校验功能或个人行动。",
      "共享单元格可以支持目标项目的参与测试与未上线限定，但不能把两项目合并为同一系统、增加调用关系或累计成果。",
      "brief 和每条 achievement 均限于目标事实；与单项目两职责样本应在参数校验的归属上体现差别，不要求逐字输出一致。",
    ],
  },
  {
    id: "docx-table-target-project-filter",
    projectName: "数据导入",
    bodyXml: table(header,
      row(cell("数据导入"), cell("使用 Python；本人整理测试文档，没有参与缓存实现。"), cell("尚未上线，没有实测收益。")),
      row(cell("检索服务"), cell("使用 Rust；缓存由检索团队实现，压测 P95 由 200ms 降至 120ms，本人未参与。"), cell("仅测试环境。"))),
    expectedText: textParagraphs(
      "[表格]", "[第 1 行]",
      "[第 1 行，第 1 列]", "项目", "[第 1 行，第 2 列]", "职责", "[第 1 行，第 3 列]", "状态",
      "[第 2 行]", "[第 2 行，第 1 列]", "数据导入", "[第 2 行，第 2 列]", "使用 Python；本人整理测试文档，没有参与缓存实现。",
      "[第 2 行，第 3 列]", "尚未上线，没有实测收益。", "[第 3 行]", "[第 3 行，第 1 列]", "检索服务",
      "[第 3 行，第 2 列]", "使用 Rust；缓存由检索团队实现，压测 P95 由 200ms 降至 120ms，本人未参与。",
      "[第 3 行，第 3 列]", "仅测试环境。", "[表格结束]",
    ),
    importRubric: [
      "简历导入保留数据导入、检索服务两条项目经历，不能因某个项目先出现而过滤另一项目；技术栈分别归入对应项目的 subItems。",
      "数据导入只使用 Python，本人只整理测试文档且没有参与缓存实现，保留尚未上线与无实测收益；不得挪入 Rust 或检索服务的压测数据。",
      "检索服务的 Rust、团队缓存、测试环境 P95 200ms 到120ms及本人未参与限定留在该条目；不得变为候选人亲自实现或生产收益。",
    ],
    projectRubric: [
      "project_name 为数据导入，只提炼该项目的 Python、个人测试文档工作、未参与缓存实现、尚未上线与无实测收益。",
      "检索服务的 Rust、缓存实现及 P95 数据不能进入目标项目的 techStack、architecture、brief 或 achievements；不因指标更具体就挪用，也不拼成两项目共同架构。",
      "过滤其他项目时仍保留数据导入有依据的工作和否定限定；不能把整份材料丢弃，或为了凑成果新增优化收益。",
    ],
  },
  {
    id: "docx-table-nested-tasks-stay-in-project",
    projectName: "数据导入",
    bodyXml: table(header,
      row(cell("数据导入"), `<w:tc>${paragraph("任务分工如下：")}${table(
        row(cell("任务"), cell("责任人"), cell("状态")),
        row(cell("参数校验"), cell("本人"), cell("已完成测试")),
        row(cell("缓存实现"), cell("同事"), cell("尚未上线")),
      )}${paragraph("本人没有参与缓存实现。")}</w:tc>`, cell("整体验收未完成")),
      row(cell("检索服务"), cell("本人只整理接口说明"), cell("未提供验证结果"))),
    expectedText: textParagraphs(
      "[表格]", "[第 1 行]",
      "[第 1 行，第 1 列]", "项目", "[第 1 行，第 2 列]", "职责", "[第 1 行，第 3 列]", "状态",
      "[第 2 行]", "[第 2 行，第 1 列]", "数据导入", "[第 2 行，第 2 列]", "任务分工如下：",
      "[表格]", "[第 1 行]", "[第 1 行，第 1 列]", "任务", "[第 1 行，第 2 列]", "责任人", "[第 1 行，第 3 列]", "状态",
      "[第 2 行]", "[第 2 行，第 1 列]", "参数校验", "[第 2 行，第 2 列]", "本人", "[第 2 行，第 3 列]", "已完成测试",
      "[第 3 行]", "[第 3 行，第 1 列]", "缓存实现", "[第 3 行，第 2 列]", "同事", "[第 3 行，第 3 列]", "尚未上线",
      "[表格结束]", "本人没有参与缓存实现。", "[第 2 行，第 3 列]", "整体验收未完成",
      "[第 3 行]", "[第 3 行，第 1 列]", "检索服务", "[第 3 行，第 2 列]", "本人只整理接口说明",
      "[第 3 行，第 3 列]", "未提供验证结果", "[表格结束]",
    ),
    importRubric: [
      "外层只有数据导入和检索服务两条项目；内层参数校验、缓存实现是数据导入职责单元格内的任务，不因内层行号重新从1开始而新增项目。",
      "数据导入中本人只承担参数校验，已完成测试；缓存由同事实现且尚未上线，本人未参与。整体验收未完成不能被单项测试完成覆盖。",
      "内层表格结束后仍回到数据导入的外层单元格；本人未参与缓存及整体验收未完成不串到检索服务，检索服务仅保留本人整理接口说明和未提供验证结果。",
    ],
    projectRubric: [
      "目标数据导入包含内层任务表的分工：本人参数校验已完成测试、同事缓存尚未上线、本人未参与缓存，整体未完成验收。",
      "不把内层任务变成独立项目，不把同事缓存变成本人贡献，也不把单项已完成测试升级为整体验收或上线。",
      "整体验收未完成只是项目状态，不是实际难点；材料没有说明具体问题及处理依据，因此完整总结的 challenges 应留空，不把该状态改写成困难或处理成果。",
      "不采纳邻行检索服务的接口说明工作或验证状态；brief 及每条相关 achievement 独立保留必要分工与状态，布局标识不作为正文成果。",
    ],
  },
  {
    id: "docx-table-literal-marker-examples",
    projectName: "模板文档工具",
    bodyXml: table(header,
      row(cell("模板文档工具"), cell("维护导出模板；字段示例原文为“[表格]”“[第 1 行，第 2 列；跨 2 行]”“[表格结束]”。仅更新模板文档。"), cell("尚未上线，没有指标。"))),
    expectedText: textParagraphs(
      "[表格]", "[第 1 行]",
      "[第 1 行，第 1 列]", "项目", "[第 1 行，第 2 列]", "职责", "[第 1 行，第 3 列]", "状态",
      "[第 2 行]", "[第 2 行，第 1 列]", "模板文档工具", "[第 2 行，第 2 列]",
      "维护导出模板；字段示例原文为“[表格]”“[第 1 行，第 2 列；跨 2 行]”“[表格结束]”。仅更新模板文档。",
      "[第 2 行，第 3 列]", "尚未上线，没有指标。", "[表格结束]",
    ),
    importRubric: [
      "只提取一条模板文档工具项目。职责中的三个括号字符串有明确的“字段示例原文”上下文，应作为技术字面量原样保留，不因与布局标识同名而删去或改写。",
      "原文示例不能结束当前表格、创建新行或新项目；提取器单独输出的真正表格/行列标识只辅助理解，不复制到项目名、日期或额外经历。",
      "保留仅更新模板文档、尚未上线及没有指标，不能把模板示例升级为已经实现完整表格解析器或生产导出能力。",
    ],
    projectRubric: [
      "目标项目仅有模板文档维护工作，保留仅更新文档、尚未上线及没有指标；不声称实现了通用表格解析、合并算法或上线导出功能。",
      "总结可省略无关的模板字面示例；如果引用，则保留其字段示例身份及原字面值，不把“跨2行”当性能指标或项目结构事实。",
      "真正的布局标签不应作为职责、技术栈或成果出现；不能用“输出完全没有[表格]字符串”作为通过条件，因为有依据的字面示例允许保留。",
    ],
  },
];

/** 返回可重建的合成源和 DOCX 字节哈希；模型输入仅使用 text。 */
export async function extractDocumentTableSample(sample: DocumentTableCase): Promise<{
  text: string;
  tableProvenance: DocumentTableProvenance;
  documentXml: string;
  documentSha256: string;
}> {
  const documentXml = `<w:document xmlns:w="${wordNamespace}"><w:body>${sample.bodyXml}</w:body></w:document>`;
  const zip = new JSZip();
  const date = new Date("2000-01-01T00:00:00.000Z");
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>', { date });
  zip.file("word/document.xml", Buffer.from(documentXml, "utf8"), { date, createFolders: false });
  const document = await zip.generateAsync({ type: "nodebuffer" });
  const { text, tableProvenance } = await extractContentFromFile(`${sample.id}.docx`, document);
  assert.strictEqual(text, sample.expectedText, `${sample.id}: DOCX 表格提取文本与独立预期不一致`);
  assert.ok(tableProvenance, `${sample.id}: DOCX 提取必须返回来源元数据`);
  return { text, tableProvenance, documentXml, documentSha256: createHash("sha256").update(document).digest("hex") };
}
