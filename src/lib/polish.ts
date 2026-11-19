import { stripLeadingListMarker } from "@/lib/rich-text";
import { METRIC_EVIDENCE_RULES } from "@/lib/prompt-guidelines";
import { hasQuestionContent } from "@/lib/question-normalization";
import type { PromptPart, SafeMessage } from "./safe-llm";

export type PolishMode = "star" | "quantify" | "summary" | "condense";

export type StarBreakdown = {
  situation: string;
  task: string;
  action: string;
  result: string;
};

export type QuantifiedTip = {
  dimension: string;
  metric: string;
  tip: string;
  example: string;
};

export type PolishDraftItem = {
  text: string;
  // 缺失表示旧版未返回映射；空数组表示未能关联来源，不应再猜测。
  sourceIndices?: number[];
};

export type PolishResult = {
  star?: StarBreakdown | null;
  quantifiedTips: QuantifiedTip[];
  draft: string;
  draftItems?: string[];
  draftItemDetails?: PolishDraftItem[];
  highlights: string[];
};

export type PolishContext = {
  title?: string;
  company?: string;
  name?: string;
  role?: string;
};

type PromptMarker = { token: string; tag: string; text: string };

function splitPromptMarkers(template: string, markers: PromptMarker[]): PromptPart[] {
  const markerByToken = new Map(markers.map(marker => [marker.token, marker]));
  const parts: PromptPart[] = [];
  let offset = 0;
  for (const match of template.matchAll(/__SAFE_POLISH_[A-Z]+(?:_P_\d+)?__/g)) {
    const marker = markerByToken.get(match[0]);
    if (!marker) continue;
    if (match.index > offset) parts.push({ trust: "trusted", text: template.slice(offset, match.index) });
    parts.push({ trust: "untrusted", tag: marker.tag, text: marker.text });
    offset = match.index + match[0].length;
  }
  if (offset < template.length) parts.push({ trust: "trusted", text: template.slice(offset) });
  return parts;
}

/** 新生成润色结果的篇幅与数量上限；兼容清洗函数不套用这些限制。 */
export const POLISH_OUTPUT_LIMITS = {
  draft: 10_000,
  draftItem: 600,
  maxDraftItems: 20,
  starField: 600,
  dimension: 80,
  metric: 120,
  tip: 300,
  example: 200,
  maxQuantifiedTips: 3,
  highlight: 80,
  maxHighlights: 5,
} as const;

const SYSTEM_PROMPT = `你是简历编辑。根据本次指定的模块与模式优化表达，保留原文事实和个人职责，输出单个 JSON。

事实与编辑规则：
- 目标岗位只用于选择强调重点，不能变成候选人已具备的能力；不新增技术栈、选型理由、成果，不把“参与”升级为“主导”。
- 职责范围也不能无依据地缩小：“参与某项工作”不等于“只参与/仅负责该项”。“未负责某事”只限定责任，不等于没做过、不熟悉、缺乏经验或经验尚待积累。保留原文明确否定的具体职责，不把局部否定扩成对其他未提及工作的排除；原文明确写“仅、只、未参与”的限定则须保留。
- 严禁输出抬头标题：draft 和 draftItems 不含公司/职位/项目名称及日期的标题行；具体正文可保留必要的业务名词。
- 智能精简合并与动态合理条目数：聚合同类项，同一任务的行动和结果放在一起，独立贡献分别保留；删掉重复与无信息量表述，不按固定数量扩写，也不机械删除有实际价值的协作、文档或排障工作。
- 来源段落编号只用于定位原文，不表示相邻段落属于同一项目、版本或任务。合并行动与结果前确认原文有明确对应关系，不把另一任务的技术、指标或团队结果接到个人行动上；自我评价可跨经历归纳，但不拼成一段不存在的经历，不合计口径不同或重复出现的指标。归属或关系不明时分开保留，不猜造因果关系。
- draftItems 每条都可能被单独勾选采纳，必要的个人/团队分工、所属任务、版本、测试环境、计划中或未上线等限定须在本条说清，不依赖其他条目、star 或 quantifiedTips 补足。同一任务的行动与责任限制、发布状态优先合成一条，不把正面行动和否定限定拆为两条可分别采纳的内容；确需拆开独立任务时，每条携带适用于本条的限定。材料支持的维护、协作、验证和未达目标也可如实写入，不将行动本身改成已取得的收益；精简时先删重复背景，不删这些限定。
- 仅在 star/quantify 模式且相关行动已有依据而指标缺失时，可使用 [请填入真实数据：具体指标与统计口径]；不附虚构示例数值，不暗示未证实的提升。quantifiedTips 推荐核实方式，不代填数据。
${METRIC_EVIDENCE_RULES}

模式区别：
- star：整理背景、目标、行动、结果；star 中没有依据的字段为 ""，不强补 STAR。
- quantify：围绕已有行动提出至多 3 个最有价值的度量建议，说明查什么、怎么算。
- condense：以删重、合并和缩短为主，保留原有事实、数据与有效限定；不新增量化占位符，quantifiedTips 为 []。
- summary（自我评价真实场景撰写逻辑）：只归纳原文支持的优势，通常 1-4 条。拒绝假大空套话，不强求覆盖所有能力维度。不强求新增数字；原文已有且与优势相关的年限、范围或指标保留原值、单位、口径与限定，不因是自我评价就删除，不自行累加年限或扩大数量。严禁输出 "[请填入真实数据...]" 这类量化占位符；star 为 null，quantifiedTips 为 []。

输出约束：
- draftItems 一律为对象数组，是正文条目的权威来源。每条 text 不带前缀符号，不使用 HTML 排版；draft 按相同条目及顺序生成，每项增加 • 前缀与换行，不额外写分析。若两者不一致，以 draftItems 为准并在输出前修正 draft。
- 所有文本字段按纯文本输出，不用 HTML 标签排版；技术内容中的标签名、反斜杠路径、正则与实体字面量原样保留，不自行解码或转义为 HTML。换行只使用 JSON 标准转义，不用 <br> 或二次转义的反斜杠 n 代替排版换行。
- 生成硬上限：draft 最多 ${POLISH_OUTPUT_LIMITS.draft} 字；draftItems 最多 ${POLISH_OUTPUT_LIMITS.maxDraftItems} 条、每条最多 ${POLISH_OUTPUT_LIMITS.draftItem} 字；star 各字段最多 ${POLISH_OUTPUT_LIMITS.starField} 字；quantifiedTips 最多 ${POLISH_OUTPUT_LIMITS.maxQuantifiedTips} 条，dimension/metric/tip/example 分别最多 ${POLISH_OUTPUT_LIMITS.dimension}/${POLISH_OUTPUT_LIMITS.metric}/${POLISH_OUTPUT_LIMITS.tip}/${POLISH_OUTPUT_LIMITS.example} 字；highlights 最多 ${POLISH_OUTPUT_LIMITS.maxHighlights} 条、每条最多 ${POLISH_OUTPUT_LIMITS.highlight} 字。超限、错误类型或残缺条目会整份拒绝，不截断、不丢条目后继续展示。
- sourceIndices 是对应来源段落的 1-based 整数数组，去重升序，不能越界；有原文但未分段时为 [1]。没有原文时仅给一条明确“待补充”的填写框架，sourceIndices 与 highlights 为 []，不得凭名称补造经历。
- 无法可靠确认某条内容的来源时，sourceIndices 也用 []，不能按条目位置或关联全部段落来猜测。
- highlights 只列原文支持的关键词，至多 5 个。只输出示例中的字段，JSON 字符串换行使用标准转义，不附代码围栏。`;

export function buildPolishPrompt(args: {
  text: string;
  sourceParagraphs?: string[];
  moduleType: "work" | "projects" | "summary";
  mode: PolishMode;
  context?: PolishContext;
  targetRole?: string;
}): { system: string; user: string } {
  const { text, sourceParagraphs, moduleType, mode, context, targetRole } = args;

  const ctxParts: string[] = [];
  if (context?.company) ctxParts.push(`所属公司/组织：${context.company}`);
  if (context?.title) ctxParts.push(`职位名称：${context.title}`);
  if (context?.name) ctxParts.push(`项目名称：${context.name}`);
  if (context?.role) ctxParts.push(`担任角色：${context.role}`);
  if (targetRole?.trim()) ctxParts.push(`求职目标岗位/偏向：${targetRole.trim()}`);

  const isSummary = moduleType === "summary" || mode === "summary";

  // 自我评价仍沿用专属字段约定，但明确请求的二次精简优先于模块默认模式。
  const modeInstructions = isSummary && mode !== "condense"
    ? "【润色模式】：summary。提炼有证据的个人优势，不强求新增数字，保留原文已有且相关的数据与限定，不新增量化占位符。一项工作及其职责限制写在同一条；不要另写能力短板或成长建议，也不把未负责改成缺乏经验。star 设为 null，quantifiedTips 设为 []。"
    : mode === "star"
      ? "【润色模式】：star。按已有事实整理 STAR，缺失要素留空。"
      : mode === "quantify"
        ? "【润色模式】：quantify。识别可核实的指标与计算方法，保留已有数据。"
        : "【润色模式】：condense。删重、合并与缩短，保留原有事实和数据；不新增量化占位符，quantifiedTips 为 []。";

  const paragraphs = sourceParagraphs?.map(paragraph => paragraph.trim()).filter(Boolean) ?? [];
  const rawSource = paragraphs.length > 0
    ? paragraphs
        .map((p, idx) => `[来源段落 ${idx + 1}]：\n${p}`)
        .join("\n\n")
    : text.trim();

  // 示例本身也满足当前协议，避免要求模型纠正模式外字段或不存在的来源编号。
  // 只按模式与是否有来源选择固定文案，不将用户材料插入系统提示。
  const exampleText = rawSource
    ? "基于来源原文的独立条目，保留必要限定"
    : isSummary ? "待补充：有真实经历支持的个人优势" : "待补充：真实任务、本人行动与已知结果";
  const example = {
    star: isSummary ? null : { situation: "", task: "", action: "", result: "" },
    quantifiedTips: [],
    draft: `• ${exampleText}`,
    draftItems: [{ text: exampleText, sourceIndices: rawSource ? [1] : [] }],
    highlights: [],
  };

  const user = isSummary
    ? `【模块类型】：自我评价
${ctxParts.length ? `【上下文信息（仅作为背景参考，简历中已有专门输入框，严禁在 draft 中输出抬头标题行）】：\n${ctxParts.join("\n")}\n` : ""}
${modeInstructions}

【原始待润色内容】：
${rawSource || "（暂无原文，仅输出待补充真实优势的填写框架，不推断候选人能力；sourceIndices 为 []）"}

请输出润色分析 JSON。draft 与 draftItems 一一对应，带 • 前缀，不强求新增数字，保留原文已有且相关的数据与限定，不新增量化占位符，切勿包含抬头标题行。sourceIndices 对应真实来源。star 设为 null，quantifiedTips 设为 []。`
    : `【模块类型】：${moduleType === "work" ? "工作经历" : "项目经历"}
${ctxParts.length ? `【上下文信息（仅作为技术与业务背景参考，简历中已有专门输入框，严禁在 draft 中输出公司/职位/项目标题抬头行）】：\n${ctxParts.join("\n")}\n` : ""}
${modeInstructions}

【原始待润色内容】：
${rawSource || "（暂无原文，仅输出待补充真实经历的填写框架，不推断技术方案、个人职责或成果；sourceIndices 为 []）"}

请输出润色分析 JSON。注意：draft 仅输出有原文依据的工作或项目内容条目（带 • 前缀），不强求每条都有成果，切勿包含公司、职位、项目名等抬头标题行。在 draftItems 中输出各条目并标明对应的来源段落索引 sourceIndices（如 [1] 或多段融合的 [1, 2]）。务必控制输出篇幅高度凝练，保留各条必要限定，确保在 token 预算内完整输出并闭合 JSON。`;

  return {
    system: `${SYSTEM_PROMPT}\n所有非空输出文本必须包含可见内容，不用零宽、控制字符或纯标点占位；协议允许的空字段和空数组保持为空。\n以下 JSON 示例已按本次模块、模式与有无原文选择字段及空值。${rawSource ? "正文与来源编号仅示意格式，实际内容须根据原文填写。" : "没有原文，只保留待补充框架，不把公司、职位或项目名称当成经历。"}${isSummary ? "star 保持 null。" : "STAR 各字段只填写有依据的内容，缺失保留空字符串。"}\n${JSON.stringify(example, null, 2)}`,
    user,
  };
}

export function buildPolishMessages(args: {
  text: string;
  sourceParagraphs?: string[];
  moduleType: "work" | "projects" | "summary";
  mode: PolishMode;
  context?: PolishContext;
  targetRole?: string;
}): { system: string; messages: SafeMessage[] } {
  const markers: PromptMarker[] = [];
  const markedContext: PolishContext = {};
  const mark = (token: string, tag: string, value: string) => {
    markers.push({ token, tag, text: value });
    return token;
  };
  for (const field of ["company", "title", "name", "role"] as const) {
    const value = args.context?.[field];
    if (!value) continue;
    const marker = field === "company" ? ["__SAFE_POLISH_COMPANY__", "company_name"]
      : field === "title" ? ["__SAFE_POLISH_TITLE__", "job_title"]
        : field === "name" ? ["__SAFE_POLISH_PROJECT__", "project_name"]
          : ["__SAFE_POLISH_ROLE__", "project_role"];
    markedContext[field] = mark(marker[0]!, marker[1]!, value);
  }
  const markedTargetRole = args.targetRole?.trim()
    ? mark("__SAFE_POLISH_TARGET__", "target_role", args.targetRole.trim()) : "";
  const markedText = args.text.trim() ? mark("__SAFE_POLISH_SOURCE__", "resume_source", args.text.trim()) : "";
  const sourceParagraphs = args.sourceParagraphs?.map(paragraph => paragraph.trim()).filter(Boolean) ?? [];
  const markedSourceParagraphs = sourceParagraphs.length
    ? sourceParagraphs.map((paragraph, index) => mark(`__SAFE_POLISH_SOURCE_P_${index + 1}__`, `resume_source_paragraph_${index + 1}`, paragraph))
    : undefined;
  const { system, user } = buildPolishPrompt({
    text: markedText,
    sourceParagraphs: markedSourceParagraphs,
    moduleType: args.moduleType,
    mode: args.mode,
    context: markedContext,
    targetRole: markedTargetRole,
  });
  return { system, messages: [{ role: "user", parts: splitPromptMarkers(user, markers) }] };
}

/** 只统一真实换行；JSON 已解析，不再解释技术正文中的反斜杠或标签字面量。 */
export function normalizeNewlines(text: string): string {
  if (!text) return "";
  return text.replace(/\r\n?/g, "\n");
}

function cleanStr(val: unknown): string {
  if (typeof val !== "string") return "";
  return normalizeNewlines(val).trim();
}

const DATE_HEADER = /^\d{4}[.\-/年]\d{1,2}月?\s*(?:[-—–~～至到]\s*)?(?:至今|\d{4}[.\-/年]\d{1,2}月?)$/;

/** 判断一行是否为不应出现在正文描述中的标题/抬头行 */
export function isHeaderLine(
  line: string,
  context?: PolishContext,
  textFormat: "plain-text" | "rich-text" = "rich-text",
): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // 纯文本内容（剥除 HTML 标签后，避免闭合标签 </...> 中的斜杠被误判为分隔符）
  const textWithoutHtml = textFormat === "rich-text" ? trimmed.replace(/<[^>]+>/g, "").trim() : trimmed;
  if (!textWithoutHtml) return false;

  // 格式只用于核对正文是否为已知抬头，不能单独成为删除整行的依据。
  // 只识别带空白的 Markdown 标题标记，保留 C#、#include 等正文中的井号。
  const wrappers = /^[*`\s【】[\]()（）]+|[*`\s【】[\]()（）]+$/g;
  const cleanLine = textWithoutHtml
    .replace(wrappers, "")
    .replace(/^#{1,6}\s+(.+?)(?:\s+#+)?$/, "$1")
    .replace(wrappers, "")
    .trim();

  // 1. 模块分类标签，如 【工作经历】、【项目经历】、【自我评价】
  if (
    /^(?:【|\[)?(?:工作经历|项目经历|自我评价|个人总结|经历概述|工作内容|项目成果|工作职责)(?:】|\])?[:：]?$/i.test(
      cleanLine
    )
  ) {
    return true;
  }

  // 2. 标签本身不是抬头证据；每个字段值都须与对应身份完全一致，或是纯日期跨度。
  // 如“角色：仅参与验证，未负责架构”是事实正文，不能在读取、生成或保存时丢弃。
  const fields = [...cleanLine.matchAll(/(所属公司(?:[/／]组织)?|公司名称|公司|职位名称|职位头衔|职位|岗位|项目名称|项目|担任角色|角色|起止时间|时间)\s*[:：]\s*/g)];
  if (fields[0]?.index === 0) {
    const trimSeparators = (value: string) => value.replace(/^[\s|｜·•/／\-—–【】()[\]（）,，:：*`]+|[\s|｜·•/／\-—–【】()[\]（）,，:：*`]+$/g, "");
    const identityText = (value: string) => trimSeparators(value).toLowerCase().replace(/\s+/g, "");
    return fields.every((field, index) => {
      const label = field[1]!;
      const value = trimSeparators(cleanLine.slice(field.index + field[0].length, fields[index + 1]?.index));
      if (label === "起止时间" || label === "时间") return DATE_HEADER.test(value);
      const key = label.includes("公司") ? "company" : label.startsWith("项目") ? "name"
        : label.endsWith("角色") ? "role" : "title";
      const expected = context?.[key];
      return typeof expected === "string" && identityText(expected).length > 0 && identityText(value) === identityText(expected);
    });
  }

  // 3. 只清理完全由已知身份和分隔符组成的抬头；提到身份的正文仍保留。
  if (context) {
    const tokens = Array.from(new Set([context.company, context.title, context.name, context.role]
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      .map((t) => t.toLowerCase().replace(/\s+/g, ""))))
      .sort((a, b) => b.length - a.length);
    let remainder = cleanLine.toLowerCase().replace(/\s+/g, "");
    let matched = false;
    for (const token of tokens) {
      if (!remainder.includes(token)) continue;
      matched = true;
      remainder = remainder.split(token).join("");
    }
    if (matched && !remainder.replace(/[|｜·•/／\-—–【】()[\]（）,:：*`]/g, "")) return true;
  }

  // 4. 纯日期跨度抬头；日期后带职责或进度说明的行属于正文。
  if (DATE_HEADER.test(cleanLine)) {
    return true;
  }

  return false;
}

/** 剥离 draft 开头误生成的公司、职位、项目名等抬头标题行 */
export function stripDraftHeaders(
  draft: string,
  context?: PolishContext,
  textFormat: "plain-text" | "rich-text" = "rich-text",
): string {
  // 旧富文本仍识别 br；新模型结果的标签只是正文，不当作排版。
  const normalized = normalizeNewlines(textFormat === "rich-text" ? draft.replace(/<br\s*\/?>/gi, "\n") : draft);
  const lines = normalized.split(/\r?\n/);
  if (lines.length <= 1) return normalized;

  let startIndex = 0;
  while (startIndex < lines.length) {
    const rawLine = lines[startIndex]!;
    const line = rawLine.trim();

    // 跳过开头的空白行
    if (!line) {
      startIndex++;
      continue;
    }

    const textWithoutHtml = textFormat === "rich-text" ? line.replace(/<[^>]+>/g, "").trim() : line;

    // 若已经以列表符号（•, -, *, 或 1-2 位数字序号 1., 2. 等）开头，视为正文内容，停止剔除
    if (/^[•·・●\-\*]\s*|^\d{1,2}[\.、\)]\s*/.test(textWithoutHtml)) {
      break;
    }

    if (isHeaderLine(line, context, textFormat)) {
      startIndex++;
    } else {
      break;
    }
  }

  const remaining = lines.slice(startIndex).join("\n").trim();
  return remaining || normalized;
}

export function splitDraftToItems(draft: string): string[] {
  if (!draft) return [];
  const normalized = normalizeNewlines(draft);
  return normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map(stripLeadingListMarker)
    .filter(Boolean);
}

function normalizeSourceIndices(raw: unknown, sourceCount?: number): number[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((n): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n > 0 &&
    (sourceCount === undefined || n <= sourceCount)
  ))].sort((a, b) => a - b);
}

/** 返回零基来源位置；仅旧版缺失映射且只有一个来源时可确定关联。 */
export function resolvePolishSourceIndices(item: PolishDraftItem | undefined, sourceCount: number): number[] {
  if (item?.sourceIndices === undefined) return sourceCount === 1 ? [0] : [];
  return normalizeSourceIndices(item.sourceIndices, sourceCount).map((index) => index - 1);
}

export function normalizePolishResult(
  raw: unknown,
  context?: PolishContext,
  options?: { sourceCount: number },
): PolishResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  let draft = cleanStr(o.draft);
  if (!draft) return null;

  // 剔除首行可能存在的公司/岗位等冗余抬头
  draft = stripDraftHeaders(draft, context, "plain-text");
  if (!draft) return null;

  let star: StarBreakdown | null = null;
  if (o.star && typeof o.star === "object") {
    const s = o.star as Record<string, unknown>;
    star = {
      situation: cleanStr(s.situation),
      task: cleanStr(s.task),
      action: cleanStr(s.action),
      result: cleanStr(s.result),
    };
  }

  const quantifiedTips: QuantifiedTip[] = [];
  if (Array.isArray(o.quantifiedTips)) {
    for (const item of o.quantifiedTips) {
      if (item && typeof item === "object") {
        const it = item as Record<string, unknown>;
        const dimension = cleanStr(it.dimension);
        const metric = cleanStr(it.metric);
        const tip = cleanStr(it.tip);
        const example = cleanStr(it.example);
        if (dimension || metric || tip) {
          quantifiedTips.push({ dimension, metric, tip, example });
        }
      }
    }
  }

  const draftItems: string[] = [];
  const draftItemDetails: PolishDraftItem[] = [];
  if (Array.isArray(o.draftItems)) {
    for (const item of o.draftItems) {
      if (typeof item === "string" && item.trim()) {
        const cleaned = stripLeadingListMarker(cleanStr(item));
        if (cleaned && !isHeaderLine(cleaned, context, "plain-text")) {
          draftItems.push(cleaned);
          draftItemDetails.push({ text: cleaned });
        }
      } else if (item && typeof item === "object") {
        const it = item as Record<string, unknown>;
        const rawText = typeof it.text === "string" ? it.text : typeof it.content === "string" ? it.content : "";
        const cleaned = stripLeadingListMarker(cleanStr(rawText));
        if (cleaned && !isHeaderLine(cleaned, context, "plain-text")) {
          draftItems.push(cleaned);
          const rawIndices = it.sourceIndices !== undefined ? it.sourceIndices : it.source_indices;
          draftItemDetails.push({
            text: cleaned,
            sourceIndices: rawIndices === undefined
              ? undefined
              : normalizeSourceIndices(rawIndices, options?.sourceCount),
          });
        }
      }
    }
  }
  // 有结构化条目时只保留这一份正文，避免整段与分条视图采用不同版本。
  if (draftItems.length > 0) draft = draftItems.map((text) => `• ${text}`).join("\n");
  const finalDraftItems = draftItems.length > 0 ? draftItems : splitDraftToItems(draft);
  const finalDraftItemDetails: PolishDraftItem[] =
    draftItemDetails.length === finalDraftItems.length
      ? draftItemDetails
      : finalDraftItems.map((text, idx) => ({
          text,
          sourceIndices: draftItemDetails[idx]?.sourceIndices,
        }));

  const highlights: string[] = [];
  if (Array.isArray(o.highlights)) {
    for (const h of o.highlights) {
      if (typeof h === "string" && h.trim()) {
        highlights.push(h.trim());
      }
    }
  }

  return {
    star,
    quantifiedTips,
    draft,
    draftItems: finalDraftItems,
    draftItemDetails: finalDraftItemDetails,
    highlights,
  };
}

/** 严格校验新生成润色结果；不通过兼容清洗丢弃部分条目。 */
export function validateGeneratedPolishResult(
  raw: unknown,
  context?: PolishContext,
  options?: { sourceCount: number; moduleType?: "work" | "projects" | "summary"; mode?: PolishMode },
): PolishResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const limits = POLISH_OUTPUT_LIMITS;
  const bounded = (value: unknown, max: number, required = false): value is string =>
    typeof value === "string" && value.trim().length <= max &&
    (required ? value.trim().length > 0 && hasQuestionContent(value) : !value.trim() || hasQuestionContent(value));
  const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
    Object.keys(value).every((key) => allowed.includes(key));
  if (!hasOnlyKeys(o, ["star", "quantifiedTips", "draft", "draftItems", "highlights"])) return null;
  if (!bounded(o.draft, limits.draft, true)) return null;
  // 与提示的自我评价口径一致；字段缺省继续兼容，已返回的模式外内容整份拒绝。
  const isSummary = options?.moduleType === "summary" || options?.mode === "summary";
  const noSource = options?.sourceCount === 0;
  if (isSummary && o.star !== undefined && o.star !== null) return null;

  if (o.star !== undefined && o.star !== null && (typeof o.star !== "object" || Array.isArray(o.star))) return null;
  if (o.star !== undefined && o.star !== null) {
    const star = o.star as Record<string, unknown>;
    if (!hasOnlyKeys(star, ["situation", "task", "action", "result"])) return null;
    for (const key of ["situation", "task", "action", "result"] as const) {
      const value = star[key];
      if (value !== undefined && (!bounded(value, limits.starField) || (noSource && value.trim().length > 0))) return null;
    }
  }

  const rawTips = o.quantifiedTips === undefined ? [] : o.quantifiedTips;
  if (!Array.isArray(rawTips) || rawTips.length > limits.maxQuantifiedTips) return null;
  if ((noSource || isSummary || options?.mode === "condense") && rawTips.length > 0) return null;
  for (const item of rawTips) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const tip = item as Record<string, unknown>;
    if (!hasOnlyKeys(tip, ["dimension", "metric", "tip", "example"])) return null;
    for (const [key, max] of [["dimension", limits.dimension], ["metric", limits.metric], ["tip", limits.tip], ["example", limits.example]] as const) {
      if (tip[key] !== undefined && !bounded(tip[key], max)) return null;
    }
  }

  if (!Array.isArray(o.draftItems) || o.draftItems.length === 0 || o.draftItems.length > limits.maxDraftItems) return null;
  // 背景名称不构成经历；没有原文时只保留一个框架，不生成多条经历或分析。
  if (noSource && o.draftItems.length !== 1) return null;
  for (const item of o.draftItems) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).length !== 2 || !Object.hasOwn(entry, "text") || !Object.hasOwn(entry, "sourceIndices") ||
        !bounded(entry.text, limits.draftItem, true)) return null;
    // 新生成条目是正文的权威来源。先拒绝已知抬头，防止全部清除后兼容清洗从 draft 回填。
    if (isHeaderLine(stripLeadingListMarker(cleanStr(entry.text)), context, "plain-text")) return null;
    const sourceIndices = entry.sourceIndices;
    const maxSourceIndices = Math.max(limits.maxDraftItems, options?.sourceCount ?? 0);
    if (!Array.isArray(sourceIndices) || sourceIndices.length > maxSourceIndices ||
        sourceIndices.some((index, position) => typeof index !== "number" || !Number.isSafeInteger(index) || index < 1 ||
          (options?.sourceCount !== undefined && index > options.sourceCount) ||
          (position > 0 && index <= (sourceIndices[position - 1] as number)))) return null;
  }

  const rawHighlights = o.highlights === undefined ? [] : o.highlights;
  if (!Array.isArray(rawHighlights) || rawHighlights.length > limits.maxHighlights ||
      !rawHighlights.every((item) => bounded(item, limits.highlight, true))) return null;
  if (options?.sourceCount === 0 && rawHighlights.length > 0) return null;

  const result = normalizePolishResult(raw, context, options);
  if (!result || !result.draftItems || result.draft.length > limits.draft || result.draftItems.length === 0 ||
      result.draftItems.length > limits.maxDraftItems || result.draftItems.some((item) => item.length > limits.draftItem) ||
      result.draftItems.length !== o.draftItems.length ||
      result.quantifiedTips.length !== rawTips.length || result.highlights.length !== rawHighlights.length) return null;
  return result;
}
