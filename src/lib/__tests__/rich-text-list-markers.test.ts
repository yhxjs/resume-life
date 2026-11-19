import { describe, expect, it } from "vitest";
import { normalizePolishResult } from "@/lib/polish";
import { escapePlainTextToRichHtml, splitRichTextToLines, stripLeadingListMarker, stripRichText } from "@/lib/rich-text";

describe("列表前缀与技术正文边界", () => {
  it.each([
    "*ptr 只完成本地验证，尚未上线。",
    "--dry-run 只验证流程，未实际发布。",
    "-O2 仅用于测试构建。",
    "*<T> 是类型文档中的字面示例，未运行。",
    "**仅参与校验，尚未上线。**",
    "2023.07 接手接口维护，至今尚未上线。",
    "3.14 秒为测试环境耗时。",
    "-10% 为测试环境变化。",
    "3.x 版本仅完成兼容性测试，尚未上线。",
    "2.example.com 为测试域名，未用于生产。",
  ])("纯文本与富文本多次整理都保留技术前缀：%s", (text) => {
    expect(stripLeadingListMarker(text)).toBe(text);
    const html = `<strong>${escapePlainTextToRichHtml(text)}</strong>`;
    const lines = splitRichTextToLines(html);
    expect(lines.map(stripRichText)).toEqual([text]);
    expect(splitRichTextToLines(lines.join("\n"))).toEqual(lines);
    const result = normalizePolishResult({ draft: text, draftItems: [{ text, sourceIndices: [1] }] });
    expect(result?.draftItems).toEqual([text]);
  });

  it("中文项目符号无需空格，ASCII 列表需空格，编号格式继续兼容", () => {
    for (const prefix of ["•", "·", "・", "●", "* ", "- ", "*\t", "-\u00a0", "1.", "2、", "12)", "100. "]) {
      expect(splitRichTextToLines(`${prefix}仅参与测试`)).toEqual(["仅参与测试"]);
      expect(splitRichTextToLines(`<strong>${prefix}仅参与测试</strong>`)).toEqual(["<strong>仅参与测试</strong>"]);
    }
  });

  it("跨强调边界判断实际空白，技术字符单独加粗时不被误删", () => {
    expect(splitRichTextToLines("<strong>*</strong>ptr 只在测试环境验证")).toEqual(["<strong>*</strong>ptr 只在测试环境验证"]);
    expect(splitRichTextToLines("<strong>-</strong>-dry-run 仅验证流程")).toEqual(["<strong>-</strong>-dry-run 仅验证流程"]);
    expect(splitRichTextToLines("<strong>*</strong> 仅参与验证").map((line) => stripRichText(line).trim())).toEqual(["仅参与验证"]);
    expect(splitRichTextToLines("<strong>-</strong> 仅参与验证").map((line) => stripRichText(line).trim())).toEqual(["仅参与验证"]);
    expect(stripLeadingListMarker("*")).toBe("");
    expect(stripLeadingListMarker("-")).toBe("");
  });

  it.each([
    "<strong>3.</strong>x 版本仅完成兼容性测试，尚未上线。",
    '<span style="color: #1d4ed8">2.</span>example.com 为测试域名，未用于生产。',
  ])("数字技术前缀跨强调边界仍完整保留：%s", (html) => {
    expect(stripLeadingListMarker(html)).toBe(html);
    const lines = splitRichTextToLines(html);
    expect(lines.map(stripRichText)).toEqual([stripRichText(html)]);
    expect(splitRichTextToLines(lines.join("\n"))).toEqual(lines);
  });

  it.each([
    ["1. Verify only in testing", "Verify only in testing"],
    ["1.\t仅参与测试", "仅参与测试"],
    ["1.\u00a0仅参与测试", "仅参与测试"],
    ["<strong>1.</strong> 仅参与测试", "仅参与测试"],
    ["<strong>1.</strong>仅参与测试", "仅参与测试"],
    ["1.<strong>仅参与测试</strong>", "仅参与测试"],
  ])("分隔空白和既有中文无空格编号继续识别：%s", (input, expected) => {
    expect(splitRichTextToLines(input).map(text => stripRichText(text).trim())).toEqual([expected]);
  });
});
