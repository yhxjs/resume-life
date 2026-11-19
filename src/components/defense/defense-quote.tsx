import { RichText } from "@/components/resume/rich-text";

/** 保留已有富文本预览，同时提供未经展示解码的原始引用供逐字核对。 */
export function DefenseQuote({ text }: { text: string }) {
  return (
    <div className="space-y-2">
      <div className="whitespace-pre-wrap break-words">&ldquo;<RichText content={text} />&rdquo;</div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted">核对原始引用</summary>
        <pre aria-label="原始引用" className="mt-2 whitespace-pre-wrap break-words font-mono text-ink">{text}</pre>
      </details>
    </div>
  );
}
