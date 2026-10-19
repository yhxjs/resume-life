import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "@/components/resume/rich-text";
import { replaceSensitiveRichText } from "../resume-anonymize";
import {
  parseRichTextToNodes,
  sanitizeRichText,
  stripRichText,
  richTextToMarkdown,
  splitRichTextToLines,
  plainTextToRichHtml,
  isValidCssColor,
  decodeHtmlEntities,
  hasHtmlEntity,
} from "../rich-text";
import { segmentsToHtml } from "../metric-highlight";

describe("浏览器富文本段落边界", () => {
  it.each([
    ["first<div>second</div>", "first<br>second"],
    ["<div>first</div>second", "first<br>second"],
    ["<div>first</div><div>second</div>", "first<br>second"],
    ["<p>first</p><p>second</p>", "first<br>second"],
    ["<ul><li>first</li><li>second</li></ul>", "first<br>second"],
    ["<div>first<div>second</div>third</div>", "first<br>second<br>third"],
    ["<div><div>first</div></div><div>second</div>", "first<br>second"],
    ["first<div><br></div><div>third</div>", "first<br><br>third"],
    ["<div><br></div><div>second</div>", "<br>second"],
    ["first<div><br></div>", "first<br>"],
    ["<div></div><div>second</div>", "<br>second"],
    ["<div><div><br></div></div><div>second</div>", "<br>second"],
    ["first<br><div>second</div>", "first<br>second"],
    ["<div>first<br></div><div>second</div>", "first<br>second"],
    ["<div>first</div><div><br>second</div>", "first<br>second"],
    ["<div>first<br><br></div><div>second</div>", "first<br><br>second"],
    ["first<div><br></div><div><br></div><div>fourth</div>", "first<br><br><br>fourth"],
  ])("清洗和导出保留 %s 的行边界", (input, expected) => {
    expect(sanitizeRichText(input)).toBe(expected);
    expect(sanitizeRichText(expected)).toBe(expected);
    expect(plainTextToRichHtml(input)).toBe(expected);
    expect(richTextToMarkdown(input)).toBe(expected.replaceAll("<br>", "\n"));
    expect(stripRichText(input)).toBe(expected.replaceAll("<br>", "\n"));
    expect(splitRichTextToLines(input)).toEqual(expected.split("<br>").filter(Boolean));
  });

  it("安全预览与DOCX共用的节点保留段落和合法行内格式", () => {
    const input = 'first<div onclick="alert(1)"><strong>second</strong><script>alert(2)</script></div><p><span style="color: #1d4ed8">third</span></p>';
    const expected = 'first<br><strong>second</strong><br><span style="color: #1d4ed8">third</span>';
    expect(sanitizeRichText(input)).toBe(expected);
    expect(parseRichTextToNodes(input)).toEqual(parseRichTextToNodes(expected));
    expect(richTextToMarkdown(input)).toBe("first\n**second**\nthird");
    const rendered = renderToStaticMarkup(createElement(RichText, { content: input }));
    expect(stripRichText(rendered)).toBe("first\nsecond\nthird");
    expect(rendered.match(/<br\/>/g)).toHaveLength(2);
  });

  it("空段落中的行内格式不吞掉前导空行", () => {
    expect(stripRichText('<div><strong><br></strong></div><div>second</div>')).toBe("\nsecond");
    expect(stripRichText('<div><span style="color: #1d4ed8"><br></span></div>')).toBe("\n");
  });

  it("行内格式包裹嵌套块时不重复插入段落分隔", () => {
    const input = "first<div><strong><div>second</div></strong></div>";
    expect(stripRichText(input)).toBe("first\nsecond");
    expect(richTextToMarkdown(input)).toBe("first\n**second**");
  });

  it("大量不匹配闭合块标签保留正文，交错关闭不留下过期索引", () => {
    const malformed = "<div>".repeat(20000) + "</p>".repeat(20000) + "text";
    expect(sanitizeRichText(malformed)).toBe("text");
    expect(stripRichText("<div><p>first</div><p>second</p></p>third")).toBe("first\nsecond\nthird");
  });

  it("真实DOCX回读保留浏览器段落、空行和加粗", async () => {
    const { resumeToDocx } = await import("../resume-docx");
    const { default: mammoth } = await import("mammoth");
    const buffer = await resumeToDocx("简历", [{
      key: "summary", type: "summary", label: "个人简介", sort: 0,
      content: { text: "first<div><br></div><div><strong>third</strong></div>" },
    }]);
    const { value } = await mammoth.convertToHtml({ buffer });
    expect(value).toContain("first<br /><br /><strong>third</strong>");
  });

  it("拆分嵌套段落时每行保留跨行的加粗和颜色", () => {
    const input = '<strong><span style="color: #1d4ed8">first<div>second</div></span></strong>';
    expect(splitRichTextToLines(input)).toEqual([
      '<strong><span style="color: #1d4ed8">first</span></strong>',
      '<strong><span style="color: #1d4ed8">second</span></strong>',
    ]);
  });
});

describe("rich-text utility", () => {
  it("超深富文本可以进行真实 React 渲染和敏感词替换", () => {
    const input = `<strong>${'<span style="color: #1d4ed8">'.repeat(10000)}张三<br>正文${"</span>".repeat(10000)}</strong>尾部`;
    const rendered = renderToStaticMarkup(createElement(RichText, { content: input }));
    expect(stripRichText(rendered)).toBe("张三\n正文尾部");
    const anonymized = replaceSensitiveRichText(input, [{ id: "name", source: "张三", replacement: "候选人" }]);
    expect(stripRichText(anonymized)).toBe("候选人\n正文尾部");
    expect(sanitizeRichText(anonymized)).toBe(anonymized);
  });

  it.each([
    ["strong", "<strong>", "</strong>"],
    ["color", '<span style="color: #1d4ed8">', "</span>"],
    ["mixed", '<strong><span style="color: #1d4ed8">', "</span></strong>"],
  ])("超深 %s 格式保留正文并限制 AST 深度", (_name, opening, closing) => {
    const input = `之前${opening.repeat(10000)}内容<br>后续${closing.repeat(10000)}之后`;
    const normalized = sanitizeRichText(input);
    expect(stripRichText(normalized)).toBe("之前内容\n后续之后");
    expect(sanitizeRichText(normalized)).toBe(normalized);
    expect(richTextToMarkdown(input).replaceAll("**", "")).toBe("之前内容\n后续之后");

    const pending = parseRichTextToNodes(input).map((node) => ({ node, depth: 0 }));
    let maxDepth = 0;
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      maxDepth = Math.max(maxDepth, depth);
      if (node.type === "strong" || node.type === "color") {
        for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
      }
    }
    expect(maxDepth).toBeLessThanOrEqual(64);
  });

  it("validates safe CSS colors", () => {
    expect(isValidCssColor("#1d4ed8")).toBe(true);
    expect(isValidCssColor("#fff")).toBe(true);
    expect(isValidCssColor("rgb(255, 0, 0)")).toBe(true);
    expect(isValidCssColor("inherit")).toBe(true);
    expect(isValidCssColor("red; position: fixed")).toBe(false);
    expect(isValidCssColor("javascript:alert(1)")).toBe(false);
  });

  it("parses plain text into text node", () => {
    const nodes = parseRichTextToNodes("负责团队前端架构重构");
    expect(nodes).toEqual([{ type: "text", text: "负责团队前端架构重构" }]);
  });

  it("parses strong and b tags", () => {
    const html = "主导<strong>核心项目</strong>上线，获得<b>良好评价</b>";
    const nodes = parseRichTextToNodes(html);
    expect(nodes).toEqual([
      { type: "text", text: "主导" },
      { type: "strong", children: [{ type: "text", text: "核心项目" }] },
      { type: "text", text: "上线，获得" },
      { type: "strong", children: [{ type: "text", text: "良好评价" }] },
    ]);
  });

  it("parses span with color style correctly", () => {
    const html = '提升性能 <span style="color: #1d4ed8">40%</span> 以上';
    const nodes = parseRichTextToNodes(html);
    expect(nodes).toEqual([
      { type: "text", text: "提升性能 " },
      { type: "color", color: "#1d4ed8", children: [{ type: "text", text: "40%" }] },
      { type: "text", text: " 以上" },
    ]);
  });

  it("handles nested strong and color tags", () => {
    const html = '<strong><span style="color: #b91c1c">重点成果</span></strong>';
    const nodes = parseRichTextToNodes(html);
    expect(nodes).toEqual([
      {
        type: "strong",
        children: [
          {
            type: "color",
            color: "#b91c1c",
            children: [{ type: "text", text: "重点成果" }],
          },
        ],
      },
    ]);
  });

  it("defends against XSS and illegal tags", () => {
    const malicious = '<script>alert(1)</script><img src="x" onerror="alert(2)">正常文本<a href="javascript:alert(3)">链接</a>';
    const sanitized = sanitizeRichText(malicious);
    expect(sanitized).toBe("正常文本链接");
    expect(sanitized).not.toContain("<script>");
    expect(sanitized).not.toContain("onerror");
    expect(sanitized).not.toContain("<img");
  });

  it("filters illegal styles in span", () => {
    const input = '<span style="color: #15803d; font-size: 50px; position: fixed" onclick="run()">文字</span>';
    const sanitized = sanitizeRichText(input);
    expect(sanitized).toBe('<span style="color: #15803d">文字</span>');
  });

  it("handles unclosed tags gracefully without crashing", () => {
    const unclosed = "<strong>未闭合文本";
    const nodes = parseRichTextToNodes(unclosed);
    expect(nodes).toEqual([
      { type: "strong", children: [{ type: "text", text: "未闭合文本" }] },
    ]);
  });

  it("strips rich text for accurate word counting", () => {
    const html = '主导开发 <strong>前端组件库</strong>，<span style="color: #1d4ed8">覆盖率 90%</span><br>并获得好评。';
    const plain = stripRichText(html);
    expect(plain).toBe("主导开发 前端组件库，覆盖率 90%\n并获得好评。");
  });

  it("stripRichText 只解码一轮实体，与 decodeHtmlEntities 语义一致", () => {
    // 等价于递归解码：`&amp;lt;` 会被解成 `<`（两轮）。用户输入含 &amp; 这类
    // 字面文本时，字数会算少、送给模型的正文也与实际所见不符。
    expect(stripRichText("A &amp;lt; B")).toBe("A &lt; B");
    expect(stripRichText("&amp;amp;")).toBe("&amp;");
    expect(stripRichText("R&amp;D")).toBe("R&D");
  });

  it("stripRichText 对纯文本输入与 decodeHtmlEntities 给出相同结果", () => {
    // 注意断言的是「与 decodeHtmlEntities 一致」，而不是幂等：
    // 单轮解码本身就不是幂等的（解完实体就没了，再来一轮会把新出现的实体再解一次），
    // 幂等性不是这里的正确不变量，两函数语义一致才是。
    for (const input of ["A &amp;lt; B", "&amp;amp;", "R&amp;D", "a &lt; b &gt; c", "&quot;引号&quot;"]) {
      expect(stripRichText(input)).toBe(decodeHtmlEntities(input));
    }
    expect(stripRichText("A &amp;lt; B")).toBe("A &lt; B");
  });

  it("stripRichText 仍把 U+00A0 折成普通空格，字数统计按空格切词", () => {
    expect(stripRichText("前端&nbsp;组件库")).toBe("前端 组件库");
    expect(stripRichText("前端 组件库")).toBe("前端 组件库");
  });

  it("converts rich text to markdown", () => {
    const html = '主导开发 <strong>前端组件库</strong>，<span style="color: #1d4ed8">覆盖率 90%</span>';
    const md = richTextToMarkdown(html);
    expect(md).toBe("主导开发 **前端组件库**，覆盖率 90%");
  });

  it("splits rich text to lines properly with prefix stripping", () => {
    const multi = `• 负责<strong>核心链路</strong>架构
- 提升性能 <span style="color: #1d4ed8">30%</span>
1. 降低故障率`;
    const lines = splitRichTextToLines(multi);
    expect(lines).toEqual([
      "负责<strong>核心链路</strong>架构",
      '提升性能 <span style="color: #1d4ed8">30%</span>',
      "降低故障率",
    ]);
  });

  it("formats plain text with newlines to rich html while preserving existing html", () => {
    const rawPlain = "负责基础架构重构\n提升构建速度 50%\n保障服务高可用";
    expect(plainTextToRichHtml(rawPlain)).toBe(
      "负责基础架构重构<br>提升构建速度 50%<br>保障服务高可用"
    );

    const alreadyHtml = '<strong>核心业务</strong><br><span style="color: #1d4ed8">提升效率</span>';
    expect(plainTextToRichHtml(alreadyHtml)).toBe(alreadyHtml);
  });

  it("已是转义过的 HTML 时不再转义一次", () => {
    // 存储约定是「转义一次的 HTML」：浏览器把用户输入的 R&D 序列化成 R&amp;D 存下来。
    // 再转一次就变成 R&amp;amp;D，每过一轮「进编辑器—保存」还会再叠一层。
    expect(plainTextToRichHtml("R&amp;D")).toBe("R&amp;D");
    expect(plainTextToRichHtml("负责 R&amp;D 中台")).toBe("负责 R&amp;D 中台");
    expect(plainTextToRichHtml("a &lt; b")).toBe("a &lt; b");
    expect(plainTextToRichHtml("P99 &lt;200ms&gt; 100ms")).toBe("P99 &lt;200ms&gt; 100ms");
  });

  it("plainTextToRichHtml 是幂等的", () => {
    for (const input of ["R&D", "R&amp;D", "a < b", "a &lt; b", "第一行\n第二行", "<strong>已有标签</strong>"]) {
      const once = plainTextToRichHtml(input);
      expect(plainTextToRichHtml(once)).toBe(once);
    }
  });
});

// D3：清洗管线必须收敛。存储约定是「原文」（rich-text.tsx 的 RichText
// 直接把文本节点交给 React，从不解码），而 sanitizeRichText 过去只单向转义，
// 于是每过一次管线就多一层实体：R&D → R&amp;D → R&amp;amp;D。
describe("rich-text 实体收敛", () => {
  it("decodeHtmlEntities 解出五种实体", () => {
    expect(decodeHtmlEntities("R&amp;D")).toBe("R&D");
    expect(decodeHtmlEntities("a &lt; b &gt; c")).toBe("a < b > c");
    expect(decodeHtmlEntities("&quot;引号&quot;")).toBe('"引号"');
    expect(decodeHtmlEntities("&nbsp;")).toBe(" ");
    expect(decodeHtmlEntities("a &amp;lt; b")).toBe("a &lt; b");
  });

  it("decodeHtmlEntities 不碰裸 & 与未知实体", () => {
    expect(decodeHtmlEntities("R&D")).toBe("R&D");
    expect(decodeHtmlEntities("a & b")).toBe("a & b");
    expect(decodeHtmlEntities("&copy; 2024")).toBe("&copy; 2024");
    expect(decodeHtmlEntities("100% & 50%")).toBe("100% & 50%");
  });

  it("sanitizeRichText 对原文转义一次，对已转义的文本收敛回原文", () => {
    expect(sanitizeRichText("R&D")).toBe("R&amp;D");
    expect(sanitizeRichText("R&amp;D")).toBe("R&amp;D");
    expect(sanitizeRichText("a < b")).toBe("a &lt; b");
    expect(sanitizeRichText("a &lt; b")).toBe("a &lt; b");
    // 双层实体不递归解码：解一次得到字面量 `&amp;`，出向再转义回原样。
    // 这是有意的——递归解码会让「正文里真的写着 &amp; 这五个字符」
    // 变得无法表示，也是经典的双重解码漏洞形状。
    expect(sanitizeRichText("R&amp;amp;D")).toBe("R&amp;amp;D");
  });

  it("sanitizeRichText 是幂等的", () => {
    for (const input of ["R&D", "R&amp;D", "a < b", "a &lt; b", "提升 80% 且降低 P99 < 300ms"]) {
      const once = sanitizeRichText(input);
      expect(sanitizeRichText(once)).toBe(once);
    }
  });

  it("splitRichTextToLines 也是幂等的，且不再逐次多转义", () => {
    const raw = "负责 R&D 中台，降低 P99 < 300ms";
    const once = splitRichTextToLines(raw);
    expect(once).toEqual(["负责 R&amp;D 中台，降低 P99 &lt; 300ms"]);
    expect(splitRichTextToLines(once.join("\n"))).toEqual(once);
  });

  it("实体解码不会把已转义的标签还原成活标签", () => {
    // 若在标签扫描之前解码，&lt;script&gt; 会先变成 <script> 再被剥离。
    // 解码发生在分词之后的文本节点上，所以它只会作为文字留下来。
    expect(sanitizeRichText("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
    expect(parseRichTextToNodes("&lt;strong&gt;")).toEqual([
      { type: "text", text: "<strong>" },
    ]);
  });

  it("转义后的富文本标签仍然照常解析，不受解码影响", () => {
    const html = '负责<strong>核心链路</strong>，提升 <span style="color: #1d4ed8">30%</span>';
    expect(sanitizeRichText(html)).toBe(html);
    expect(parseRichTextToNodes(html)).toEqual([
      { type: "text", text: "负责" },
      { type: "strong", children: [{ type: "text", text: "核心链路" }] },
      { type: "text", text: "，提升 " },
      { type: "color", color: "#1d4ed8", children: [{ type: "text", text: "30%" }] },
    ]);
  });

  it("nodesToHtml 仍然转义，XSS 防护不变", () => {
    // 解码只发生在入向的文本节点上；出向仍转义，所以节点树里的裸尖括号
    // 不会变成标签。
    const nodes = parseRichTextToNodes("&lt;img src=x onerror=alert(1)&gt;");
    expect(nodes).toEqual([{ type: "text", text: "<img src=x onerror=alert(1)>" }]);
    expect(sanitizeRichText("&lt;img src=x onerror=alert(1)&gt;")).not.toContain("<img");
  });

  it("hasHtmlEntity 只认已支持的六种实体", () => {
    expect(hasHtmlEntity("R&amp;D")).toBe(true);
    expect(hasHtmlEntity("a &lt; b")).toBe(true);
    expect(hasHtmlEntity("&nbsp;")).toBe(true);
    expect(hasHtmlEntity("R&D")).toBe(false);
    expect(hasHtmlEntity("100% & 50%")).toBe(false);
    expect(hasHtmlEntity("&copy; 2024")).toBe(false);
  });

  it("R&D 走完整条写入—渲染链只转义一次，不叠加", () => {
    // 这条把 D3 的四个环节串起来，因为缺陷正是「每一环单看都对，串起来多一层」：
    const stored = "R&amp;D";
    expect(parseRichTextToNodes(stored)).toEqual([{ type: "text", text: "R&D" }]);
    expect(plainTextToRichHtml(stored)).toBe(stored);
    const drafted = segmentsToHtml([{ kind: "text", text: "负责 R&D 中台，降低 P99 < 300ms" }]);
    expect(splitRichTextToLines(drafted)).toEqual([
      "负责 R&amp;D 中台，降低 P99 &lt; 300ms",
    ]);
    expect(stripRichText(stored)).toBe("R&D");
  });

  it("含实体的历史纯文本回填时保留换行且不叠加转义", () => {
    const stored = "R&amp;D\n第二行";
    const html = plainTextToRichHtml(stored);
    expect(html).toBe("R&amp;D<br>第二行");
    expect(plainTextToRichHtml(html)).toBe(html);
    expect(parseRichTextToNodes(html)).toEqual([
      { type: "text", text: "R&D" }, { type: "br" }, { type: "text", text: "第二行" },
    ]);
  });

  it("编辑器回填清洗活动 HTML，同时保留合法标签与单层实体", () => {
    const stored = 'R&amp;D <strong>负责</strong><img src=x onerror=alert(1)>';
    expect(plainTextToRichHtml(stored)).toBe("R&amp;D <strong>负责</strong>");
    expect(plainTextToRichHtml("R&amp;D")).toBe("R&amp;D");
  });
});
