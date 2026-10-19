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

const SYSTEM_PROMPT = `你是顶级大厂资深技术面试官兼职业规划专家，深谙求职简历的“STAR原则”、“经历量化方法论”与“自我评价真实场景撰写逻辑”。
请对求职者提交的经历描述或自我评价进行专业智能润色、提炼或精简，输出标准 JSON 格式。

【核心原则与规范（极其重要）】：
一、工作经历 / 项目经历类（STAR 原则与量化）：
1. 真实度第一：严禁凭空捏造具体的虚构数值（如虚假的99.9%或者具体的几千万营收），避免候选人在面试深挖时翻车。
2. 占位符规范：在需要量化数据支撑的地方，统一输出规范的中文方括号占位符供候选人填写真实数字，格式必须形如：
   "[请填入真实数据，例如：提升30%]"
   "[请填入真实规模，例如：支撑日活10万+]"
   "[请填入真实优化效果，例如：首屏耗时从2.5s降至0.8s]"
3. 动词开头与专业术语：使用强动词（如：主导、重构、设计、推行、攻坚），清晰体现方案选型理由与技术深度。
4. 严禁输出抬头标题：上下文中的公司、职位、项目名仅用于辅助理解行业背景与技术深度，系统在简历中已有独立的标题输入框与展示位置。严禁在 draft 或 draftItems 中输出任何公司名称、职位名称、项目名称、时间周期等抬头行或标题行（如“某某公司 | 某某职位”），draft 必须且仅包含具体的工作/项目成果 Bullet Points（带 • 前缀）。
5. 智能精简合并与动态合理条目数（按技术维度自适应，不设死板上限）：
   - 聚合同类项：严禁将原始碎片机械地 1:1 罗列扩写。必须识别技术与业务相关联的动作，将其融合成因果完整、亮点突出的精炼成果；
   - 剔除琐碎流水账：自动舍弃无技术区分度或无业务价值的常规任务（如日常开会沟通、简单文档编写、零散缺陷修复等）；
   - 按架构深度与复杂度动态决定条目数：绝不机械地限制固定条目数量。简单功能自然输出 1-2 条，普通模块归纳为 2-3 条；若经历本身涵盖多个完全独立的技术架构攻坚维度（例如：微服务拆分与接入骨架、复杂业务流程编排引擎、高并发限流熔断治理、分布式最终一致性与幂等对账、两级缓存与性能调优、海量数据分库分表与安全合规、AI 辅助工程化等），必须完整保留各维度的独立条目（可达 4-6 条甚至更多），严禁为了死板压缩条目而将彼此独立的重大技术亮点生硬杂糅或删减。
6. 来源段落溯源与多段融合：
   - 当待润色内容按 [来源段落 1]、[来源段落 2]... 划分时，请在 draftItems 中标明每条润色结果对应融合自哪些来源段落（sourceIndices 为 1-based 数字数组，如 [1] 或多段融合的 [1, 2]）；
   - 若原始待润色内容未分段，则 sourceIndices 默认标为 [1]；
   - draftItems 支持输出对象数组（推荐带溯源：[{"text": "...", "sourceIndices": [1, 2]}...]）或纯字符串数组。

二、自我评价类（高辨识度专业画像，无需具体数值）：
1. 真实招聘场景定位：自我评价是求职者的个人全局 Profile 与核心竞争力综述，HR 和技术面试官关注的是技术广度深度、工程认知、解决复杂问题能力与自驱素养，具体数值指标属于经历模块中的论据。自我评价无需任何具体数值，严禁输出 "[请填入真实数据...]" 这类量化占位符，避免虚浮与重复。
2. 拒绝假大空套话：严禁出现“工作认真负责、吃苦耐劳、有良好团队协作精神、热爱编程”等低信息量的陈词滥调，必须以扎实的技术栈体系、工程实践与专业素养为支撑。
3. 结构化多维呈现（提炼 3-4 条重点）：
   - 核心技术与架构视野：主攻技术栈深度与技术广度、底层原理理解或系统设计认知；
   - 工程实践与攻坚沉淀：复杂场景排障攻坚、系统性能/稳定性治理、工程规范化推行；
   - 业务理解与协作自驱：技术赋能业务意识、跨团队沟通协同、持续学习自驱力与技术敏锐度。
4. 输出规范：star 字段固定为 null，quantifiedTips 固定为 []，draft 与 draftItems 输出 3-4 条成熟干练、有说服力的专业总结。

三、推理与篇幅控制（极其重要）：
- 极简快速思考：严禁展开漫长推理，在最少思考步骤内直接完整输出合法的 JSON 格式；
- 篇幅高度凝练：严格控制输出总长度，言简意赅，必须在输出限额内完整结束并正常闭合 JSON。

【输出 JSON 格式要求】：
{
  "star": {
    "situation": "背景与业务/技术痛点（经历类填，自我评价填 null）",
    "task": "面临的核心目标与挑战任务（经历类填，自我评价填 null）",
    "action": "采取的关键技术方案或架构设计（经历类填，自我评价填 null）",
    "result": "取得的系统收益与业务结果（经历类结合量化占位符，自我评价填 null）"
  },
  "quantifiedTips": [
    {
      "dimension": "量化维度（经历类填写，自我评价模式可为空数组 []）",
      "metric": "推荐关注的指标（如：P99延迟 / 崩溃率 / 交付周期）",
      "tip": "启发式建议：简要指导候选人如何计算或回忆此数据（1-2句话）",
      "example": "占位符范例，如 [请填入真实构建耗时降低百分比，例如：优化40%]"
    }
  ],
  "draft": "最终可直接写入简历的完整排版文本。经历类请根据技术维度复杂度使用动词开头的精炼 Bullet Points（带 • 前缀，自适应条目数，每个独立架构/业务攻坚维度一条，严禁生硬合并无关维度），保留量化占位符，严禁输出抬头标题行；自我评价请使用 3-4 条重点突出的专业陈述（带 • 前缀），强调核心优势与工程素养，无需具体数值与占位符。",
  "draftItems": [
    "拆解为多项独立条目（每条不带前缀符号/序号，严禁输出公司或岗位名称）。经历类保留量化占位符；自我评价为 3-4 条纯文本专业优势点"
  ],
  "highlights": ["提炼出的核心技能或业务亮点关键词，如：前端架构设计、高并发调优、工程化落地"]
}

注意：
- 若为自我评价模式（summary），star 设为 null，quantifiedTips 设为 []，无需任何具体数值与量化占位符；
- 只输出合法 JSON，不要包含任何额外的 markdown 解释文字。`;

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

  const modeInstructions = isSummary
    ? "【润色重点】：结合真实招聘场景，打造高辨识度、干练专业的个人全局画像（Profile）。重点提炼技术栈沉淀、架构与工程思维、复杂问题攻坚能力与自驱协作特质。自我评价无需任何具体数值与量化占位符，严禁假大空套话，语言专业成熟。"
    : mode === "star"
      ? "【润色重点】：严格运用 STAR 法则重构经历。强化问题背景（S）、明确目标（T）、精炼阐述关键技术行动与架构权衡（A）、量化突出成果（R），主动将散落步骤精简合并为结构完整的条目。"
      : mode === "quantify"
        ? "【润色重点】：深度量化提纯与扩写。挖掘最契合的核心度量维度（如性能、稳定性、研发效能或业务增效），给出精练的量化建议与带规范占位符的高质量草稿，自动去重并整合紧密相关的度量点。"
        : "【润色重点】：智能精简合并与深度提纯。聚合同类技术行动与业务链路，剔除日常流水账事务，根据经历实际复杂度浓缩提纯为最恰当数量的高含金量条目，每个独立技术/架构维度完整保留，保留关键方案与量化占位符。";

  const rawSource = (sourceParagraphs && sourceParagraphs.length > 1)
    ? sourceParagraphs
        .map((p, idx) => `[来源段落 ${idx + 1}]：\n${p.trim()}`)
        .join("\n\n")
    : text.trim();

  const user = isSummary
    ? `【模块类型】：自我评价
${ctxParts.length ? `【上下文信息（仅作为背景参考，简历中已有专门输入框，严禁在 draft 中输出抬头标题行）】：\n${ctxParts.join("\n")}\n` : ""}
${modeInstructions}

【原始待润色内容】：
${rawSource || "（暂无详细内容，请结合目标岗位给出成熟、高辨识度的自我评价范式，涵盖核心技术栈、工程实践沉淀与业务协作维度，严禁具体数值）"}

请输出润色分析 JSON。注意：draft 输出 3-4 条重点突出的专业陈述（带 • 前缀，无需任何具体数值与量化占位符，切勿包含公司、职位等抬头标题行）。在 draftItems 中输出各独立条目并标注对应的来源段落索引 sourceIndices（如 [1]）。star 设为 null，quantifiedTips 设为 []。务必控制输出篇幅高度凝练，确保在 token 预算内完整输出并闭合 JSON。`
    : `【模块类型】：${moduleType === "work" ? "工作经历" : "项目经历"}
${ctxParts.length ? `【上下文信息（仅作为技术与业务背景参考，简历中已有专门输入框，严禁在 draft 中输出公司/职位/项目标题抬头行）】：\n${ctxParts.join("\n")}\n` : ""}
${modeInstructions}

【原始待润色内容】：
${rawSource || "（暂无详细内容，请根据上下文名称与目标岗位，给出一条经典的经历框架范式并包含量化占位符）"}

请输出润色分析 JSON。注意：draft 仅输出工作成果 Bullet Points（带 • 前缀），切勿包含公司、职位、项目名等抬头标题行。在 draftItems 中输出各条目并标明对应的来源段落索引 sourceIndices（如 [1] 或多段融合的 [1, 2]）。务必控制输出篇幅高度凝练，确保在 token 预算内完整输出并闭合 JSON。`;

  return { system: SYSTEM_PROMPT, user };
}

/**
 * 将文本中混入的字面量反斜杠换行符（如 "\\n"、"\\r\\n"）或 <br> 标签规范化为真实换行符。
 * 大模型在输出 JSON 字符串时，常常会将换行符二次转义为字面量 "\\n"，
 * 导致解析后未能被换行渲染，表现为挤在单行中显示 "\\n• "。
 */
export function normalizeNewlines(text: string): string {
  if (!text) return "";
  return text
    .replaceAll("\\r\\n", "\n")
    .replaceAll("\\n", "\n")
    .replace(/<br\s*\/?>/gi, "\n");
}

function cleanStr(val: unknown): string {
  if (typeof val !== "string") return "";
  return normalizeNewlines(val).trim();
}

/** 判断一行是否为不应出现在正文描述中的标题/抬头行 */
export function isHeaderLine(line: string, context?: PolishContext): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // 纯文本内容（剥除 HTML 标签后，避免闭合标签 </...> 中的斜杠被误判为分隔符）
  const textWithoutHtml = trimmed.replace(/<[^>]+>/g, "").trim();
  if (!textWithoutHtml) return false;

  const cleanLine = textWithoutHtml.replace(/^[#*`\s【】[\]()（）]+|[#*`\s【】[\]()（）]+$/g, "").trim();

  const hasActionVerb = /^(?:主导|负责|承担|设计|重构|实现|研发|推进|推行|优化|构建|解决|深度参与|参与|组织|统筹|主推|牵头)/.test(cleanLine);

  // 1. Markdown 标题语法，如 "# ...", "## ...", "### ..."
  if (/^#{1,4}\s+/.test(trimmed)) return true;

  // 2. 模块分类标签，如 【工作经历】、【项目经历】、【自我评价】
  if (
    /^(?:【|\[)?(?:工作经历|项目经历|自我评价|个人总结|经历概述|工作内容|项目成果|工作职责)(?:】|\])?[:：]?$/i.test(
      cleanLine
    )
  ) {
    return true;
  }

  // 3. 显式字段标签，如 "公司：xxx", "职位：xxx", "项目：xxx", "角色：xxx"
  if (
    /^(?:所属公司(?:[/／]组织)?|公司名称|公司|职位名称|职位头衔|职位|岗位|项目名称|项目|担任角色|角色|起止时间|时间)[:：]/.test(
      cleanLine
    )
  ) {
    return true;
  }

  // 4. 匹配上下文中的公司名/岗位/项目名/角色（非动词开头的陈述句，忽略空格差异）
  if (context) {
    const tokens = [context.company, context.title, context.name, context.role]
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      .map((t) => t.trim().toLowerCase());

    const lower = textWithoutHtml.toLowerCase();
    const compactLower = lower.replace(/\s+/g, "");
    const matchedTokens = tokens.filter((token) => {
      const compactToken = token.replace(/\s+/g, "");
      return lower.includes(token) || (compactToken.length > 0 && compactLower.includes(compactToken));
    });
    if (matchedTokens.length >= 2) return true;
    if (matchedTokens.length === 1 && !hasActionVerb && !/[，。！？!?;；]/.test(textWithoutHtml)) {
      if (/[|｜·•/／\-]/.test(textWithoutHtml) || cleanLine.length <= 30) {
        return true;
      }
    }
  }

  // 5. 带有分隔符的典型履历短抬头（如 "公司名 | 岗位名"），且非完整描述句子（只在纯文本下判定分隔符）
  const hasSeparators = /[|｜/]/.test(textWithoutHtml);
  const isShortTitle = textWithoutHtml.length <= 50;
  const hasNoPlaceholder = !textWithoutHtml.includes("[请填入");
  const hasNoSentenceEnd = !/[。！？!?;；]$/.test(textWithoutHtml);

  if (hasSeparators && isShortTitle && hasNoPlaceholder && hasNoSentenceEnd && !hasActionVerb) {
    return true;
  }

  // 6. 日期跨度抬头，如 "2020.09 - 2024.06"
  if (/^\d{4}[.\-/年]\d{1,2}.*?(?:至今|\d{4}[.\-/年]\d{1,2})/i.test(textWithoutHtml) && textWithoutHtml.length <= 40) {
    return true;
  }

  return false;
}

/** 剥离 draft 开头误生成的公司、职位、项目名等抬头标题行 */
export function stripDraftHeaders(draft: string, context?: PolishContext): string {
  // 先统一规范化换行，避免字面量 \n 导致整段文本被当作单行处理
  const normalized = normalizeNewlines(draft);
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

    const textWithoutHtml = line.replace(/<[^>]+>/g, "").trim();

    // 若已经以列表符号（•, -, *, 或 1-2 位数字序号 1., 2. 等）开头，视为正文内容，停止剔除
    if (/^[•·・●\-\*]\s*|^\d{1,2}[\.、\)]\s*/.test(textWithoutHtml)) {
      break;
    }

    if (isHeaderLine(line, context)) {
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
    // 剔除可能存在的前导列表符号（例如 •, ·, -, *, 1. 等，同时允许其前后有少量标签包裹）
    .map((line) => line.replace(/^((?:<[^>]+>)*)(?:[•·・●\-\*]|\d{1,2}[\.、\)])\s*/i, "$1").trim())
    .filter(Boolean);
}

export function normalizePolishResult(raw: unknown, context?: PolishContext): PolishResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  let draft = cleanStr(o.draft);
  if (!draft) return null;

  // 剔除首行可能存在的公司/岗位等冗余抬头
  draft = stripDraftHeaders(draft, context);
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
        const cleaned = item.trim().replace(/^((?:<[^>]+>)*)(?:[•·・●\-\*]|\d+[\.、])\s*/i, "$1").trim();
        if (cleaned && !isHeaderLine(cleaned, context)) {
          draftItems.push(cleaned);
          draftItemDetails.push({ text: cleaned });
        }
      } else if (item && typeof item === "object") {
        const it = item as Record<string, unknown>;
        const rawText = typeof it.text === "string" ? it.text : typeof it.content === "string" ? it.content : "";
        const cleaned = rawText.trim().replace(/^((?:<[^>]+>)*)(?:[•·・●\-\*]|\d+[\.、])\s*/i, "$1").trim();
        if (cleaned && !isHeaderLine(cleaned, context)) {
          draftItems.push(cleaned);
          const rawIndices = Array.isArray(it.sourceIndices)
            ? it.sourceIndices
            : Array.isArray(it.source_indices)
              ? it.source_indices
              : [];
          const sourceIndices = rawIndices
            .map((n) => Number(n))
            .filter((n) => Number.isInteger(n) && n > 0);
          draftItemDetails.push({
            text: cleaned,
            sourceIndices: sourceIndices.length > 0 ? sourceIndices : undefined,
          });
        }
      }
    }
  }
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
