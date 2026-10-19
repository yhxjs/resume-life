import { describe, expect, it } from "vitest";
import { cleanSearchText, extractSnippetsFromText } from "../search-snippet";

describe("search-snippet", () => {
  it("cleanSearchText 可以从普通文本和 JSON 格式中提取纯文本", () => {
    expect(cleanSearchText("   hello    world  ")).toBe("hello world");
    expect(
      cleanSearchText(
        JSON.stringify({
          title: "前端工程师",
          projects: [{ name: "电商系统", desc: "采用 React 和 Next.js 重构" }],
        })
      )
    ).toContain("前端工程师 电商系统 采用 React 和 Next.js 重构");
  });

  it("extractSnippetsFromText 可以在单一文本中提取多个不重叠片段", () => {
    const text =
      "第一段内容包含React技术栈，在项目中深度使用。中间有很多其他描述文字用来拉开距离。第二段内容再次提到了React框架的性能调优与并发特性。";
    const snippets = extractSnippetsFromText(text, "React", {
      maxSnippets: 2,
      contextBefore: 10,
      contextAfter: 15,
      source: "简历模块",
    });

    expect(snippets).toHaveLength(2);
    expect(snippets[0]!.source).toBe("简历模块");
    expect(snippets[0]!.text).toContain("React");
    expect(snippets[1]!.text).toContain("React");
  });

  it("短距离重复关键词会合并并扩展片段，避免碎片化", () => {
    const text = "精通 React，熟悉 React Hooks 原理与实践";
    const snippets = extractSnippetsFromText(text, "React", {
      maxSnippets: 3,
      contextBefore: 10,
      contextAfter: 10,
    });
    expect(snippets.length).toBeLessThanOrEqual(2);
    expect(snippets[0]!.text).toContain("React");
  });
});
