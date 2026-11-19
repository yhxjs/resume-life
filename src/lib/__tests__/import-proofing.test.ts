import { describe, expect, it } from "vitest";
import { collectProofingFields, findSourceMatches } from "../import-proofing";

describe("简历导入字段校对", () => {
  it("量化指标保留正负号、小数和分组数字，不把数值的一部分提取成另一项指标", () => {
    const fields = collectProofingFields({ work: [{ description: "吞吐下降 -35%，金额 1,200.5 万元；延迟 0.5ms；区间 10–35 人。" }] });
    expect(fields.map((field) => field.value)).toEqual(["-35%", "1,200.5 万元", "0.5ms", "10–35 人"]);
  });

  it("指标定位只命中完整数值，不把 135%、1.35% 或负值当作 35% 的依据", () => {
    const source = "135%；1.35%；-35%；+35%；35%";
    const field = { id: "work[0].metric[0]", category: "量化指标" as const, label: "工作 1 · 指标", value: "35%" };
    expect(findSourceMatches(source, field)).toEqual([{ start: source.lastIndexOf("35%"), end: source.length }]);
    const signedSource = "-135%；－３５％；-35%";
    expect(findSourceMatches(signedSource, { ...field, value: "-35%" }))
      .toEqual([{ start: signedSource.indexOf("－"), end: signedSource.indexOf("；", signedSource.indexOf("－")) },
        { start: signedSource.lastIndexOf("-35%"), end: signedSource.length }]);
  });

  it("全角、比较符号与完整单位保持原字符，定位可容忍单位前空白但不丢条件", () => {
    const text = "耗时 ≤０．５ｍｓ；规模 ３千万次；未确认 ≈１，２００．５ 万元；范围 -10--5%。";
    const fields = collectProofingFields({ projects: [{ descriptionItems: [text] }] });
    expect(fields.map((field) => field.value)).toEqual(["≤０．５ｍｓ", "３千万次", "≈１，２００．５ 万元", "-10--5%"]);
    expect(findSourceMatches("前文 ≤ 0.5 ms 后文", fields[0]!)).toEqual([{ start: 3, end: 11 }]);
    expect(findSourceMatches("耗时 0.5 ms", fields[0]!)).toEqual([]);
    expect(findSourceMatches("规模 3千万次", { ...fields[1]!, value: "3千万" })).toEqual([]);
    expect(findSourceMatches("范围 -10--5%", { ...fields[3]!, value: "-5%" })).toEqual([]);
  });

  it("指数数值不能被截成尾数或指数，英文单词与标识符不冒充指标", () => {
    const fields = collectProofingFields({ work: [{ descriptionItems: ["误差 -1e-3s；延迟 1.2e+3ms；标识 v35% 与 120seconds 不作数值依据。"] }] });
    expect(fields.map((field) => field.value)).toEqual(["-1e-3s", "1.2e+3ms"]);
    expect(findSourceMatches("耗时 -1e-3s", { ...fields[0]!, value: "3s" })).toEqual([]);
  });

  it("副项按纯文本提取，不把实体或标签字面量解析成新的比较条件或指标", () => {
    const fields = collectProofingFields({ projects: [{ description: "阈值 &lt;=35%",
      subItems: [{ value: "原字符 &lt;=35%，字面 <span>12</span>ms，实际 ≤0.5ms" }] }] });
    expect(fields.map((field) => field.value)).toEqual(["<=35%", "35%", "≤0.5ms"]);
  });

  it("自定义证书和奖项的日期与指标也能定位到原文", () => {
    const fields = collectProofingFields({ custom: [{ title: "合成竞赛", start: "2024年6月", end: "",
      descriptionItems: ["团队共 5 人"], subItems: [{ label: "奖金", value: "2000 元" }] }] });
    expect(fields.map(({ id, category, value }) => [id, category, value])).toEqual([
      ["custom[0].start", "日期", "2024年6月"],
      ["custom[0].metric[0]", "量化指标", "5 人"],
      ["custom[0].metric[1]", "量化指标", "2000 元"],
    ]);
    expect(findSourceMatches("2024年6月 团队共 5 人", fields[0]!)).toEqual([{ start: 0, end: 6 }]);
  });
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
