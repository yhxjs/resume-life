import { describe, expect, it } from "vitest";
import { compareDiagnosisSnapshots, compareDiagnosisScores } from "@/lib/diagnosis-comparison";
import { sanitizeModulesForDiagnosis, type DiagnosisRecord } from "@/lib/diagnosis";

function diagnosis(): DiagnosisRecord {
  return { id: 1, job_id: "a", job_title: "前端", jd: "JD", created_at: "2026-09-27", adoptions: [],
    report: { match: 6.1, summary: "", modules: [{ moduleKey: "summary", label: "评价", gaps: "", suggestions: [],
      scores: { depth: 6, structure: 6, completeness: 7, authenticity: 8 } }] },
    resume_snapshot: { title: "简历", modules: [{ key: "summary", type: "summary", label: "评价", sort: 0, content: { text: "旧内容" } }] },
  };
}
describe("诊断前后对比", () => {
  it("仅同岗位计算匹配度及相同模块的四维分数变化", () => {
    const before = diagnosis();
    const after = diagnosis();
    after.report!.match = 8.2;
    after.report!.modules[0]!.scores.depth = 8;
    const result = compareDiagnosisScores(before, after);
    expect(result?.match).toBe(2.1);
    expect(result?.modules[0]?.scores).toEqual({ depth: 2, structure: 0, completeness: 0, authenticity: 0 });
    after.job_id = "b";
    expect(compareDiagnosisScores(before, after)).toBeNull();
    expect(compareDiagnosisScores(null, after)).toBeNull();
  });
  it("按稳定模块标识对比新增、删除和正文变化，保留修改前后文本", () => {
    const before = diagnosis().resume_snapshot!;
    const after = structuredClone(before);
    after.modules[0]!.content = { text: "新内容" };
    after.modules.push({ key: "skills", type: "skills", label: "技能", sort: 1, content: { items: ["TS"] } });
    expect(compareDiagnosisSnapshots(before, after)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "summary", status: "changed", before: expect.stringContaining("旧内容"), after: expect.stringContaining("新内容") }),
      expect.objectContaining({ key: "skills", status: "added", before: null }),
    ]));
    expect(compareDiagnosisSnapshots(after, before)?.find((row) => row.key === "skills")?.status).toBe("removed");
  });
  it("不伪造无快照差异，忽略保存版本变化，识别顺序与姓名变动", () => {
    const before = diagnosis().resume_snapshot!;
    before.modules.unshift({ key: "basic", type: "basic", label: "基本信息", sort: 0, content: { name: "甲" } });
    const after = structuredClone(before);
    after.modules[1]!.revision = "new-revision";
    expect(compareDiagnosisSnapshots(before, after)?.every((row) => row.status === "unchanged")).toBe(true);
    after.modules[0]!.content = { name: "乙" };
    expect(compareDiagnosisSnapshots(before, after)?.find((row) => row.key === "basic")?.status).toBe("changed");
    after.modules.reverse();
    expect(compareDiagnosisSnapshots(before, after)?.find((row) => row.key === "summary")?.moved).toBe(true);
    expect(compareDiagnosisSnapshots(null, after)).toBeNull();
  });

  it("sanitizeModulesForDiagnosis 清洗富文本标签为纯文本且保留模块与条目骨架", () => {
    const rawModules = [
      {
        key: "work_1",
        type: "work" as const,
        label: "工作经历",
        sort: 1,
        content: [
          {
            id: "w1",
            company: "某科技",
            title: "高级工程师",
            description: "核心页面响应耗时[待确认示例：<strong>从2.5s降至0.8s</strong>]",
            descriptionItems: ["<strong>从2.5s降至0.8s</strong>", "普通描述"],
            subItems: [{ id: "sub1", label: "业绩", value: "<span style=\"color: #1d4ed8\">第一名</span>" }],
          },
        ],
      },
      {
        key: "summary",
        type: "summary" as const,
        label: "自我评价",
        sort: 2,
        content: { text: "熟练掌握 <strong>React</strong> 与微前端架构" },
      },
      {
        key: "skills",
        type: "skills" as const,
        label: "技能",
        sort: 3,
        content: { items: ["<strong>TypeScript</strong>", "React"] },
      },
    ];

    const sanitized = sanitizeModulesForDiagnosis(rawModules);
    const workItem = (sanitized[0]!.content as Extract<typeof rawModules[number]["content"], unknown[]>)[0]!;
    expect(workItem.description).toBe("核心页面响应耗时[待确认示例：从2.5s降至0.8s]");
    expect(workItem.descriptionItems).toEqual(["从2.5s降至0.8s", "普通描述"]);
    expect(workItem.subItems![0]!.value).toBe("第一名");
    expect(workItem.id).toBe("w1");

    const summary = sanitized[1]!.content as { text: string };
    expect(summary.text).toBe("熟练掌握 React 与微前端架构");

    const skills = sanitized[2]!.content as { items: string[] };
    expect(skills.items).toEqual(["TypeScript", "React"]);
  });
});

