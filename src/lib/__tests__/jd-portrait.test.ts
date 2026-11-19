import { describe, expect, it } from "vitest";
import { normalizeJdPortrait, parseJdPortraitResult, validateGeneratedJdPortrait, JD_PORTRAIT_OUTPUT_LIMITS } from "../jd-portrait";
import { JD_PORTRAIT_SYSTEM_PROMPT } from "../jd-portrait-llm";

const skill = (name: string, weight: unknown = 8) => ({ name, weight, why: `JD 明确要求 ${name}` });
const portrait = (skills: unknown[] = [skill("TypeScript")]) => ({
  role: "开发岗位",
  must_skills: skills,
  followups: [{ topic: "类型设计", questions: ["如何表达一个对象的可选字段？"] }],
  company_style: { style: "信息不足", signals: [] },
});

describe("JD 新生成画像的严格权重与转换", () => {
  it("历史字段 must_skills 不表示数组条目均为硬性要求", () => {
    expect(JD_PORTRAIT_SYSTEM_PROMPT).toContain("must_skills 是既有 JSON 字段名，不代表每项都是硬性要求");
    expect(JD_PORTRAIT_SYSTEM_PROMPT).toContain("数组表示依据 JD 提炼的技能准备建议");
    expect(JD_PORTRAIT_SYSTEM_PROMPT).toContain("没有可识别岗位要求时，must_skills、followups 与 company_style.signals 均返回 []");
    expect(JD_PORTRAIT_SYSTEM_PROMPT).toContain('"signals": []');
  });

  it("岗位速写的提示词与生成校验共用同一字数上限", () => {
    expect(JD_PORTRAIT_SYSTEM_PROMPT).toContain(`\"role\": \"一句话概括这个岗位（方向/级别/技术栈），${JD_PORTRAIT_OUTPUT_LIMITS.role} 字以内\"`);
    const atLimit = "岗".repeat(JD_PORTRAIT_OUTPUT_LIMITS.role);
    expect(validateGeneratedJdPortrait({ ...portrait(), role: atLimit })?.role).toBe(atLimit);
    expect(validateGeneratedJdPortrait({ ...portrait(), role: `${atLimit}位` })).toBeNull();
  });

  it.each(["8", 7.5, true, false, null, undefined, [], {}, 0, 11, NaN, Infinity])("非法优先级 %j 不转换为整数", (weight) => {
    expect(validateGeneratedJdPortrait(portrait([{ ...skill("TypeScript"), weight }]))).toBeNull();
  });

  it("合法边界整数按优先级排序，不改写依据或技术名", () => {
    expect(JD_PORTRAIT_SYSTEM_PROMPT).not.toContain("按 weight 降序");
    const result = validateGeneratedJdPortrait(portrait([
      { name: " Azure Kubernetes Service ", weight: 1, why: " 仅为加分项，非硬性要求 " },
      { name: "TypeScript", weight: 10, why: "明确核心职责" },
    ]));
    expect(result?.mustSkills).toEqual([
      { name: "TypeScript", weight: 10, why: "明确核心职责" },
      { name: "Azure Kubernetes Service", weight: 1, why: "仅为加分项，非硬性要求" },
    ]);
  });

  it.each([
    ["根对象", (value: ReturnType<typeof portrait>) => ({ ...value, note: "额外字段" })],
    ["技能对象", (value: ReturnType<typeof portrait>) => ({ ...value, must_skills: [{ ...skill("TypeScript"), source: "额外字段" }] })],
    ["团队画像", (value: ReturnType<typeof portrait>) => ({ ...value, company_style: { ...value.company_style, note: "额外字段" } })],
  ])("新生成画像拒绝含额外字段的%s", (_label, value) => {
    expect(validateGeneratedJdPortrait(value)).toBeNull();
  });
});

describe("JD 画像证据不足时的输出契约", () => {
  it.each([[skill("TypeScript")], [skill("TypeScript"), skill("React")]])("保留少于三个考点的有效画像：%j", (...skills) => {
    const result = normalizeJdPortrait(portrait(skills));
    expect(result?.mustSkills).toHaveLength(skills.length);
    expect(parseJdPortraitResult(JSON.stringify(result))).toEqual(result);
  });

  it("完整的无考点说明可以返回空数组", () => {
    expect(normalizeJdPortrait({ ...portrait([]), role: "岗位信息不足", followups: [] }))
      .toMatchObject({ role: "岗位信息不足", mustSkills: [], followups: [], companyStyle: { signals: [] } });
  });

  it.each([undefined, null, "", true, false, {}, [], 0, 11, 80, 1.5, "bad"])("非法权重 %j 不被补成默认分", (weight) => {
    expect(normalizeJdPortrait(portrait([{ ...skill("React"), weight }]))).toBeNull();
  });

  it("保留合法数字字符串并按优先级排序，重复技能不凑轴", () => {
    const result = normalizeJdPortrait(portrait([skill("React", "7"), skill("TypeScript", 9), skill("react", 7)]));
    expect(result?.mustSkills.map(({ name, weight }) => ({ name, weight })))
      .toEqual([{ name: "TypeScript", weight: 9 }, { name: "React", weight: 7 }]);
  });

  it.each([
    {},
    { ...portrait(), role: "" },
    { ...portrait(), must_skills: undefined },
    { ...portrait(), must_skills: [{}] },
    { ...portrait(), followups: [{}] },
    { ...portrait(), followups: [{ topic: "类型设计", questions: [] }] },
    { ...portrait(), company_style: { style: "信息不足" } },
  ])("残缺结构不是主动返回信息不足：%j", (raw) => {
    expect(normalizeJdPortrait(raw)).toBeNull();
  });
});
