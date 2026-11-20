import { validateDocumentTableProvenance, type DocumentTableProvenance } from "./document-table-provenance";

/** Quote each selected segment once; JSON strings keep source-like text inside its own segment. */
export function serializeEvidenceExcerpt(
  content: string,
  range: { startOffset: number; endOffset: number },
  provenance?: DocumentTableProvenance,
): string {
  const quote = content.slice(range.startOffset, range.endOffset).replace(/\r\n|\r/g, "\n");
  if (provenance === undefined) return `摘录来源：未保留表格来源信息，原生布局未知。\n原文摘录：\n${quote}`;
  const { markers } = validateDocumentTableProvenance(provenance, content);
  const offsetInQuote = (offset: number) => content.slice(range.startOffset, offset).replace(/\r\n|\r/g, "\n").length;
  const spans = markers.flatMap(marker => {
    const start = Math.max(range.startOffset, marker.start);
    const end = Math.min(range.endOffset, marker.end);
    if (start >= end) return [];
    const from = offsetInQuote(start), to = offsetInQuote(end);
    return from < to ? [{ from, to }] : [];
  });
  if (!spans.length) return `摘录来源：Word 提取文本，所选字符均为正文，无提取器生成的表格定位说明。\n原文摘录：\n${quote}`;
  const segments: string[] = [];
  let offset = 0;
  for (const { from, to } of spans) {
    if (offset < from) segments.push(`正文：${JSON.stringify(quote.slice(offset, from))}`);
    segments.push(`表格定位说明：${JSON.stringify(quote.slice(from, to))}`);
    offset = to;
  }
  if (offset < quote.length) segments.push(`正文：${JSON.stringify(quote.slice(offset))}`);
  return `摘录来源：Word 分段引用；仅保留所选片段，完整布局未知。\n原文摘录（依次拼接各段引文）：\n${segments.join("\n")}`;
}
