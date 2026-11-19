import { afterAll, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createEvaluationSuite } from "../../../../evals/harness";

// 仅供外层集成测试启动；正常测试与真实评估入口均不收集此文件。
const ids = ["valid", "oversized", "invalid-tag", "call-error", "invalid-json", "rejected", "validator-error"];
const evaluate = createEvaluationSuite("project", ids.length, 3200);
const called: string[] = [];
const validated: string[] = [];

for (const id of ids) {
  it(id, async () => {
    const source = id === "oversized" ? "<".repeat(16_000) : "本人参与接口测试，尚未上线。";
    await evaluate({
      id, input: { source }, system: "只使用材料中的事实。",
      messages: [{ role: "user", parts: [{ trust: "untrusted", tag: id === "invalid-tag" ? "invalid-tag" : "source", text: source }] }],
      rubric: ["核对个人分工与项目状态，不将协议通过视为语义通过。"],
      call: async () => {
        called.push(id);
        if (id === "call-error") throw new TypeError("synthetic-private-call-error-do-not-copy");
        return id === "invalid-json" ? "{invalid-json" : JSON.stringify({ accepted: id !== "rejected" });
      },
      validate: value => {
        validated.push(id);
        if (id === "validator-error") throw new RangeError("synthetic-private-validation-error-do-not-copy");
        return (value as { accepted: boolean }).accepted;
      },
    });
  });
}

afterAll(() => {
  fs.writeFileSync(path.join(process.env.PROMPT_EVAL_OUTPUT!, "observations.json"), JSON.stringify({ called, validated }));
});
