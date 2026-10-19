/**
 * 从多段文本中提取包含查询关键词的片段。
 * 支持去除 JSON 格式、控制字符等噪声，截取匹配词前后上下文，并用省略号连接。
 */

export type MatchedSnippet = {
  source?: string; // 来源标注，如 "简历模块"、"材料内容"、"追问回答" 等
  text: string;    // 提取出来的片段，带前后省略号（若被截断）
};

/**
 * 递归或者通过正则从字符串中清理常见 JSON 噪音（如果内容是 JSON），提取纯文本
 */
export function cleanSearchText(text: string): string {
  if (!text) return "";
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed);
      return extractStrings(parsed).join(" ");
    } catch {
      // 容错：直接正则剥除 key 和标点
      return trimmed.replace(/["{}\\[\]]/g, " ").replace(/\s+/g, " ");
    }
  }
  return trimmed.replace(/\s+/g, " ");
}

function extractStrings(val: unknown): string[] {
  if (typeof val === "string") return [val];
  if (Array.isArray(val)) return val.flatMap(extractStrings);
  if (val && typeof val === "object") {
    return Object.values(val as Record<string, unknown>).flatMap(extractStrings);
  }
  return [];
}

/**
 * 在目标文本中寻找包含 query 的所有出现位置（或上限 N 处），并截取前后上下文
 * @param text 文本
 * @param query 搜索词
 * @param maxSnippets 该文本最多提取几个片段，默认 3
 * @param contextBefore 关键词前保留字符数，默认 20
 * @param contextAfter 关键词后保留字符数，默认 40
 */
export function extractSnippetsFromText(
  text: string,
  query: string,
  options: {
    maxSnippets?: number;
    contextBefore?: number;
    contextAfter?: number;
    source?: string;
  } = {}
): MatchedSnippet[] {
  if (!text || !query) return [];
  const { maxSnippets = 3, contextBefore = 20, contextAfter = 40, source } = options;

  const cleaned = cleanSearchText(text);
  if (!cleaned) return [];

  const lowerText = cleaned.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const queryLen = query.length;

  const snippets: MatchedSnippet[] = [];
  let startIndex = 0;
  let lastEnd = -1;

  while (snippets.length < maxSnippets) {
    const foundIndex = lowerText.indexOf(lowerQuery, startIndex);
    if (foundIndex === -1) break;

    // 如果与上一个匹配点重叠较近，避免生成高度重复的片段
    const from = Math.max(0, foundIndex - contextBefore);
    const to = Math.min(cleaned.length, foundIndex + queryLen + contextAfter);

    startIndex = foundIndex + queryLen;

    if (from <= lastEnd && snippets.length > 0) {
      // 拓展前一个片段的结尾
      const last = snippets[snippets.length - 1]!;
      const extra = cleaned.slice(lastEnd, to);
      last.text = last.text.endsWith("…") ? last.text.slice(0, -1) + extra : last.text + extra;
      if (to < cleaned.length) {
        last.text += "…";
      }
      lastEnd = to;
      continue;
    }

    let snippetStr = cleaned.slice(from, to).trim();
    if (from > 0) snippetStr = "…" + snippetStr;
    if (to < cleaned.length) snippetStr = snippetStr + "…";

    snippets.push({
      source,
      text: snippetStr,
    });
    lastEnd = to;
  }

  return snippets;
}
