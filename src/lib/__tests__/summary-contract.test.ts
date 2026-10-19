import { describe, expect, it } from "vitest";
import { isValidModuleContentInput, normalizeContent, type ModuleData } from "../modules";
import { invalidDomainColumn } from "../backup-domain";
import { resumeToMarkdown } from "../resume-markdown";
import { resumeToDocx } from "../resume-docx";
import { anonymizeResumeModules, DEFAULT_ANONYMIZE_CONFIG } from "../resume-anonymize";
import * as mammoth from "mammoth";

const content = {
  text: "<strong>第一项</strong>\n第二项",
  descriptionItems: ["<strong>第一项</strong>", "", "第二项"],
  descriptionStyle: "ordered" as const,
};
const moduleWith = (value: unknown): ModuleData => ({ key: "summary", type: "summary", label: "自我评价", sort: 0, content: value });

describe("自我评价列表契约", () => {
  it("保留条目和类型，正文由显式条目同步，空行可继续编辑", () => {
    expect(normalizeContent("summary", { ...content, text: "旧正文" })).toEqual(content);
    expect(normalizeContent("summary", { ...content, descriptionItems: [] })).toEqual({ text: "", descriptionItems: [], descriptionStyle: "ordered" });
    expect(normalizeContent("summary", { text: "导入正文" })).toEqual({ text: "导入正文", descriptionItems: ["导入正文"], descriptionStyle: "unordered" });
  });

  it.each([{ descriptionItems: "错误" }, { descriptionItems: [123] }, { descriptionStyle: "bullet" }, { descriptionStyle: null }])("请求拒绝非法列表字段 %j", (change) => {
    expect(isValidModuleContentInput("summary", { ...content, ...change })).toBe(false);
  });

  it("备份要求完整列表，拒绝残缺或非法列表字段", () => {
    expect(invalidDomainColumn("resume_modules", { type: "summary", content: JSON.stringify(content) })).toBeUndefined();
    expect(invalidDomainColumn("resume_modules", { type: "summary", content: JSON.stringify({ text: "正文" }) })).toBe("content");
    for (const change of [{ descriptionItems: [123] }, { descriptionStyle: "bullet" }]) {
      expect(invalidDomainColumn("resume_modules", { type: "summary", content: JSON.stringify({ ...content, ...change }) })).toBe("content");
    }
  });

  it.each(["ordered", "unordered"] as const)("Markdown 保留 %s 列表、富文本和连续编号", (descriptionStyle) => {
    const md = resumeToMarkdown("简历", [moduleWith({ ...content, descriptionStyle })]);
    expect(md).toContain(descriptionStyle === "ordered" ? "1. **第一项**\n2. 第二项" : "- **第一项**\n- 第二项");
  });

  it.each(["ordered", "unordered"] as const)("DOCX 可回读为 %s 列表并保留富文本", async (descriptionStyle) => {
    const buffer = await resumeToDocx("简历", [moduleWith({ ...content, descriptionStyle })]);
    const { value: html } = await mammoth.convertToHtml({ buffer });
    const tag = descriptionStyle === "ordered" ? "ol" : "ul";
    expect(html).toContain(`<${tag}><li><strong>第一项</strong></li><li>第二项</li></${tag}>`);
  });

  it("脱敏覆盖正文与列表字段，避免预览及附件泄露原值", () => {
    const modules = [moduleWith({ text: "私有客户成果", descriptionItems: ["<strong>私有客户</strong>成果"], descriptionStyle: "ordered" })];
    const result = anonymizeResumeModules(modules, { ...DEFAULT_ANONYMIZE_CONFIG,
      customRules: [{ id: "customer", source: "私有客户", replacement: "某客户" }],
    });
    expect(JSON.stringify(result)).not.toContain("私有客户");
    expect(result[0]!.content).toMatchObject({ descriptionItems: ["<strong>某客户</strong>成果"], descriptionStyle: "ordered" });
    expect(JSON.stringify(modules)).toContain("私有客户");
  });
});
