import { describe, expect, it } from "vitest";
import type { ApplicationResumeSnapshot, ApplicationVersions } from "@/lib/applications-types";
import { compareApplicationVersions } from "@/lib/application-version-diff";

const resume: ApplicationResumeSnapshot = {
  id: 1, title: "测试简历", template: "classic", style_overrides: {},
  modules: [
    { key: "basic", type: "basic", label: "联系方式", sort: 0, content: { name: "张三", email: "a@example.com" } },
    { key: "summary", type: "summary", label: "个人介绍", sort: 1, content: { text: "原来的介绍" } },
  ],
};
function versions(): ApplicationVersions {
  return { submitted: { captured_at: "2026-09-27T00:00:00.000Z", resume: structuredClone(resume), jd: "原 JD" },
    current: { resume: structuredClone(resume), jd: "原 JD", warnings: [] } };
}

describe("投递版按模块对比", () => {
  it("相同内容全部标记未变化，并保留姓名联系方式", () => {
    const rows = compareApplicationVersions(versions());
    expect(rows.every((row) => row.status === "unchanged")).toBe(true);
    expect(rows.find((row) => row.key === "module:basic")?.before).toContain("a@example.com");
  });
  it("识别名称、模块正文和 JD 修改", () => {
    const data = versions();
    data.current.resume!.title = "新标题";
    data.current.resume!.modules[1]!.content = { text: "新介绍" };
    data.current.jd = "新 JD";
    const changed = compareApplicationVersions(data).filter((row) => row.status === "changed");
    expect(changed.map((row) => row.key)).toEqual(["title", "module:summary", "jd"]);
    expect(changed[1]).toMatchObject({ before: expect.stringContaining("原来的介绍"), after: expect.stringContaining("新介绍") });
  });
  it("识别自定义模块的新增、移除和排序变化", () => {
    const data = versions();
    data.current.resume!.modules = [data.current.resume!.modules[1]!,
      { key: "custom", type: "summary", label: "补充说明", sort: 3, content: { text: "新增" } }];
    const rows = compareApplicationVersions(data);
    expect(rows.find((row) => row.key === "module:basic")?.status).toBe("removed");
    expect(rows.find((row) => row.key === "module:summary")).toMatchObject({ status: "changed", moved: true });
    expect(rows.find((row) => row.key === "module:custom")?.status).toBe("added");
  });
  it("没有历史快照时不把当前内容描述为历史差异", () => {
    const data = versions();
    data.submitted = null;
    expect(compareApplicationVersions(data)).toEqual([]);
  });
  it("源简历删除时保留旧内容，JD 仍正常比较", () => {
    const data = versions();
    data.current.resume = null;
    const rows = compareApplicationVersions(data);
    expect(rows.find((row) => row.key === "module:summary")).toMatchObject({ status: "removed", after: null });
    expect(rows.find((row) => row.key === "jd")?.status).toBe("unchanged");
  });
});
