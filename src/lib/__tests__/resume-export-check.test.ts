import { describe, expect, it } from "vitest";
import type { ModuleData } from "@/lib/modules";
import { inspectResumeForExport } from "../resume-export-check";

function workModule(description: string): ModuleData {
  return {
    key: "work",
    type: "work",
    label: "工作经历",
    sort: 0,
    content: [{
      id: "work-1",
      company: "示例公司",
      title: "工程师",
      start: "2023-01",
      end: "2024-01",
      description,
    }],
  };
}

function basicModule(phone = "13800138000", email = "me@example.com"): ModuleData {
  return {
    key: "basic",
    type: "basic",
    label: "基本信息",
    sort: 0,
    content: {
      name: "候选人",
      phone,
      email,
      location: "上海",
      birthday: "1998-05",
      links: "",
    },
  };
}

describe("inspectResumeForExport", () => {
  it("按模块和条目定位未确认数字与残留占位符", () => {
    const result = inspectResumeForExport({
      modules: [basicModule(), workModule("优化 40%，将 [请填入真实数据，例如：30%] 的耗时降低")],
      paperHeight: 900,
    });

    expect(result.blockingIssues.map((issue) => issue.kind)).toEqual([
      "unconfirmed_metric",
      "placeholder",
    ]);
    expect(result.blockingIssues[0]).toMatchObject({
      moduleKey: "work",
      entryIndex: 0,
      field: "description",
      excerpt: "优化 40%",
    });
    expect(result.blockingIssues[1]).toMatchObject({
      moduleKey: "work",
      entryIndex: 0,
      field: "description",
    });
  });

  it("未确认数字包含前后相邻小句，但不展开整段", () => {
    const description = "参与需求拆解、接口设计、测试上线与故障排查，保障系统可用率 99.9%+，推动线上故障次数下降 80%。持续跟踪稳定性。";
    const result = inspectResumeForExport({
      modules: [workModule(description)],
    });
    const metrics = result.blockingIssues.filter((issue) => issue.kind === "unconfirmed_metric");

    expect(metrics).toHaveLength(2);
    for (const issue of metrics) {
      const position = issue.contextMetricOffset ?? -1;
      expect(issue.context?.slice(position, position + issue.excerpt.length)).toBe(issue.excerpt);
    }
    expect(metrics[0]!.context).toContain("测试上线与故障排查");
    expect(metrics[0]!.context).toContain("推动线上故障次数下降 80%");
    expect(metrics[0]!.context).not.toContain("参与需求拆解");
    expect(metrics[0]!.context).not.toContain("持续跟踪稳定性");
    expect(metrics[1]!.context).toContain("保障系统可用率 99.9%+");
    expect(metrics[1]!.context).toContain("持续跟踪稳定性");
    expect(metrics[1]!.context).not.toContain("接口设计");
  });

  it("不把联系方式和日期字段中的数字误报为成果数字", () => {
    const result = inspectResumeForExport({
      modules: [basicModule("13800138000", "me@example.com"), workModule("负责 2024-01 至 2024-06 的版本发布")],
    });

    expect(result.blockingIssues).toHaveLength(0);
    expect(result.warningIssues).toHaveLength(0);
  });

  it("联系方式缺失或格式异常时给出可定位警告", () => {
    const result = inspectResumeForExport({
      modules: [basicModule("123", "bad-email")],
    });

    expect(result.warningIssues.map((issue) => issue.kind)).toEqual([
      "contact",
      "contact",
    ]);
    expect(result.warningIssues.every((issue) => issue.moduleKey === "basic")).toBe(true);
  });

  it("分页超出 A4 时给出布局警告", () => {
    const result = inspectResumeForExport({
      modules: [basicModule()],
      paperHeight: 1200,
    });

    expect(result.warningIssues).toContainEqual(expect.objectContaining({
      kind: "pagination",
      severity: "warning",
    }));
  });

  it("确认数字后不再阻断本次导出", () => {
    const first = inspectResumeForExport({
      modules: [basicModule(), workModule("提升 40% 的转化率")],
    });
    const metric = first.blockingIssues.find((issue) => issue.kind === "unconfirmed_metric");
    expect(metric).toBeDefined();

    const second = inspectResumeForExport({
      modules: [basicModule(), workModule("提升 40% 的转化率")],
      confirmedIssueIds: new Set([metric!.id]),
    });

    expect(second.blockingIssues).toHaveLength(0);
    expect(second.canExport).toBe(true);
  });

  it("正文改变后原来的数字确认失效", () => {
    const first = inspectResumeForExport({ modules: [workModule("提升 40% 的转化率")] });
    const result = inspectResumeForExport({
      modules: [workModule("提升 40% 的收入")],
      confirmedIssueIds: new Set(first.blockingIssues.map((issue) => issue.id)),
    });
    expect(result.blockingIssues).toHaveLength(1);
  });

  it("空描述列表仍检查实际导出的旧 description", () => {
    const mod = workModule("提升 40%");
    (mod.content as Record<string, unknown>[])[0]!.descriptionItems = [];
    expect(inspectResumeForExport({ modules: [mod] }).blockingIssues).toHaveLength(1);
  });

  it("只有空白项的列表仍检查 PDF 会渲染的旧描述", () => {
    const mod = workModule("[待确认示例：40%]");
    (mod.content as Record<string, unknown>[])[0]!.descriptionItems = ["", "  "];
    expect(inspectResumeForExport({ modules: [mod] }).canExport).toBe(false);
  });

  it("检查教育、技能、标题、附加条目和联系字段的占位符", () => {
    const work = workModule("完成项目");
    (work.content as Record<string, unknown>[])[0]!.subItems = [{ id: "s1", label: "成果", value: "待补充" }];
    const result = inspectResumeForExport({
      title: "{{姓名}}简历",
      modules: [
        { ...basicModule(), content: { name: "[姓名]", email: "待填写" } },
        work,
        { key: "edu", type: "education", label: "教育", sort: 2, content: [{ id: "e1", school: "[学校名称]", description: "【待补充】" }] },
        { key: "skills", type: "skills", label: "技能", sort: 3, content: { items: ["XXX", "React 19 / TypeScript 5"] } },
      ],
    });
    expect(result.blockingIssues.filter((issue) => issue.kind === "placeholder")).toHaveLength(7);
    expect(result.blockingIssues.some((issue) => issue.excerpt.includes("TypeScript"))).toBe(false);
  });

  it("不会重复检查 descriptionItems 的派生 description", () => {
    const mod = workModule("提升 40%");
    (mod.content as Record<string, unknown>[])[0]!.descriptionItems = ["提升 40%"];
    expect(inspectResumeForExport({ modules: [mod] }).blockingIssues).toHaveLength(1);
  });

  it("确认不能跳过明确标记的示例值或占位符", () => {
    const modules = [workModule("[待确认示例：30%]")];
    const first = inspectResumeForExport({ modules });
    const result = inspectResumeForExport({ modules, confirmedIssueIds: new Set(first.issues.map((issue) => issue.id)) });
    expect(result.canExport).toBe(false);
  });

  it("接受带区号和分隔符的国际联系方式", () => {
    expect(inspectResumeForExport({ modules: [basicModule("+1 (415) 555-0123", "me@example.com")] }).warningIssues).toHaveLength(0);
  });

  it("分页问题定位到跨页条目并考虑打印页边距", () => {
    const result = inspectResumeForExport({
      modules: [basicModule(), workModule("完成项目")],
      paperHeight: 1123,
      pageMargin: 13,
      layout: [{ moduleKey: "work", entryIndex: 0, top: 1020, bottom: 1100 }],
    });
    expect(result.warningIssues).toContainEqual(expect.objectContaining({
      kind: "pagination", moduleKey: "work", entryIndex: 0,
    }));
  });

  it("识别简写占位符，保留技术括号和脱敏标记", () => {
    const result = inspectResumeForExport({ modules: [workModule("耗时降低 [X%]，吞吐 [数量]；[React] [手机号保密]")] });
    expect(result.blockingIssues.map((issue) => issue.excerpt)).toEqual(["[X%]", "[数量]"]);
  });

  it("脱敏规则引入的占位符也阻断，原文中的风险不能被脱敏隐藏", () => {
    const result = inspectResumeForExport({
      modules: [workModule("[待确认示例：40%]")],
      exportedContent: { title: "脱敏简历", modules: [workModule("替换为 [待补充]")] },
    });
    expect(result.blockingIssues).toHaveLength(2);
    expect(result.blockingIssues[1]).toMatchObject({ inExportedContent: true });
  });
});
