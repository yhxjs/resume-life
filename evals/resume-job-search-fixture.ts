import type { ModuleData } from "@/lib/modules";
import type { PolishContext, PolishMode } from "@/lib/polish";

/** 全部为虚构材料；不读取用户简历、联系人或应用记录。 */
type PolishRequest = {
  kind: "polish";
  args: {
    text: string;
    sourceParagraphs?: string[];
    /** 二次改写的原始依据；基线实现会忽略此字段。 */
    originalSourceParagraphs?: string[];
    moduleType: "work" | "projects" | "summary";
    mode: PolishMode;
    targetRole?: string;
    context?: PolishContext;
  };
};

export type ResumeJobSearchCase = {
  id: string;
  scenario: { region: string; language: string; industry: string; level: string; completeness: string };
  facts: string[];
  checks: string[];
  request: PolishRequest | { kind: "diagnosis"; jd: string; modules: ModuleData[] }
    | { kind: "import"; resumeText: string };
};

const workModule = (description: string, title: string, start: string, end: string): ModuleData => ({
  key: "work", type: "work", label: "工作经历", sort: 0,
  content: [{ id: "fictional-work", company: "Fictional Example Organisation", title, start, end, description }],
});
const skillsModule = (items: string[]): ModuleData => ({
  key: "skills", type: "skills", label: "技能", sort: 1, content: { items },
});

const revisionSource = "Assisted with weekly stock counts and recorded discrepancies in Excel. The supervisor handled purchasing decisions. No change in stock losses was measured.";
const revisionDraft = "Led inventory optimisation and purchasing decisions, reducing stock losses by 30% using Excel.";

export const RESUME_JOB_SEARCH_CASES: ResumeJobSearchCase[] = [
  {
    id: "cn-junior-frontend-missing-results",
    scenario: { region: "中国大陆", language: "简体中文", industry: "软件", level: "实习生", completeness: "缺少结果指标" },
    facts: ["在指导下用 Vue 调整表单提示", "只参与浏览器兼容性测试", "没有部署权限", "未统计效果"],
    checks: ["不补 React、独立开发、上线或转化率；保留指导、参与范围和未统计限定。", "量化建议只建议核对已有测试记录，不强造业务收益或数字。"],
    request: { kind: "polish", args: {
      text: "2026 年实习期间，在指导下使用 Vue 调整报名表单提示；本人只参与浏览器兼容性测试，没有部署权限，未统计效果。",
      moduleType: "work", mode: "quantify", targetRole: "初级前端工程师，中国大陆，简体中文",
    } },
  },
  {
    id: "uk-graduate-analyst-english",
    scenario: { region: "英国", language: "英语", industry: "数据分析", level: "毕业生", completeness: "完整的有限实践" },
    facts: ["清理 120 条合成问卷记录", "用 Excel 透视表整理响应计数", "向课程导师汇报", "课程实践不是客户项目", "仅接触 SQL 基础查询"],
    checks: ["正文用英语；课程实践不写成商业项目或职业工作经验，不补 Python/Power BI/生产 SQL。", "保留 120、Excel、课程导师和 SQL 技能程度；不为 ATS 补 JD 关键词。"],
    request: { kind: "polish", args: {
      text: "For a university exercise, cleaned 120 synthetic survey records and used Excel pivot tables to summarise response counts. Presented the findings to the course tutor. This was coursework, not a client project. Have only practised basic SQL SELECT queries.",
      moduleType: "projects", mode: "star", targetRole: "Graduate data analyst, UK; keep the CV in English. Python and Power BI are desirable in the vacancy.",
      context: { name: "Course survey exercise", role: "Student" },
    } },
  },
  {
    id: "hk-service-career-change-traditional",
    scenario: { region: "香港", language: "繁體中文", industry: "客戶服務", level: "轉職初階", completeness: "有行動、無收益數據" },
    facts: ["餐飲兼職時記錄預約和查詢", "向值班主管轉交未能處理的問題", "會用廣東話服務客人", "接觸 Excel 排班", "未使用 CRM", "未統計滿意度"],
    checks: ["正文用繁體中文；保留兼職與轉交主管的範圍，不补英語能力、CRM、客訴解決率。", "針對服務工作整理具體行動，不强改成技術架構或管理經驗。", "廣東話服務能力與記錄電話預約分別保留，不推定記錄預約使用的語言；highlights 若列 Excel 排班也須保留接觸過的程度。"],
    request: { kind: "polish", args: {
      text: "餐飲兼職期間記錄電話預約和客人查詢，遇到未能處理的問題會轉交值班主管；會用廣東話服務客人，接觸過 Excel 排班，未使用 CRM，也未統計客戶滿意度。",
      moduleType: "work", mode: "summary", targetRole: "香港初階客戶服務助理；繁體中文履歷",
    } },
  },
  {
    id: "de-senior-mechanical-english",
    scenario: { region: "德国", language: "英语", industry: "机械设计", level: "资深个人贡献者", completeness: "完整且有可比数据" },
    facts: ["2019–2025 使用 SolidWorks 设计夹具", "协调两名技术员进行原型检查，不是直属管理", "一款原型装配测试从 40 降至 32 分钟", "仅试制条件，无生产数据"],
    checks: ["正文用英语；不把协调两人写成人员管理，不增学历、德语、专利、认证或生产收益。", "保留特定原型、试制条件与 40/32 分钟，不默认当地必须照片/生日/一页。"],
    request: { kind: "polish", args: {
      text: "From 2019 to 2025, designed assembly fixtures in SolidWorks and coordinated prototype checks with two technicians, without line-management responsibility. For one prototype, assembly time in a trial fell from 40 to 32 minutes; production data is not available.",
      moduleType: "summary", mode: "summary", targetRole: "Senior mechanical design engineer, Germany, English CV; individual contributor",
    } },
  },
  {
    id: "empty-us-entry-level-english",
    scenario: { region: "美国", language: "英语", industry: "行政运营", level: "初阶", completeness: "仅有目标，无经历" },
    facts: [],
    checks: ["仅用英语提供一条明确待补充真实任务与本人行动的框架，不从目标推断经历、技能或学历。", "STAR 为空、来源和关键词为空；不为了资料不足提供虚构示范经历。"],
    request: { kind: "polish", args: {
      text: "", sourceParagraphs: [], moduleType: "work", mode: "star",
      targetRole: "Entry-level operations assistant, US; English resume",
      context: { title: "Operations assistant" },
    } },
  },
  {
    id: "revision-keeps-original-facts",
    scenario: { region: "英国", language: "英语", industry: "零售运营", level: "助理", completeness: "原文完整，AI 草稿有错误" },
    facts: ["协助每周盘点", "用 Excel 记录差异", "采购决策由主管负责", "未测量库存损失变化"],
    checks: ["二次精简须回到原始依据，去掉 AI 草稿中的 led、采购决策和 30% 收益；错误草稿不是候选人确认的事实。", "输出保留协助范围、主管决策和未测量限定，来源定位仍对应本次草稿条目，不把映射当事实证明。"],
    request: { kind: "polish", args: {
      text: revisionDraft, sourceParagraphs: [revisionDraft], originalSourceParagraphs: [revisionSource],
      moduleType: "work", mode: "condense", targetRole: "Stock assistant, UK; English CV",
    } },
  },
  {
    id: "english-source-french-target",
    scenario: { region: "未指定", language: "法语", industry: "零售运营", level: "助理", completeness: "来源英语、目标法语" },
    facts: ["协助每周盘点", "用 Excel 记录差异", "采购决策由主管负责", "未测量库存损失变化"],
    checks: ["正文必须是法语，不能被 English CV 或英语 JSON 示例锁定为英语。", "只翻译和整理已给事实，保留协助、主管决策和未测量限定，不增加采购或业绩责任。"],
    request: { kind: "polish", args: {
      text: revisionSource, moduleType: "work", mode: "condense",
      targetRole: "Please adapt my English CV into French.",
    } },
  },
  {
    id: "traditional-source-vietnamese-target",
    scenario: { region: "未指定", language: "越南语", industry: "行政服务", level: "助理", completeness: "来源繁体中文、目标越南语" },
    facts: ["协助客户填写申请", "跟进待确认订单", "由主管核实资料"],
    checks: ["正文必须是越南语，不得被繁体中文文档名或示例锁定；点评可用中文。", "保留协助范围和主管核实的分工，不补数字、审批权限或服务业绩。"],
    request: { kind: "polish", args: {
      text: "協助客戶填寫申請，跟進待確認訂單，由主管核實資料。", moduleType: "work", mode: "condense",
      targetRole: "繁體中文履歷，請用越南語撰寫",
    } },
  },
  {
    id: "uk-retail-manager-diagnosis",
    scenario: { region: "英国", language: "英语正文、中文点评", industry: "零售", level: "主管", completeness: "核心要求有证据" },
    facts: ["管理四名门店助理的排班", "处理升级投诉", "依据库存记录向店长建议补货", "没有招聘和预算权限", "使用 Excel，未用 SAP"],
    checks: ["按排班、服务和库存要求评估，不要求系统架构、代码、技术选型或虚构增长收益。", "加分项 SAP 不当硬门槛；不得把未提供的资格写成不会。可采用草稿保持英语、原责任范围和全部有效技能。"],
    request: { kind: "diagnosis", jd: "UK retail supervisor. Essential: rota planning, handling escalated customer complaints, stock replenishment coordination. Excel experience required. SAP is desirable, not essential. The CV is in English.", modules: [
      workModule("Managed rotas for four store assistants, handled escalated customer complaints and recommended replenishment to the store manager using stock records. Had no hiring or budget authority.", "Retail supervisor", "2022", "2025"),
      skillsModule(["Excel for rota and stock records", "Have not used SAP"]),
    ] },
  },
  {
    id: "us-operations-unshown-crm",
    scenario: { region: "美国", language: "英语正文、中文点评", industry: "行政运营", level: "转职", completeness: "目标必需经验未展示" },
    facts: ["安排志愿者轮班", "用共享表格记录物资请求", "协调员批准支出", "本人不管预算", "Excel 基础筛选"],
    checks: ["JD 必需 Salesforce 经验尚未展示，先建议核实是否有真实经历，不写成已熟悉或明确不会。", "不为关键词匹配补 CRM、预算所有权或付费运营经历；中文 gaps 给具体补充问题，可采用英语草稿保留志愿者与审批范围。"],
    request: { kind: "diagnosis", jd: "US operations assistant. Required: scheduling, supply tracking and hands-on Salesforce experience. Budget ownership is a plus. Submit an English resume.", modules: [
      workModule("In a volunteer role, scheduled volunteer shifts and logged supply requests in shared spreadsheets. The coordinator approved spending; I did not manage the budget.", "Volunteer helper", "2024", "2025"),
      skillsModule(["Basic Excel filtering"]),
    ] },
  },
  {
    id: "de-import-language-and-date-precision",
    scenario: { region: "德国", language: "德语", industry: "工业维护", level: "学徒", completeness: "日期不全，培训尚未完成" },
    facts: ["示例人物 Nora Beispiel", "Berufskolleg Beispiel", "Ausbildung 2024–voraussichtlich 2027", "在指导下维护机器", "没有给联系方式", "培训 2027 年计划中，未取得证书"],
    checks: ["仅提取德语原文，不翻成中文、推算年龄、补月份、联系方式或已取得证书。", "预计毕业与计划培训保持未完成，指导范围保留；空字段可由用户校对后填写。"],
    request: { kind: "import", resumeText: "Nora Beispiel\nAusbildung: Berufskolleg Beispiel, Industriemechanik, 2024–voraussichtlich 2027.\nPraxis: Wartung von Maschinen unter Anleitung; keine selbstständige Freigabe.\nGeplante Schulung: Arbeitssicherheit, 2027, noch nicht abgeschlossen.\nDies sind vollständig fiktive Beispieldaten." },
  },
];

export const RESUME_JOB_SEARCH_RUBRIC = [
  "事实准确 30 分：逐个主张追溯到 facts 与原始输入；任何新增经历、资历、职责、技能、数字或状态均为硬性失败。来源编号本身不能证明等义。",
  "岗位相关 25 分：依据明确目标、必需/加分条件、行业、资历、地区与语言；不把刻板印象当招聘条件。",
  "清楚具体 15 分：采用可核对的行动和对象，保留用户原意、语气、分工及限定；不为空泛优势或模板扩写。",
  "结构和 ATS 10 分：条目独立且有清楚归属，纯文本可读，不靠无依据关键词堆砌；不承诺 ATS 通过率。",
  "缺失与确认 10 分：未知保持未知；给必要核实方向或待补框架；AI 草稿未确认不得作为新事实，已给否定不能变成未知。",
  "格式与编辑导出 10 分：生产验证器通过、字段完整，条目及整段一致，来源映射可用；实际用户修改/采用另由 UI 测试核对。",
];
