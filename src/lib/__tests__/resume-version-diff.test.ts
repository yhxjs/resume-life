import { resolveStyle } from "@/lib/templates";
import { describe, expect, it } from "vitest";
import { compareResumeVersions, changedText } from "@/lib/resume-version-diff";

const snapshot = () => ({ resolved_style: resolveStyle("classic", []), title: "工程师简历", template: "classic", style_overrides: {}, modules: [
  { key: "work", type: "work" as const, label: "工作经历", sort: 0, content: [
    { id: "a", company: "甲公司", title: "工程师", description: "优化响应时间 20%" },
    { id: "b", company: "乙公司", title: "实习生", description: "开发工具" },
  ] },
] });

describe("发布版本差异", () => {
  it("按稳定条目 ID 识别新增、删除、修改，不把前面插入当成后面修改", () => {
    const before = snapshot();
    const after = snapshot();
    after.modules[0]!.content = [
      { id: "c", company: "丙公司", title: "工程师", description: "新工作" },
      { ...after.modules[0]!.content[0]!, description: "优化响应时间 40%" },
    ];
    const rows = compareResumeVersions(before, after);
    expect(rows.some((row) => row.status === "added" && row.after === "丙公司")).toBe(true);
    expect(rows.some((row) => row.status === "removed" && row.before === "乙公司")).toBe(true);
    expect(rows.find((row) => row.before === "优化响应时间 20%")).toMatchObject({ status: "changed", after: "优化响应时间 40%" });
    expect(rows.find((row) => row.before === "甲公司")?.status).toBe("unchanged");
    expect(rows.some((row) => row.label.includes("排列顺序"))).toBe(false);
  });

  it("记录模块重命名、排序、样式变化，忽略revision和sort数值", () => {
    const before = snapshot();
    const after = snapshot();
    after.modules[0]!.label = "职业经历";
    after.modules[0]!.sort = 10;
    after.style_overrides = { baseSize: 14 };
    after.resolved_style = resolveStyle(after.template, [], after.style_overrides);
    const rows = compareResumeVersions(before, after).filter((row) => row.status !== "unchanged");
    expect(rows.map((row) => row.after)).toEqual(expect.arrayContaining(["职业经历", "14"]));
    expect(rows.some((row) => row.label === "sort")).toBe(false);
  });

  it("初始版本展示为新增，相同内容无差异，空字段清除标为删除", () => {
    const before = snapshot();
    expect(compareResumeVersions(null, before).every((row) => row.status === "added")).toBe(true);
    expect(compareResumeVersions(before, structuredClone(before)).every((row) => row.status === "unchanged")).toBe(true);
    const after = snapshot();
    after.modules[0]!.content[0]!.description = "";
    expect(compareResumeVersions(before, after).find((row) => row.before === "优化响应时间 20%")?.status).toBe("removed");
  });

  it("标出共同前后文之间实际替换的文字，支持 emoji", () => {
    expect(changedText("响应 20% 🚀", "响应 40% 🚀")).toEqual({ prefix: "响应 ", before: "2", after: "4", suffix: "0% 🚀" });
  });

  it("正文与列表同步变化时，只展示一次描述变化", () => {
    const before = snapshot();
    const after = snapshot();
    Object.assign(before.modules[0]!.content[0]!, { descriptionItems: ["优化响应时间 20%"] });
    Object.assign(after.modules[0]!.content[0]!, { description: "优化响应时间 40%", descriptionItems: ["优化响应时间 40%"] });
    expect(compareResumeVersions(before, after).filter((row) => row.status === "changed")).toHaveLength(1);
  });

  it("基本信息中的性别和年龄修改能正确映射中文标签", () => {
    const before = { resolved_style: resolveStyle("classic", []),
      title: "简历",
      template: "classic",
      style_overrides: {},
      modules: [
        {
          key: "basic",
          type: "basic" as const,
          label: "基本信息",
          sort: 0,
          content: { name: "小明", gender: "男", age: "25岁" },
        },
      ],
    };
    const after = { resolved_style: resolveStyle("classic", []),
      title: "简历",
      template: "classic",
      style_overrides: {},
      modules: [
        {
          key: "basic",
          type: "basic" as const,
          label: "基本信息",
          sort: 0,
          content: { name: "小明", gender: "女", age: "26岁" },
        },
      ],
    };
    const rows = compareResumeVersions(before, after);
    const genderRow = rows.find((r) => r.key === "module/basic/content/gender");
    const ageRow = rows.find((r) => r.key === "module/basic/content/age");
    expect(genderRow).toMatchObject({ section: "基本信息", label: "性别", before: "男", after: "女", status: "changed" });
    expect(ageRow).toMatchObject({ section: "基本信息", label: "年龄", before: "25岁", after: "26岁", status: "changed" });
  });
});
