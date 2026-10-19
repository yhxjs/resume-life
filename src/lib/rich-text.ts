export interface RichTextColor {
  id: string;
  label: string;
  color: string;
  dotClass: string;
}

/** 预设高亮色板：6 种针对简历黑白/浅色纸面优化的专业色及恢复默认色选项 */
export const PRESET_RICH_COLORS: RichTextColor[] = [
  { id: "default", label: "默认", color: "inherit", dotClass: "bg-ink border border-line" },
  { id: "blue", label: "商务蓝", color: "#1d4ed8", dotClass: "bg-[#1d4ed8]" },
  { id: "crimson", label: "重点红", color: "#b91c1c", dotClass: "bg-[#b91c1c]" },
  { id: "green", label: "松针绿", color: "#15803d", dotClass: "bg-[#15803d]" },
  { id: "amber", label: "琥珀金", color: "#b45309", dotClass: "bg-[#b45309]" },
  { id: "violet", label: "高贵紫", color: "#6d28d9", dotClass: "bg-[#6d28d9]" },
  { id: "gray", label: "低调灰", color: "#4b5563", dotClass: "bg-[#4b5563]" },
];

export type RichTextNode =
  | { type: "text"; text: string }
  | { type: "br" }
  | { type: "strong"; children: RichTextNode[] }
  | { type: "color"; color: string; children: RichTextNode[] };

/** 校验是否为合法安全的 CSS color 值（十六进制、rgb/rgba、hsl、语义名或 inherit） */
export function isValidCssColor(color: string): boolean {
  const trimmed = color.trim().toLowerCase();
  if (trimmed === "inherit" || trimmed === "currentcolor") return true;
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(trimmed)) return true;
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)$/.test(trimmed)) return true;
  if (/^hsla?\(\s*\d+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+\s*)?\)$/.test(trimmed)) return true;
  return false;
}

/** 从 style 属性中提取 color 值 */
function extractColorFromStyle(styleStr: string): string | null {
  const match = styleStr.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
  if (!match) return null;
  const rawColor = (match[1] ?? "").trim();
  return isValidCssColor(rawColor) ? rawColor : null;
}

/** 反解 HTML 实体，把已转义的文本还原为字符 */
const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  // U+00A0：保留原字符，避免清洗管线悄悄改动正文；
  // 只有 stripRichText（字数统计/纯文本展示）才把它折成普通空格。
  "&nbsp;": " ",
};

/** 单次遍历反解实体：`&amp;lt;` 解出 `&lt;`，不递归，所以不会二次解码 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITY_MAP[m] ?? m);
}

/** 文本节点统一在入向反解实体，使 sanitizeRichText 收敛为幂等 */
function decodeTextToken(text: string): string {
  return text.includes("&") ? decodeHtmlEntities(text) : text;
}

type TagToken =
  | { type: "open"; tag: "strong" | "span"; color?: string }
  | { type: "close"; tag: "strong" | "span" }
  | { type: "br"; placeholder?: boolean }
  | { type: "block"; tag: "div" | "p" | "li"; closing: boolean; empty?: boolean }
  | { type: "text"; text: string };

/** 限制输出 AST 深度，超深格式展平为正文，保护所有递归预览与导出路径。 */
const MAX_RICH_TEXT_DEPTH = 64;

/** 纯 Node/SSR 兼容的轻量安全 HTML Tokenizer，不依赖浏览器 DOMParser */
function tokenize(html: string): TagToken[] {
  const tokens: TagToken[] = [];
  const safeHtml = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");

  const tagRegex = /<\/?([a-zA-Z0-9]+)([^>]*)>|<br\s*\/?>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(safeHtml)) !== null) {
    if (match.index > lastIndex) {
      // 解码在标签扫描之后进行：此时标签集合已确定，实体解出的尖括号
      // 不可能再变成标签（出向的 nodesToHtml 会重新转义）。
      tokens.push({ type: "text", text: decodeTextToken(safeHtml.slice(lastIndex, match.index)) });
    }
    lastIndex = tagRegex.lastIndex;

    const fullMatch = match[0];
    if (/^<br\s*\/?>$/i.test(fullMatch)) {
      tokens.push({ type: "br" });
      continue;
    }

    const isClose = fullMatch.startsWith("</");
    const tagName = (match[1] || "").toLowerCase();
    const attrsStr = match[2] || "";

    if (tagName === "div" || tagName === "p" || tagName === "li") {
      tokens.push({ type: "block", tag: tagName, closing: isClose });
    } else if (tagName === "strong" || tagName === "b") {
      tokens.push(isClose ? { type: "close", tag: "strong" } : { type: "open", tag: "strong" });
    } else if (tagName === "span") {
      if (isClose) {
        tokens.push({ type: "close", tag: "span" });
      } else {
        const styleMatch = attrsStr.match(/style=(["'])(.*?)\1/i);
        const color = styleMatch ? extractColorFromStyle(styleMatch[2] ?? "") : null;
        if (color) {
          tokens.push({ type: "open", tag: "span", color });
        }
      }
    }
  }

  if (lastIndex < safeHtml.length) {
    tokens.push({ type: "text", text: decodeTextToken(safeHtml.slice(lastIndex)) });
  }

  return normalizeBlockTokens(tokens);
}

/** 浏览器的空段落单 br 是光标占位符；块边界延迟到下一行，避免首尾和显式 br 重复。 */
function normalizeBlockTokens(tokens: TagToken[]): TagToken[] {
  const blocks: { token: Extract<TagToken, { type: "block" }>; textCount: number; breakCount: number; childBlock: boolean }[] = [];
  const blockIndices: Record<"div" | "p" | "li", number[]> = { div: [], p: [], li: [] };
  let textCount = 0;
  let breakCount = 0;
  let lastBreak: Extract<TagToken, { type: "br" }> | undefined;
  for (const token of tokens) {
    if (token.type === "text" && token.text) textCount++;
    else if (token.type === "br") { breakCount++; lastBreak = token; }
    else if (token.type === "block") {
      if (!token.closing) {
        if (blocks.length) blocks[blocks.length - 1]!.childBlock = true;
        blockIndices[token.tag].push(blocks.length);
        blocks.push({ token, textCount, breakCount, childBlock: false });
      } else {
        const index = blockIndices[token.tag].at(-1);
        if (index !== undefined) {
          while (blocks.length > index) {
            const block = blocks.pop()!;
            blockIndices[block.token.tag].pop();
            if (!block.childBlock && block.textCount === textCount && breakCount - block.breakCount <= 1) {
              block.token.empty = true;
              if (breakCount > block.breakCount && lastBreak) lastBreak.placeholder = true;
            }
          }
        }
      }
    }
  }

  const normalized: TagToken[] = [];
  let hasLine = false;
  let trailingBreak = false;
  let blankLine = false;
  let boundaryPending = false;
  let emittedContent = false;
  const flushBoundary = () => {
    if (!boundaryPending) return;
    if (!trailingBreak || blankLine) {
      normalized.push({ type: "br" });
      trailingBreak = true;
      emittedContent = true;
    }
    boundaryPending = false;
    blankLine = false;
  };
  for (const token of tokens) {
    if (token.type === "block") {
      boundaryPending = hasLine;
      if (!token.closing && token.empty) {
        flushBoundary();
        hasLine = true;
        trailingBreak = true;
        blankLine = true;
      }
    } else if (token.type === "br") {
      if (token.placeholder) continue;
      boundaryPending = false;
      blankLine = false;
      hasLine = true;
      trailingBreak = true;
      emittedContent = true;
      normalized.push(token);
    } else {
      if (token.type === "text" || token.type === "open") flushBoundary();
      normalized.push(token);
      if (token.type === "text" && token.text) {
        hasLine = true;
        emittedContent = true;
        trailingBreak = token.text.endsWith("\n");
      }
    }
  }
  // 独立空编辑段仍需一个 br，以便重新进入编辑器时保留空行。
  if (blankLine && !emittedContent) normalized.push({ type: "br" });
  return normalized;
}

/** 将 HTML 解析为严密的 AST 节点树（自动修正嵌套和未闭合标签） */
export function parseRichTextToNodes(html: string): RichTextNode[] {
  if (!html) return [];
  const tokens = tokenize(html);
  const rootChildren: RichTextNode[] = [];

  interface Frame {
    tag: "strong" | "span";
    color?: string;
    children: RichTextNode[];
    flattened: boolean;
  }
  const stack: Frame[] = [];

  const currentChildren = () => (stack.length > 0 ? stack[stack.length - 1]!.children : rootChildren);

  const closeFrame = () => {
    const popped = stack.pop()!;
    if (popped.flattened) return;
    const parent = currentChildren();
    if (popped.tag === "strong") {
      parent.push({ type: "strong", children: popped.children });
    } else if (popped.tag === "span" && popped.color) {
      parent.push({ type: "color", color: popped.color, children: popped.children });
    } else {
      for (const child of popped.children) parent.push(child);
    }
  };

  for (const token of tokens) {
    if (token.type === "text") {
      if (token.text) {
        currentChildren().push({ type: "text", text: token.text });
      }
    } else if (token.type === "br") {
      currentChildren().push({ type: "br" });
    } else if (token.type === "open") {
      const flattened = stack.length >= MAX_RICH_TEXT_DEPTH;
      stack.push({
        tag: token.tag,
        color: token.color,
        // 超深帧共用正文容器，保留标签配对而不反复复制整段子节点。
        children: flattened ? currentChildren() : [],
        flattened,
      });
    } else if (token.type === "close") {
      const idx = stack.findLastIndex((f) => f.tag === token.tag);
      if (idx !== -1) {
        while (stack.length > idx) {
          closeFrame();
        }
      }
    }
  }

  while (stack.length > 0) {
    closeFrame();
  }

  return rootChildren;
}

function nodesToHtml(nodes: RichTextNode[]): string {
  let res = "";
  for (const n of nodes) {
    if (n.type === "text") {
      res += n.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    } else if (n.type === "br") {
      res += "<br>";
    } else if (n.type === "strong") {
      res += `<strong>${nodesToHtml(n.children)}</strong>`;
    } else if (n.type === "color") {
      res += `<span style="color: ${n.color}">${nodesToHtml(n.children)}</span>`;
    }
  }
  return res;
}

/** 清洗输入字符串，输出仅包含白名单标签的安全 HTML */
export function sanitizeRichText(html: string): string {
  if (!html) return "";
  const nodes = parseRichTextToNodes(html);
  return nodesToHtml(nodes);
}

/**
 * 剥离所有 HTML 标签，返回纯文本（用于简历字数统计与纯文本展示）。
 *
 * 实体解码复用 decodeHtmlEntities 的单轮实现，而不是自带一串链式 .replace：
 * 链式写法里前一步的产物会被后一步继续消费，`&amp;lt;` 会被解成 `<`（两轮），
 * 而同一个文件里的 decodeHtmlEntities 明确约定只解一轮。两者不一致的后果是
 * 用户输入含 `&amp;` 这类字面文本时，字数会算少、送给模型的正文也与所见不符。
 */
export function stripRichText(html: string): string {
  if (!html) return "";
  const toText = (nodes: RichTextNode[]): string => nodes.map((node) => {
    if (node.type === "text") return node.text;
    if (node.type === "br") return "\n";
    return toText(node.children);
  }).join("");
  return toText(parseRichTextToNodes(html)).replace(/ /g, " ");
}

/** 将富文本节点树转换为 Markdown 纯净文本 */
function nodesToMarkdown(nodes: RichTextNode[]): string {
  let res = "";
  for (const n of nodes) {
    if (n.type === "text") {
      res += n.text;
    } else if (n.type === "br") {
      res += "\n";
    } else if (n.type === "strong") {
      res += `**${nodesToMarkdown(n.children)}**`;
    } else if (n.type === "color") {
      res += nodesToMarkdown(n.children);
    }
  }
  return res;
}

/** 将富文本 HTML 转换为 Markdown 字符串 */
export function richTextToMarkdown(html: string): string {
  if (!html) return "";
  const nodes = parseRichTextToNodes(html);
  return nodesToMarkdown(nodes);
}

/** 增强版多行项目描述拆分：支持换行、富文本标签保护与行自闭合 */
export function splitRichTextToLines(text: string): string[] {
  if (!text) return [];
  const normalized = text
    .replaceAll("\\r\\n", "\n")
    .replaceAll("\\n", "\n");
  const splitNodes = (nodes: RichTextNode[]): RichTextNode[][] => {
    const lines: RichTextNode[][] = [[]];
    for (const node of nodes) {
      if (node.type === "br") {
        lines.push([]);
        continue;
      }
      const parts: RichTextNode[][] = node.type === "text"
        ? node.text.split(/\r\n?|\n/).map((part) => part ? [{ type: "text", text: part }] : [])
        : splitNodes(node.children).map((children) => children.length ? [{ ...node, children }] : []);
      for (const [index, part] of parts.entries()) {
        if (index) lines.push([]);
        lines[lines.length - 1]!.push(...part);
      }
    }
    return lines;
  };

  return splitNodes(parseRichTextToNodes(normalized))
    .map((line) => nodesToHtml(line))
    .map((line) => line.trim())
    // 剔除可能存在的前导列表符号（例如 •, ·, -, *, 1. 等，同时允许其前后有少量标签包裹）
    .map((line) => line.replace(/^((?:<[^>]+>)*)(?:[•·・●\-\*]|\d+[\.、])\s*/i, "$1").trim())
    .filter(Boolean)
    .map((line) => sanitizeRichText(line));
}

/** 判断字符串里是否已有 HTML 实体（即已是转义过的 HTML，不该再转义一次） */
export function hasHtmlEntity(text: string): boolean {
  return /&(?:amp|lt|gt|quot|#39|nbsp);/.test(text);
}

/** 将原始文本（如历史纯文本数据）格式化为富文本编辑器所需的 HTML，保留换行 */
export function plainTextToRichHtml(val: string): string {
  if (!val) return "";
  // 已有标签先清洗；已转义的纯文本保持原样，避免编辑器回填时叠加实体。
  if (/<[a-z][\s\S]*>/i.test(val)) return sanitizeRichText(val);
  if (hasHtmlEntity(val)) return val.replace(/\r\n?|\n/g, "<br>");
  return val
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n?|\n/g, "<br>");
}
