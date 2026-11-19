import { describe, expect, it } from "vitest";
import { PROJECT_RESUME_SYSTEM_PROMPT, PROJECT_SUMMARY_SYSTEM_PROMPT } from "../project-summary-llm";
import { buildProjectWorkStateSystems, PROJECT_WORK_STATE_ADDITION, projectWorkStateCases } from "../../../evals/project-work-state-fixture";
import { projectPersonalScopeCases } from "../../../evals/project-personal-scope-fixture";
import { projectChallengeBoundaryCases } from "../../../evals/project-challenge-boundaries-fixture";

describe("项目工作状态候选的固定实验契约", () => {
  it.each([
    ["full", PROJECT_SUMMARY_SYSTEM_PROMPT],
    ["resume-only", PROJECT_RESUME_SYSTEM_PROMPT],
  ] as const)("%s只增加一条定义，其余生产文本逐字保留", (_mode, production) => {
    const systems = buildProjectWorkStateSystems(production);
    expect(systems.baseline).toBe(production);
    expect(systems.candidate).toBe(production.replace("工作范围：\n", "工作范围：\n" + PROJECT_WORK_STATE_ADDITION));
    expect(systems.candidate.replace(PROJECT_WORK_STATE_ADDITION, "")).toBe(production);
    expect(systems.candidate.split(PROJECT_WORK_STATE_ADDITION)).toHaveLength(2);
    expect(buildProjectWorkStateSystems(systems.candidate)).toEqual(systems);
  });

  it.each([
    ["missing-heading", (prompt: string) => prompt.replace("工作范围：\n", "工作边界：\n")],
    ["duplicate-heading", (prompt: string) => prompt + "\n工作范围：\n"],
    ["duplicate-definition", (prompt: string) => buildProjectWorkStateSystems(prompt).candidate + PROJECT_WORK_STATE_ADDITION],
    ["misplaced-definition", (prompt: string) => prompt + PROJECT_WORK_STATE_ADDITION],
    ["partial-known-definition", (prompt: string) => prompt.replace("工作范围：\n", "工作范围：\n- 职责分工只说明责任范围，未知变种。\n")],
    ["changed-known-definition", (prompt: string) => buildProjectWorkStateSystems(prompt).candidate.replace("不要求实现者已知", "要求实现者已知")],
  ] as const)("拒绝不能唯一恢复的已知范围定义：%s", (_name, change) => {
    expect(() => buildProjectWorkStateSystems(change(PROJECT_SUMMARY_SYSTEM_PROMPT))).toThrow("requires one known work-scope definition");
  });

  it("六份旧材料和原判据保留，只在流程要求之前增加状态目标", () => {
    const inherited = [...projectPersonalScopeCases, projectChallengeBoundaryCases[1], projectChallengeBoundaryCases[2]];
    expect(projectWorkStateCases).toHaveLength(8);
    inherited.forEach((previous, index) => {
      const current = projectWorkStateCases[index]!;
      expect({ id: current.id, projectName: current.projectName, source: current.source })
        .toEqual({ id: previous.id, projectName: previous.projectName, source: previous.source });
      expect(current.rubric.slice(0, -2)).toEqual(previous.rubric.slice(0, -1));
      expect(current.rubric.at(-1)).toBe(previous.rubric.at(-1));
      expect(current.rubric.at(-2)).toMatch(/^状态直接目标：/);
    });
    expect(projectWorkStateCases.slice(6).map(sample => sample.id)).toEqual([
      "started-work-distinct-from-complete", "implemented-flow-current-role-not-authorship",
    ]);
  });

  it("每种模式均固定覆盖八份材料，形成32个唯一ID与每臂64项模型判据", () => {
    const ids = projectWorkStateCases.flatMap((sample, caseIndex) =>
      (["full", "resume-only"] as const).flatMap((mode, modeIndex) =>
        ((caseIndex + modeIndex) % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"])
          .map(arm => `${sample.id}/${mode}/${arm}`)));
    expect(ids).toHaveLength(32);
    expect(new Set(ids).size).toBe(32);
    expect(projectWorkStateCases.every(sample => sample.rubric.length === 5)).toBe(true);
    expect(projectWorkStateCases.reduce((sum, sample) => sum + sample.rubric.length - 1, 0) * 2).toBe(64);
    expect(projectWorkStateCases.length * 2).toBe(16);
  });
});
