import { afterAll, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createEvaluationSuite } from "../../../../evals/harness";

// 仅供外层子进程测试；回调返回合成 JSON，不访问任何模型或网络。
const mode = process.env.PROMPT_EVAL_SELECTION_TEST_MODE;
const evaluate = createEvaluationSuite("project", 3, 100);
const entered: string[] = [];
const called: string[] = [];

async function run(id: string) {
  entered.push(id);
  if (id === "beta" && mode === "missing") return;
  const recordedId = id === "beta" && mode === "wrong-id" ? "gamma"
    : id === "beta" && mode === "duplicate-record" ? "alpha" : id;
  await evaluate({
    id: recordedId, input: { source: id }, system: "只使用合成材料。",
    messages: [{ role: "user", parts: [{ trust: "untrusted", tag: "source", text: id }] }],
    rubric: ["人工核对完整原文，不由协议通过推断质量。"],
    call: async () => {
      called.push(recordedId);
      return JSON.stringify({ id: recordedId });
    },
    validate: value => (value as { id: string }).id === recordedId,
  });
}

it("alpha", () => run("alpha"));
if (mode === "skip") it.skip("beta", () => run("beta"));
else if (mode === "todo") it.todo("beta");
else it("beta", () => run("beta"));
if (mode === "duplicate-registration") it("beta", () => run("beta"));
it("gamma", () => run("gamma"));

afterAll(() => {
  fs.writeFileSync(path.join(process.env.PROMPT_EVAL_OUTPUT!, "observations.json"), JSON.stringify({ entered, called }));
});
