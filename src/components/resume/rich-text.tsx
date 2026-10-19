import React, { type CSSProperties } from "react";
import { decodeHtmlEntities, parseRichTextToNodes, type RichTextNode } from "@/lib/rich-text";

function renderNode(node: RichTextNode, index: number): React.ReactNode {
  if (node.type === "text") {
    return node.text;
  }
  if (node.type === "br") {
    return <br key={index} />;
  }
  if (node.type === "strong") {
    return (
      <strong key={index} style={{ fontWeight: 600 }}>
        {node.children.map((child, i) => renderNode(child, i))}
      </strong>
    );
  }
  if (node.type === "color") {
    return (
      <span key={index} style={{ color: node.color }}>
        {node.children.map((child, i) => renderNode(child, i))}
      </span>
    );
  }
  return null;
}

export interface RichTextProps {
  content?: string | null;
  className?: string;
  style?: CSSProperties;
  as?: "span" | "div" | "p";
}

/**
 * 纯 React 节点渲染的安全富文本组件：
 * 不调用 dangerouslySetInnerHTML，通过 AST 递归生成 Virtual DOM，
 * 文本节点自动享有 React 转义保护，杜绝 XSS。
 */
export function RichText({
  content,
  className,
  style,
  as: Component = "span",
}: RichTextProps) {
  if (!content) return null;
  const decodedContent = content.includes("&lt;") && content.includes("&gt;")
    ? decodeHtmlEntities(content)
    : content;
  const nodes = parseRichTextToNodes(decodedContent);

  return (
    <Component className={className} style={style}>
      {nodes.map((node, i) => renderNode(node, i))}
    </Component>
  );
}
