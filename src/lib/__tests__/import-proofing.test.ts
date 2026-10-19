import { describe, expect, it } from "vitest";
import { collectProofingFields, findSourceMatches } from "../import-proofing";

describe("简历导入字段校对", () => {
  it("按草稿路径收集联系方式、日期、学校、公司与量化指标", () => {
    const fields = collectProofingFields({
      basic: { phone: "13800138000", email: "A@EXAMPLE.COM", birthday: "1998-05" },
      education: [{ school: "华中科技大学", start: "2016.09", end: "2020.06" }],
      work: [{ company: "示例科技", start: "2022.03", end: "至今", descriptionItems: ["吞吐提升 35%", "节省 200 万元"] }],
      projects: [{ start: "2023.01", descriptionItems: ["响应时间减少 120ms"] }],
    });

    expect(fields.map(({ id, category, value }) => [id, category, value])).toEqual([
      ["basic.phone", "联系方式", "13800138000"],
      ["basic.email", "联系方式", "A@EXAMPLE.COM"],
      ["basic.birthday", "日期", "1998-05"],
      ["education[0].school", "学校", "华中科技大学"],
      ["education[0].start", "日期", "2016.09"],
      ["education[0].end", "日期", "2020.06"],
      ["work[0].company", "公司", "示例科技"],
      ["work[0].start", "日期", "2022.03"],
      ["work[0].end", "日期", "至今"],
      ["work[0].metric[0]", "量化指标", "35%"],
      ["work[0].metric[1]", "量化指标", "200 万元"],
      ["projects[0].start", "日期", "2023.01"],
      ["projects[0].metric[0]", "量化指标", "120ms"],
    ]);
  });

  it("匹配全角与大小写差异，同时返回原文区间", () => {
    const source = "邮箱：Ａ＠ＥＸＡＭＰＬＥ．ＣＯＭ";
    expect(findSourceMatches(source, { id: "basic.email", category: "联系方式", label: "邮箱", value: "a@example.com" }))
      .toEqual([{ start: 3, end: source.length }]);
  });

  it("日期和电话允许常见分隔符差异，不把更长数字误认为命中", () => {
    const source = "2022-03 / 2022.03 / 2022.031；电话 138-0013-8000，旧号 1138001380000";
    expect(findSourceMatches(source, { id: "work[0].start", category: "日期", label: "开始", value: "2022.03" }))
      .toEqual([{ start: 0, end: 7 }, { start: 10, end: 17 }]);
    const phoneStart = source.indexOf("138-0013-8000");
    expect(findSourceMatches(source, { id: "basic.phone", category: "联系方式", label: "电话", value: "13800138000" }))
      .toEqual([{ start: phoneStart, end: phoneStart + "138-0013-8000".length }]);
  });

  it("重复出现按原文顺序返回，字段改动后重新查找，未匹配返回空列表", () => {
    const source = "示例科技与示例科技合作";
    const field = { id: "work[0].company", category: "公司" as const, label: "公司", value: "示例科技" };
    expect(findSourceMatches(source, field)).toEqual([{ start: 0, end: 4 }, { start: 5, end: 9 }]);
    expect(findSourceMatches(source, { ...field, value: "另一家公司" })).toEqual([]);
  });
});
