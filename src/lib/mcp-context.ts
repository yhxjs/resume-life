import { McpOperationError } from "./mcp-errors";
import { mcpRevision } from "./mcp-revision";

export type ContextPageInput = { offset?: number; length?: number; expectedRevision?: string };

/** Full workflow inputs, including rules, are paged without losing text or surrogate pairs. */
export function mcpContextRevision(context: object) {
  return mcpRevision("content-context", context);
}

export function assertMcpContext(context: object, expected: string) {
  if (mcpContextRevision(context) !== expected) throw new McpOperationError("CONFLICT", "来源或规则已变化，请重新读取完整上下文");
}

export function mcpContextPage(context: object, input: ContextPageInput) {
  const revision = mcpContextRevision(context), text = JSON.stringify(context);
  const offset = input.offset ?? 0, length = input.length ?? 4000;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || !Number.isInteger(length) || length < 1 || length > 4000 ||
      (offset > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(offset)) && /[\uD800-\uDBFF]/.test(text.charAt(offset - 1)))) {
    throw new McpOperationError("INVALID_ARGUMENT", "分段参数无效，请使用返回的 nextOffset");
  }
  if ((offset > 0 && !input.expectedRevision) || (input.expectedRevision && input.expectedRevision !== revision)) {
    throw new McpOperationError("CONFLICT", "上下文已变化或缺少修订令牌，请从 offset=0 重新读取");
  }
  let end = Math.min(text.length, offset + length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(end))) end++;
  return { revision, encoding: "json/utf-16" as const, offset, text: text.slice(offset, end), totalLength: text.length, nextOffset: end < text.length ? end : null };
}
