import { describe, expect, it } from "vitest";
import { DIAGNOSIS_OUTPUT_LIMITS, normalizeDiagnosis, validateGeneratedDiagnosis, diagnosisValue, diagnosisValuesEqual } from "../diagnosis";
import type { ModuleData } from "../modules";

const summary: ModuleData = { key: "summary", type: "summary", label: "自我评价", sort: 1, content: { text: "原自评" } };
const skills: ModuleData = { key: "skills", type: "skills", label: "技能", sort: 2, content: { items: ["TypeScript"] } };
const work: ModuleData = { key: "work", type: "work", label: "工作经历", sort: 3, content: [{ id: "w1", company: "公司", title: "工程师", start: "", end: "", description: "接口开发" }] };
const custom: ModuleData = { key: "mod_awards", type: "custom", label: "补充", sort: 4, content: [{ id: "c1", title: "奖项", description: "奖励" }] };
const score = { depth: 7, structure: 7, authenticity: 8, completeness: 7 };
const rawModule = (module_key: string, suggestions: unknown[] = []) => ({ module_key, scores: score, gaps: "待补充", suggestions });
const suggestion = { item_id: "", field: "text", reason: "优化表达", draft: "保留实际职责的新自评" };

describe("简历诊断输出契约", () => {
  it.each(["description", "text"] as const)("%s 比较保持正文格式与换行差异，不套用历史技能容器兼容", (field) => {
    expect(diagnosisValuesEqual(field, "第一行\n<strong>第二行</strong>", "第一行\n<strong>第二行</strong>")).toBe(true);
    expect(diagnosisValuesEqual(field, "第一行\r\n第二行", "第一行\n第二行")).toBe(false);
    expect(diagnosisValuesEqual(field, "<strong>第二行</strong>", "第二行")).toBe(false);
    expect(diagnosisValuesEqual(field, "&amp;", "&")).toBe(false);
    expect(diagnosisValuesEqual(field, "第一行\n第二行", ["第一行", "第二行"])).toBe(false);
    expect(diagnosisValuesEqual(field, null, "")).toBe(false);
  });

  it.each([summary, skills])("$type 模块级字段只接受空条目 ID，原模块内容不改变", (mod) => {
    const field = mod.type === "summary" ? "text" : "items";
    const target = { itemId: "wrong-id", field, reason: "说明", draft: "草稿" } as const;
    const before = structuredClone(mod);
    expect(diagnosisValue([mod], mod.key, target)).toBeNull();
    expect(diagnosisValue([mod], mod.key, { ...target, itemId: "" })).toEqual(mod.type === "summary" ? "原自评" : ["TypeScript"]);
    expect(mod).toEqual(before);
  });

  it.each([null, "", "7", true, false, [], {}, NaN, Infinity, -1, 11].map((match) => [match]))(
    "拒绝非法总体匹配分 %j，不把类型强制转换为分数", (match) => {
      expect(normalizeDiagnosis({ match, summary: "分析", modules: [rawModule("summary")] }, [summary])).toBeNull();
    },
  );

  it("要求每个输入中的职业模块都有评分，不能用部分结果保存总体匹配度", () => {
    expect(normalizeDiagnosis({ match: 7, summary: "只评自评", modules: [rawModule("summary")] }, [summary, skills])).toBeNull();
    expect(normalizeDiagnosis({ match: 7, summary: "完整", modules: [rawModule("summary"), rawModule("skills")] }, [summary, skills])?.modules).toHaveLength(2);
  });

  it("过滤未知和重复模块后，只要真实模块覆盖完整就可使用", () => {
    const result = normalizeDiagnosis({ match: 7, summary: "完整", modules: [
      rawModule("unknown"), rawModule("summary"), rawModule("summary"), rawModule("skills"),
    ] }, [summary, skills]);
    expect(result?.modules.map((module) => module.moduleKey)).toEqual(["summary", "skills"]);
  });

  it("只允许可以实际采纳的模块与字段组合", () => {
    const result = normalizeDiagnosis({ match: 7, summary: "完整", modules: [
      rawModule("summary", [
        { item_id: "", field: "text", reason: "改进自评", draft: "新自评" },
        { item_id: "", field: "description", reason: "错误字段", draft: "不可采纳" },
      ]),
      rawModule("work", [
        { item_id: "w1", field: "description", reason: "可采纳", draft: "新经历" },
        { item_id: "missing", field: "description", reason: "ID 不存在", draft: "不可采纳" },
      ]),
      rawModule("skills", [
        { item_id: "", field: "items", reason: "技能建议", draft: ["TypeScript", "React"] },
        { item_id: "", field: "text", reason: "错误字段", draft: "不可采纳" },
      ]),
      rawModule("mod_awards", [
        { item_id: "", field: "text", reason: "未支持的自定义字段", draft: "不可采纳" },
        { item_id: "c1", field: "description", reason: "未支持的自定义字段", draft: "不可采纳" },
      ]),
    ] }, [summary, work, skills, custom]);

    expect(result?.modules.map((module) => module.suggestions.length)).toEqual([1, 1, 1, 0]);
    const normalizedWork = result!.modules.find((module) => module.moduleKey === "work")!.suggestions[0]!;
    expect(diagnosisValue([summary, work, skills, custom], "work", normalizedWork)).toBe("接口开发");
  });
});

describe("新生成诊断的完整性", () => {
  const valid = { match: 7.2, summary: "有依据的总评", modules: [rawModule("summary", [suggestion])] };
  it.each([0, 10, 7.2])("接受一位小数范围内的匹配分 %s", (match) => {
    expect(validateGeneratedDiagnosis({ ...valid, match }, [summary])?.match).toBe(match);
  });

  it.each(["7.2", -0.1, 10.1, 7.25, 7.234])("拒绝非数值、越界或超过一位小数的匹配分 %j", (match) => {
    expect(validateGeneratedDiagnosis({ ...valid, match }, [summary])).toBeNull();
  });

  it("拒绝输出协议外格式声明；合法新草稿由服务端标记纯文本并保留原文", () => {
    const draft = "支持 Map<K, V>\r\n保留 &amp; 与 <strong>字面标签</strong>";
    const raw = { ...valid, summary: `总评：${draft}`, textFormat: "html", draftFormat: "html", modules: [{
      ...rawModule("summary", [{ ...suggestion, reason: `理由：${draft}`, draft }]), gaps: `差距：${draft}`,
    }] };
    const before = structuredClone(raw);
    expect(validateGeneratedDiagnosis(raw, [summary])).toBeNull();
    const withoutFormatClaims: Record<string, unknown> = { ...raw };
    delete withoutFormatClaims.textFormat;
    delete withoutFormatClaims.draftFormat;
    const parsed = validateGeneratedDiagnosis(withoutFormatClaims, [summary]);
    expect(parsed?.textFormat).toBe("plain-text");
    expect(parsed).not.toHaveProperty("draftFormat");
    expect(parsed?.modules[0]?.suggestions[0]?.draft).toBe(draft);
    expect(parsed?.summary).toBe(raw.summary);
    expect(parsed?.modules[0]?.gaps).toBe(raw.modules[0]!.gaps);
    expect(parsed?.modules[0]?.suggestions[0]?.reason).toBe(`理由：${draft}`);
    expect(raw).toEqual(before);
  });

  it.each([
    ["总评", { ...valid, summary: "\u200b\u2060" }],
    ["可选缺口", { ...valid, modules: [{ ...rawModule("summary"), gaps: "!!!" }] }],
    ["建议理由", { ...valid, modules: [rawModule("summary", [{ ...suggestion, reason: "\u200b" }])] }],
    ["建议草稿", { ...valid, modules: [rawModule("summary", [{ ...suggestion, draft: "!!!" }])] }],
  ] as const)("拒绝仅含不可见字符或纯标点的%s", (_field, raw) => {
    expect(validateGeneratedDiagnosis(raw, [summary])).toBeNull();
  });

  it("历史清洗不补纯文本标记或改写历史富文本草稿", () => {
    const draft = "<strong>原有加粗</strong>与 Map&lt;K, V&gt;";
    const parsed = normalizeDiagnosis({ ...valid, modules: [rawModule("summary", [{ ...suggestion, draft }])] }, [summary]);
    expect(parsed).not.toHaveProperty("draftFormat");
    expect(parsed).not.toHaveProperty("textFormat");
    expect(parsed?.modules[0]?.suggestions[0]?.draft).toBe(draft);
  });

  it.each([
    ["缺少总评", { ...valid, summary: undefined }],
    ["额外顶层字段", { ...valid, extra: true }],
    ["空总评", { ...valid, summary: " " }],
    ["未知模块", { ...valid, modules: [rawModule("unknown")] }],
    ["重复模块", { ...valid, modules: [rawModule("summary"), rawModule("summary")] }],
    ["缺少缺口字段", { ...valid, modules: [{ ...rawModule("summary"), gaps: undefined }] }],
    ["模块额外字段", { ...valid, modules: [{ ...rawModule("summary"), extra: true }] }],
    ["缺口类型错误", { ...valid, modules: [{ ...rawModule("summary"), gaps: false }] }],
    ["缺少建议数组", { ...valid, modules: [{ ...rawModule("summary"), suggestions: undefined }] }],
    ["建议不是数组", { ...valid, modules: [{ ...rawModule("summary"), suggestions: {} }] }],
    ["字符串分数", { ...valid, modules: [{ ...rawModule("summary"), scores: { ...score, depth: "7" } }] }],
    ["小数分数", { ...valid, modules: [{ ...rawModule("summary"), scores: { ...score, structure: 7.5 } }] }],
    ["评分额外字段", { ...valid, modules: [{ ...rawModule("summary"), scores: { ...score, extra: 8 } }] }],
    ["低于提示词标尺", { ...valid, modules: [{ ...rawModule("summary"), scores: { ...score, depth: 0 } }] }],
    ["有效建议混入错误条目", { ...valid, modules: [rawModule("summary", [suggestion, null])] }],
    ["缺少理由", { ...valid, modules: [rawModule("summary", [{ ...suggestion, reason: undefined }])] }],
    ["空白理由", { ...valid, modules: [rawModule("summary", [{ ...suggestion, reason: " " }])] }],
    ["省略条目ID字段", { ...valid, modules: [rawModule("summary", [{ ...suggestion, item_id: undefined }])] }],
    ["建议额外字段", { ...valid, modules: [rawModule("summary", [{ ...suggestion, extra: true }])] }],
    ["无效替换字段", { ...valid, modules: [rawModule("summary", [{ ...suggestion, field: "description" }])] }],
    ["文本草稿类型错误", { ...valid, modules: [rawModule("summary", [{ ...suggestion, draft: ["文字"] }])] }],
    ["同一目标有多条建议", { ...valid, modules: [rawModule("summary", [suggestion, { ...suggestion, draft: "不同的草稿" }])] }],
  ])("拒绝%s，不能通过过滤或补默认值生成部分成功", (_label, raw) => {
    expect(validateGeneratedDiagnosis(raw, [summary])).toBeNull();
  });

  it.each([1, 10])("有效整数边界 %i 和明确的空缺口、空建议均可保存", (boundary) => {
    const scores = { depth: boundary, structure: boundary, authenticity: boundary, completeness: boundary };
    const raw = { match: 7, summary: "无需改写", modules: [{ ...rawModule("summary"), scores, gaps: "" }] };
    expect(validateGeneratedDiagnosis(raw, [summary])?.modules[0]).toMatchObject({ scores, gaps: "", suggestions: [] });
  });

  it.each([["TypeScript", false], ["TypeScript", " "], "TypeScript", []].map((draft) => ({ draft })))("技能整组替换不丢弃错误元素后保存：$draft", ({ draft }) => {
    const raw = { match: 7, summary: "技能评估", modules: [rawModule("skills", [{ ...suggestion, field: "items", draft }])] };
    expect(validateGeneratedDiagnosis(raw, [skills])).toBeNull();
  });

  it("完整技能列表和不同经历条目的建议原样保留", () => {
    const secondWork: ModuleData = { ...work, content: [...(work.content as object[]), { id: "w2", description: "联调支持" }] };
    const raw = { match: 7, summary: "完整诊断", modules: [
      rawModule("skills", [{ ...suggestion, field: "items", draft: ["TypeScript", "基础维护"] }]),
      rawModule("work", [
        { ...suggestion, item_id: "w1", field: "description", draft: "参与接口开发" },
        { ...suggestion, item_id: "w2", field: "description", draft: "参与联调支持" },
      ]),
    ] };
    const parsed = validateGeneratedDiagnosis(raw, [skills, secondWork]);
    expect(parsed?.modules[0]?.suggestions[0]?.draft).toEqual(["TypeScript", "基础维护"]);
    expect(parsed?.modules[1]?.suggestions.map((item) => item.itemId)).toEqual(["w1", "w2"]);
  });

  it("历史清洗仍兼容字符串分数与无效建议过滤，不套用生成校验", () => {
    const raw = { match: 7, summary: "历史报告", modules: [{ ...rawModule("summary", [suggestion, null]), scores: { ...score, depth: "6", structure: 7.5 } }] };
    expect(normalizeDiagnosis(raw, [summary])?.modules[0]).toMatchObject({ scores: { depth: 6, structure: 8 }, suggestions: [{ itemId: "", field: "text" }] });
    expect(validateGeneratedDiagnosis(raw, [summary])).toBeNull();
  });

  it("新生成文本在字段边界可通过，超过一字或技能项异常膨胀整份拒绝", () => {
    const within = {
      match: 7,
      summary: "总评".repeat(Math.floor(DIAGNOSIS_OUTPUT_LIMITS.summary / 2)),
      modules: [rawModule("summary", [{
        ...suggestion,
        reason: "因".repeat(DIAGNOSIS_OUTPUT_LIMITS.reason),
        draft: "稿".repeat(DIAGNOSIS_OUTPUT_LIMITS.textDraft),
      }])],
    };
    expect(validateGeneratedDiagnosis(within, [summary])).not.toBeNull();

    expect(validateGeneratedDiagnosis({ ...within, summary: "字".repeat(DIAGNOSIS_OUTPUT_LIMITS.summary + 1) }, [summary])).toBeNull();
    expect(validateGeneratedDiagnosis({ ...within, modules: [rawModule("summary", [{
      ...suggestion, draft: "字".repeat(DIAGNOSIS_OUTPUT_LIMITS.textDraft + 1),
    }])] }, [summary])).toBeNull();
    expect(validateGeneratedDiagnosis({ ...within, modules: [{
      ...rawModule("summary", [{ ...suggestion, draft: "稿" }]),
      gaps: "字".repeat(DIAGNOSIS_OUTPUT_LIMITS.gaps + 1),
    }] }, [summary])).toBeNull();
    expect(validateGeneratedDiagnosis({ ...within, modules: [rawModule("work", [{
      ...suggestion, item_id: "w1", field: "description", draft: "稿".repeat(DIAGNOSIS_OUTPUT_LIMITS.descriptionDraft),
    }])] }, [work])).not.toBeNull();
    expect(validateGeneratedDiagnosis({ ...within, modules: [rawModule("work", [{
      ...suggestion, item_id: "w1", field: "description", draft: "稿".repeat(DIAGNOSIS_OUTPUT_LIMITS.descriptionDraft + 1),
    }])] }, [work])).toBeNull();
    const skillsDraft = Array.from({ length: 2 }, (_, index) => `技能${index}`);
    expect(validateGeneratedDiagnosis({ match: 7, summary: "技能", modules: [rawModule("skills", [{
      ...suggestion, field: "items", draft: skillsDraft,
    }])] }, [skills])).not.toBeNull();
    expect(validateGeneratedDiagnosis({ match: 7, summary: "技能", modules: [rawModule("skills", [{
      ...suggestion, field: "items", draft: ["字".repeat(DIAGNOSIS_OUTPUT_LIMITS.skill + 1)],
    }])] }, [skills])).toBeNull();
    expect(validateGeneratedDiagnosis({ match: 7, summary: "技能", modules: [rawModule("skills", [{
      ...suggestion, field: "items", draft: Array.from({ length: DIAGNOSIS_OUTPUT_LIMITS.maxSkills + 1 }, (_, index) => `技能${index}`),
    }])] }, [skills])).toBeNull();
  });

  it("新生成总文本超过上限时拒绝，不通过删掉建议或截断保存", () => {
    const raw = {
      match: 7,
      summary: "总评",
      modules: [rawModule("summary", [{
        ...suggestion,
        reason: "理由",
        draft: "字".repeat(DIAGNOSIS_OUTPUT_LIMITS.totalText),
      }]), rawModule("skills", [])],
    };
    expect(validateGeneratedDiagnosis(raw, [summary, skills])).toBeNull();
  });

  it("历史兼容清洗不套用新生成篇幅上限", () => {
    const longSummary = "字".repeat(DIAGNOSIS_OUTPUT_LIMITS.summary + 1);
    const raw = { match: 7, summary: longSummary, modules: [rawModule("summary", [{
      ...suggestion, reason: "理".repeat(DIAGNOSIS_OUTPUT_LIMITS.reason + 1), draft: "稿".repeat(DIAGNOSIS_OUTPUT_LIMITS.textDraft + 1),
    }])] };
    expect(normalizeDiagnosis(raw, [summary])?.summary).toBe(longSummary);
    expect(normalizeDiagnosis(raw, [summary])?.modules[0]?.suggestions[0]?.draft).toBe("稿".repeat(DIAGNOSIS_OUTPUT_LIMITS.textDraft + 1));
    expect(validateGeneratedDiagnosis(raw, [summary])).toBeNull();
  });
});
