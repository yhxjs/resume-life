import { it } from "vitest";
import { createEvaluationSuite } from "../../../../evals/harness";
import { createVisionEvaluationSuite } from "../../../../evals/vision-harness";

// 仅由外层隔离测试运行；两种 harness 分别注册自己的 afterAll 汇总检查。
const completeness = process.env.PROMPT_EVAL_COMPLETENESS_TEST;
const expected = completeness === "extra" ? 1 : 2;
const vision = process.env.PROMPT_EVAL_ARTIFACT_TEST_VISION === "1";
const textEvaluation = vision ? null : createEvaluationSuite("project", expected, 100);
const visionEvaluation = vision ? createVisionEvaluationSuite(expected) : null;

async function evaluate(id: string) {
  if (visionEvaluation) {
    await visionEvaluation({
      id, system: "Transcribe the sample.",
      pages: [{ pageNumber: 1, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><text x="2" y="20">Sample</text></svg>' }],
      referenceText: "Sample", rubric: ["人工核对转录"],
    });
  } else {
    await textEvaluation!({
      id, input: { source: "合成材料" }, system: "只检查提示组装。",
      messages: [{ role: "user", parts: [{ trust: "untrusted", tag: "source", text: "合成材料" }] }],
      rubric: ["人工核对原文"],
      call: async () => { throw new Error("Snapshot must not call a model"); },
      validate: () => true,
    });
  }
}

it.skipIf(completeness === "all-skipped")("first sample", () => evaluate("first"));
it.skipIf(completeness === "skipped" || completeness === "all-skipped")("second sample", async () => {
  if (completeness === "missing") return;
  await evaluate("second");
});
