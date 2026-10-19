import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { HighlightText, escapeRegExp } from "../highlight-text";

describe("HighlightText", () => {
  it("escapeRegExp 正确转义特殊正则符号", () => {
    expect(escapeRegExp("C++ (高级) [100%]?")).toBe("C\\+\\+ \\(高级\\) \\[100%\\]\\?");
  });

  it("无关键词时直接渲染原文本", () => {
    const html = renderToStaticMarkup(<HighlightText text="测试普通文本" keyword="" />);
    expect(html).toBe("测试普通文本");
    expect(html).not.toContain("<mark");
  });

  it("能够高亮匹配的所有位置并保留大小写", () => {
    const html = renderToStaticMarkup(
      <HighlightText text="React是好用的，react很流行，REACT强大" keyword="react" />
    );
    expect(html).toContain("<mark");
    expect(html).toContain(">React</mark>");
    expect(html).toContain(">react</mark>");
    expect(html).toContain(">REACT</mark>");
  });
});
