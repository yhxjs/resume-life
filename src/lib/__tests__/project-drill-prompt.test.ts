import { describe, expect, it } from "vitest";
import { parseQuestionItems } from "../drills-questions";
import { PROJECT_DRILL_QUESTION_PROMPT } from "../drill-question-llm";
import { REFERENCE_ANSWER_RULES, REFERENCE_FACT_GROUP_RULES } from "../prompt-guidelines";

describe("项目深挖题的个人分工边界", () => {
  it("只在材料未说明参与情况时确认分工，已知职责直接用于提问", () => {
    expect(PROJECT_DRILL_QUESTION_PROMPT).toContain("仅当材料未说明本人是否参与时，才先中性询问是否参与及范围");
    expect(PROJECT_DRILL_QUESTION_PROMPT).toContain("材料已明确本人职责时，直接围绕已知行动提问，不重复确认参与");
  });

  it("项目没有任何已知事实时请求补充一项真实工作，不伪造题目背景", () => {
    expect(PROJECT_DRILL_QUESTION_PROMPT).toContain("当项目档案和材料都没有可用于题干的已确认项目工作或行动时");
    expect(PROJECT_DRILL_QUESTION_PROMPT).toContain("即使 materials 数组非空，若其中只有待填写模板或没有工作记录，也适用");
    expect(PROJECT_DRILL_QUESTION_PROMPT).toContain("覆盖上文要求以已确认职责或行动为背景");
    expect(PROJECT_DRILL_QUESTION_PROMPT).toContain("新补充不作为已知经历或独立核实依据");
  });

  it("零工作澄清保留明确的未参与和项目状态，不改写成未知", () => {
    expect(PROJECT_DRILL_QUESTION_PROMPT).toContain("若档案或材料明确记录项目状态或本人未参与某项工作，须将这些否定状态按已知事实保留");
    expect(PROJECT_DRILL_QUESTION_PROMPT).toContain("不得说档案和材料未提供该状态，也不得重复询问已明确的参与情况");
    expect(PROJECT_DRILL_QUESTION_PROMPT).toContain("是否另有与已知状态相容、可确认的项目工作");
  });

  it("首项事实澄清题符合生产题目合同且空题单仍被拒绝", () => {
    expect(parseQuestionItems(JSON.stringify({ questions: ["能否补充一项可确认的项目工作，并说明你的参与范围？"] }), { maxCount: 4, project: true }))
      .toEqual([{ question: "能否补充一项可确认的项目工作，并说明你的参与范围？", kind: "" }]);
    expect(() => parseQuestionItems(JSON.stringify({ questions: [] }), { maxCount: 4, project: true })).toThrow("题目数量必须在 1 到本次请求上限之间");
  });

  it("按本题采用的职责或动作取参考事实组，不扩展到同项目的独立工作", () => {
    expect(REFERENCE_FACT_GROUP_RULES).toContain("按题干实际涉及的职责、动作或明确更正范围确定真实项目和事实组");
    expect(REFERENCE_FACT_GROUP_RULES).toContain("同项目中其他独立且与本题无关的事项不带入");
    expect(REFERENCE_FACT_GROUP_RULES).toContain("组内完整保留已知的本人动作、职责范围、权限、他人分工及完成、验证、发布、收益状态");
    expect(REFERENCE_ANSWER_RULES).toContain("只保留与本题要求相关且有来源的事实");
    expect(REFERENCE_ANSWER_RULES).toContain("不带入同一项目中与本题无关的独立工作");
  });
});
