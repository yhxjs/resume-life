import { it } from "vitest";
import { createEvaluationSuite } from "../../../../evals/harness";
import { safeChat, LLM_FEATURES, type SafeMessage } from "@/lib/safe-llm";

// 仅由期限集成测试收集；服务地址由父进程提供，调用目标始终是本地合成 SSE。
const evaluate = createEvaluationSuite("career-gap", 1, 256);
const system = "只返回合成测试数据。";
const messages: SafeMessage[] = [{ role: "user", parts: [{ trust: "untrusted", tag: "source", text: "合成材料" }] }];

it("delayed-answer", () => evaluate({
  id: "delayed-answer", input: { source: "合成材料" }, system, messages,
  rubric: ["仅核对测试报告，协议通过不代表语义通过。"],
  call: options => safeChat("parse", { feature: LLM_FEATURES.gapRemedyGenerate }, system, messages, options),
  validate: value => (value as { accepted?: unknown })?.accepted === true,
}));
