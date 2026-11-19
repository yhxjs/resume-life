import { describe, expect, it } from "vitest";
import { emptySummary } from "../summary";
import { compareProjectSummaries } from "../project-summary-diff";
import { readProjectSummaryProposal } from "../project-summary-proposal";

const summary = { ...emptySummary(), overview: " 定位 <T> &amp;\n内部  空格 ", achievements: [" 项目成果 "] };
const valid = () => ({ summary, comparison: compareProjectSummaries(emptySummary(), summary, {}), materialChanges: [{ id: 1, title: " 材料 <T> &amp; ", status: "new" }], materialFingerprint: "a".repeat(64), revisionId: 0 });
const change = () => valid().comparison[0]!;

const badCases: readonly (readonly [string, () => unknown])[] = [
    ["null", () => null], ["数组", () => []], ["原语", () => "draft"], ["空对象", () => ({})],
    ["空总结对象", () => ({ ...valid(), summary: {} })],
    ["残缺总结", () => ({ ...valid(), summary: { overview: "残缺" } })],
    ["错误成果类型", () => ({ ...valid(), summary: { ...summary, achievements: [1] } })],
    ["多余总结字段", () => ({ ...valid(), summary: { ...summary, extra: "额外字段" } })],
    ["无差异数组", () => ({ ...valid(), comparison: undefined })],
    ["空差异项", () => ({ ...valid(), comparison: [null] })],
    ["非法差异键", () => ({ ...valid(), comparison: [{ ...change(), key: "__proto__" }] })],
    ["成果键前导零", () => ({ ...valid(), comparison: [{ ...change(), key: "achievement:01", next: "" }] })],
    ["成果键越界整数", () => ({ ...valid(), comparison: [{ ...change(), key: "achievement:9007199254740992", next: "" }] })],
    ["重复差异键", () => ({ ...valid(), comparison: [change(), change()] })],
    ["空标签", () => ({ ...valid(), comparison: [{ ...change(), label: " " }] })],
    ["非法差异状态", () => ({ ...valid(), comparison: [{ ...change(), status: "success" }] })],
    ["错误原文类型", () => ({ ...valid(), comparison: [{ ...change(), previous: null }] })],
    ["预览与正文不同", () => ({ ...valid(), comparison: [{ ...change(), next: "另一段正文" }] })],
    ["成果预览与正文不同", () => ({ ...valid(), comparison: [{ ...change(), key: "achievement:0" }] })],
    ["没有实际差异", () => ({ ...valid(), comparison: [{ ...change(), previous: change().next }] })],
    ["新增标签不符", () => ({ ...valid(), comparison: [{ ...change(), previous: "原段落" }] })],
    ["无材料变更数组", () => ({ ...valid(), materialChanges: undefined })],
    ["空材料项", () => ({ ...valid(), materialChanges: [null] })],
    ["材料ID类型", () => ({ ...valid(), materialChanges: [{ id: "1", title: "材料", status: "new" }] })],
    ["材料ID零", () => ({ ...valid(), materialChanges: [{ id: 0, title: "材料", status: "new" }] })],
    ["材料ID小数", () => ({ ...valid(), materialChanges: [{ id: 1.5, title: "材料", status: "new" }] })],
    ["重复材料ID", () => ({ ...valid(), materialChanges: [...valid().materialChanges, ...valid().materialChanges] })],
    ["材料标题类型", () => ({ ...valid(), materialChanges: [{ id: 1, title: null, status: "new" }] })],
    ["材料状态", () => ({ ...valid(), materialChanges: [{ id: 1, title: "材料", status: "updated" }] })],
    ["无指纹", () => ({ ...valid(), materialFingerprint: undefined })],
    ["错误指纹", () => ({ ...valid(), materialFingerprint: "bad" })],
    ["无版本", () => ({ ...valid(), revisionId: undefined })],
    ["字符串版本", () => ({ ...valid(), revisionId: "1" })],
    ["负版本", () => ({ ...valid(), revisionId: -1 })],
    ["小数版本", () => ({ ...valid(), revisionId: 1.5 })],
    ["不安全版本", () => ({ ...valid(), revisionId: Number.MAX_SAFE_INTEGER + 1 })],
];

describe("待采纳项目草稿的整份回包", () => {
  it.each(badCases)("%s 拒绝整份草稿且错误不附正文", (_label, value) => {
    expect(() => readProjectSummaryProposal(value())).toThrow("项目总结草稿响应不完整或内容不符，请重新生成");
  });

  it("完整原文与合法元数据原样保留，扫描附加字段不参与采纳协议", () => {
    const input = { ...valid(), cliUsed: "codex", logs: ["日志"] };
    const before = structuredClone(input);
    expect(readProjectSummaryProposal(input)).toEqual(valid());
    expect(input).toEqual(before);
  });

  it("简历提炼可保留超过新生成限制的旧五维档案及合法空值，不清洗成新文案", () => {
    const current = { ...emptySummary(), responsibilities: " 旧档案 <T> &amp;\n内部  空格 ".repeat(100), achievements: [" 原成果 ", "", " "] };
    const generated = { ...current, techStack: "", brief: " 新简历介绍 ", achievements: [] };
    const input = { ...valid(), summary: generated, comparison: compareProjectSummaries(current, generated, {}), materialChanges: [], revisionId: 42 };
    expect(readProjectSummaryProposal(input)).toEqual(input);
    expect(readProjectSummaryProposal({ ...input, summary: current, comparison: [] }).summary).toEqual(current);
  });

  it("完整空结构、零版本及空差异仍是合法的明确清空结果", () => {
    const input = { ...valid(), summary: emptySummary(), comparison: [], materialChanges: [], revisionId: 0 };
    expect(readProjectSummaryProposal(input)).toEqual(input);
  });
});
