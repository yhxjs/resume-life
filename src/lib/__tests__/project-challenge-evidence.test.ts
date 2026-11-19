import { describe, expect, it } from "vitest";
import { buildProjectChallengeEvidenceSystem, consumeProjectChallengeEvidence, type ProjectChallengeEvidenceIssue } from "../../../evals/project-challenge-evidence";
import { PROJECT_SUMMARY_OUTPUT_RULES, PROJECT_SUMMARY_SYSTEM_PROMPT } from "../project-summary-llm";
import { wrapUntrustedData } from "../prompt-safety";
import { emptySummary, isGeneratedProjectSummary, PROJECT_SUMMARY_OUTPUT_LIMITS as LIMITS } from "../summary";

const reference = (quote: string, materialNumber = 1) => ({ materialNumber, quote });
const issue = (problem: string, handling: string[] = [], outcome: string[] = []): ProjectChallengeEvidenceIssue => ({
  problem: reference(problem), handling: handling.map(quote => reference(quote)), outcome: outcome.map(quote => reference(quote)),
});
const output = (challenges: unknown = []) => ({ ...emptySummary(), overview: "本地工具", challenges });
const materials = (content: string) => [{ title: "合成材料", content }];
const transport = (source: string) => wrapUntrustedData("source", source).slice("<source>\n".length, -"\n</source>".length);

describe("项目难点证据候选的模板边界", () => {
  it("维持原八字段顺序及其他七字段，并同步数组与五维空值契约", () => {
    const candidate = buildProjectChallengeEvidenceSystem();
    const example = (prompt: string) => JSON.parse(prompt.match(/\n(\{\n[\s\S]*?\n\})/)![1]!);
    const oldExample = example(PROJECT_SUMMARY_SYSTEM_PROMPT), newExample = example(candidate);
    expect(Object.keys(newExample)).toEqual(Object.keys(oldExample));
    expect(newExample).toEqual({ ...oldExample, challenges: [] });
    expect(candidate).not.toContain("七个文本字段均为字符串");
    expect(candidate).not.toContain('challenges=""');
    expect(candidate).toContain("六个文本字段均为字符串");
    expect(candidate).toContain("challenges=[]");
    expect(candidate).not.toContain("纯进度或阶段状态本身不是难点，不能单独作为难点填入 challenges");
    const sourceAndScope = PROJECT_SUMMARY_SYSTEM_PROMPT.split("目标与来源：")[1]!.split("五维字段只填")[0]!;
    const archiveConflictRules = PROJECT_SUMMARY_SYSTEM_PROMPT.slice(
      PROJECT_SUMMARY_SYSTEM_PROMPT.indexOf("未澄清的档案与原始材料冲突"),
      PROJECT_SUMMARY_SYSTEM_PROMPT.indexOf("\n目标与来源："),
    );
    const writingRules = PROJECT_SUMMARY_SYSTEM_PROMPT.slice(PROJECT_SUMMARY_SYSTEM_PROMPT.indexOf("写作要求："));
    expect(candidate).toContain(sourceAndScope);
    expect(candidate).toContain(archiveConflictRules);
    expect(candidate).toContain(writingRules);
  });

  it("拒绝缺失、重复、已有数组、混合或改序模板，不静默套用另一轮候选", () => {
    const candidate = buildProjectChallengeEvidenceSystem();
    const malformed = [
      PROJECT_SUMMARY_SYSTEM_PROMPT.replace(PROJECT_SUMMARY_OUTPUT_RULES, ""),
      PROJECT_SUMMARY_SYSTEM_PROMPT + PROJECT_SUMMARY_OUTPUT_RULES,
      PROJECT_SUMMARY_SYSTEM_PROMPT + '\n{"challenges":[]}',
      PROJECT_SUMMARY_SYSTEM_PROMPT.replace('"challenges": "已知问题、应对方式与有证据的结果"', '"challenges": []'),
      PROJECT_SUMMARY_SYSTEM_PROMPT.replace('challenges=""', "challenges=[]"),
      PROJECT_SUMMARY_SYSTEM_PROMPT.replace("challenges 放实际问题及处理依据。", ""),
      PROJECT_SUMMARY_SYSTEM_PROMPT + "challenges 放实际问题及处理依据。",
      PROJECT_SUMMARY_SYSTEM_PROMPT.replace("五维字段只填该维度已有的具体证据", "五维规则已变更"),
      PROJECT_SUMMARY_SYSTEM_PROMPT.replace('  "overview": "有依据的项目定位、使用场景与主要功能",\n', "")
        .replace('  "architecture":', '  "overview": "有依据的项目定位、使用场景与主要功能", "architecture":'),
      candidate,
    ];
    for (const system of malformed) expect(() => buildProjectChallengeEvidenceSystem(system)).toThrow("requires one unchanged production");
  });
});

describe("项目难点证据候选的来源校验与确定性消费", () => {
  it("未解决实际问题无需已有处理；准确保留否定、原始换行及空白", () => {
    const problem = "  起始时间相等的日志被遗漏。\n", state = "原因尚未定位，未实施修复。";
    const raw = output([issue(problem, [], [state])]);
    const before = structuredClone(raw);
    const result = consumeProjectChallengeEvidence(raw, materials(problem + state));
    expect(result?.challenges).toBe(`${problem}；${state}`);
    expect(isGeneratedProjectSummary(result)).toBe(true);
    expect(raw).toEqual(before);
  });

  it("按照问题、处理、结果及多问题次序连接，允许不同问题共享真实状态", () => {
    const raw = output([
      issue("含逗号的姓名被拆列", ["已补充字段转义"], ["尚未复测"]),
      issue("双引号未转义", ["已转义双引号"], ["尚未复测"]),
    ]);
    const result = consumeProjectChallengeEvidence(raw, materials("含逗号的姓名被拆列；双引号未转义；已补充字段转义；已转义双引号；尚未复测"));
    expect(result?.challenges).toBe("含逗号的姓名被拆列；已补充字段转义；尚未复测；双引号未转义；已转义双引号；尚未复测");
  });

  it("已处理的问题保留处理与有限验证，空数组保留其他七字段", () => {
    const result = consumeProjectChallengeEvidence(output([issue("姓名被拆列", ["已提交转义修改"], ["6行合成名单复测符合预期，未用真实名单验证"])]),
      materials("姓名被拆列。已提交转义修改。6行合成名单复测符合预期，未用真实名单验证。"));
    expect(result?.challenges).toBe("姓名被拆列；已提交转义修改；6行合成名单复测符合预期，未用真实名单验证");
    expect(consumeProjectChallengeEvidence(output(), materials("工具未发布"))).toEqual({ ...emptySummary(), overview: "本地工具" });
    expect(consumeProjectChallengeEvidence({ ...emptySummary(), challenges: [] }, materials("工具未发布"))).toBeNull();
  });

  it("引用必须命中指定编号的content，允许不同槽引用各自明确的来源", () => {
    const source = [{ title: "问题记录", content: "日志遗漏" }, { title: "后续记录", content: "尚未定位" }];
    const good = { problem: reference("日志遗漏"), handling: [], outcome: [reference("尚未定位", 2)] };
    expect(consumeProjectChallengeEvidence(output([good]), source)?.challenges).toBe("日志遗漏；尚未定位");
    for (const bad of [reference("日志遗漏", 2), reference("问题记录"), reference("日志遗漏尚未定位")]) {
      expect(consumeProjectChallengeEvidence(output([{ ...good, problem: bad }]), source)).toBeNull();
    }
    expect(consumeProjectChallengeEvidence(output([issue("日志遗失")]), source)).toBeNull();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2, "1", null])("拒绝非法或不存在的编号 %s", materialNumber => {
    expect(consumeProjectChallengeEvidence(output([{ ...issue("日志遗漏"), problem: { materialNumber, quote: "日志遗漏" } }]), materials("日志遗漏"))).toBeNull();
  });

  it("拒绝无来源、非普通材料以及不完整问题和引用结构", () => {
    const raw = output([issue("日志遗漏")]);
    expect(consumeProjectChallengeEvidence(raw, [])).toBeNull();
    expect(consumeProjectChallengeEvidence(raw, materials(""))).toBeNull();
    expect(consumeProjectChallengeEvidence(raw, [{ ...materials("日志遗漏")[0]!, tableProvenance: {} as never }])).toBeNull();
    const invalid = [
      null, "日志遗漏", [null], [{ problem: reference("日志遗漏"), handling: [] }],
      [{ ...issue("日志遗漏"), handling: null }], [{ ...issue("日志遗漏"), outcome: "尚未定位" }],
      [{ ...issue("日志遗漏"), note: "额外字段" }],
      [{ ...issue("日志遗漏"), problem: { ...reference("日志遗漏"), source: "额外字段" } }],
      [{ ...issue("日志遗漏"), handling: [{ quote: "日志遗漏" }] }],
      [issue("")], [issue(" ")], [issue("\u200b")],
    ];
    for (const challenges of invalid) expect(consumeProjectChallengeEvidence(output(challenges), materials("日志遗漏 \u200b"))).toBeNull();
  });

  it("仅还原有来源的一层实体，保留字面实体且不递归或扩展解码", () => {
    for (const quote of ["Array<T>解析失败 & 未修复", "字面 &lt;T&gt; 解析失败"]) {
      expect(consumeProjectChallengeEvidence(output([issue(transport(quote))]), materials(quote))?.challenges).toBe(quote);
    }
    expect(consumeProjectChallengeEvidence(output([issue("&lt;T&gt;")]), materials("&lt;T&gt; 与 <T>"))?.challenges).toBe("&lt;T&gt;");
    for (const quote of ["Array&amp;lt;T&amp;gt;失败", "Array&#60;T&#62;失败", "Array&lt;T&gt;成功"]) {
      expect(consumeProjectChallengeEvidence(output([issue(quote)]), materials("Array<T>失败"))).toBeNull();
    }
  });

  it("恢复后重复的问题及同一问题内重复引用整份拒绝，不静默去重", () => {
    const source = materials("Array<T>失败，尚未复测");
    const repeatedProblem = [issue("Array<T>失败"), issue("Array&lt;T&gt;失败", [], ["尚未复测"])];
    const repeatedInIssue = [{ ...issue("Array<T>失败"), handling: [reference("Array&lt;T&gt;失败")] }];
    const repeatedState = [issue("Array<T>失败", ["尚未复测"], ["尚未复测"])];
    for (const challenges of [repeatedProblem, repeatedInIssue, repeatedState]) {
      expect(consumeProjectChallengeEvidence(output(challenges), source)).toBeNull();
    }
  });

  it("维度字符上限包含连接分号，超限拒绝而不截断源文", () => {
    const problem = "错".repeat(LIMITS.dimension - 2), state = "未";
    const source = materials(problem + state + "验");
    expect(consumeProjectChallengeEvidence(output([issue(problem, [], [state])]), source)?.challenges).toHaveLength(LIMITS.dimension);
    expect(consumeProjectChallengeEvidence(output([issue(problem, [], [state + "验"])]), source)).toBeNull();
    const literal = "<".repeat(LIMITS.dimension - 1) + "错";
    expect(consumeProjectChallengeEvidence(output([issue(transport(literal))]), materials(literal))?.challenges).toBe(literal);
  });

  it("其他七字段仍由生产validator完整拒绝，最终对象采用标准键序", () => {
    const source = materials("日志遗漏");
    const raw = output([issue("日志遗漏")]);
    for (const invalid of [
      { ...raw, extra: "不得添加" }, { ...raw, overview: null }, { ...raw, overview: "字".repeat(LIMITS.dimension + 1) },
      { ...raw, brief: "字".repeat(LIMITS.brief + 1) }, { ...raw, techStack: "字".repeat(LIMITS.techStack + 1) },
      { ...raw, achievements: ["重复", " 重复 "] }, { ...raw, achievements: ["字".repeat(LIMITS.achievement + 1)] },
      { ...raw, architecture: "\u200b" },
    ]) expect(consumeProjectChallengeEvidence(invalid, source)).toBeNull();
    const incomplete: Record<string, unknown> = { ...raw }; delete incomplete.brief;
    expect(consumeProjectChallengeEvidence(incomplete, source)).toBeNull();
    const reversed = Object.fromEntries(Object.entries(raw).reverse());
    expect(Object.keys(consumeProjectChallengeEvidence(reversed, source)!)).toEqual(Object.keys(emptySummary()));
  });

  it("来源校验不冒充问题分类：纯状态的合法引文仍需语义审阅判错", () => {
    expect(consumeProjectChallengeEvidence(output([issue("工具未发布")]), materials("工具未发布"))?.challenges).toBe("工具未发布");
  });
});
