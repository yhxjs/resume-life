import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { DEFAULT_EVALUATION_TIMEOUT_MS, EVALUATION_TEST_GRACE_MS, parseEvaluationTimeoutMs } from "./timeout";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  test: {
    include: [
      process.env.PROMPT_EVAL_SUITE === "project" ? "evals/project.eval.ts"
        : process.env.PROMPT_EVAL_SUITE === "project-challenge-boundaries" ? "evals/project-challenge-boundaries.eval.ts"
        : process.env.PROMPT_EVAL_SUITE === "project-personal-scope" ? "evals/project-personal-scope.eval.ts"
        : process.env.PROMPT_EVAL_SUITE === "project-challenge-order" ? "evals/project-challenge-order.eval.ts"
        : process.env.PROMPT_EVAL_SUITE === "project-challenge-evidence" ? "evals/project-challenge-evidence.eval.ts"
        : process.env.PROMPT_EVAL_SUITE === "project-work-state" ? "evals/project-work-state.eval.ts"
        : process.env.PROMPT_EVAL_SUITE === "project-challenge-admission" ? "evals/project-challenge-admission.eval.ts"
        : process.env.PROMPT_EVAL_SUITE === "project-architecture-evidence" ? "evals/project-architecture-evidence.eval.ts"
        : process.env.PROMPT_EVAL_SUITE === "project-independent-achievement" ? "evals/project-independent-achievement.eval.ts"
        : process.env.PROMPT_EVAL_SUITE === "project-summary-field-boundaries" ? "evals/project-summary-field-boundaries.eval.ts"
        : process.env.PROMPT_EVAL_SUITE === "project-summary-field-repair" ? "evals/project-summary-field-repair.eval.ts"
        : process.env.PROMPT_EVAL_SUITE === "project-summary-challenge-status" ? "evals/project-summary-challenge-status.eval.ts"
        : process.env.PROMPT_EVAL_SUITE === "project-summary-evidence-ledger" ? "evals/project-summary-evidence-ledger.eval.ts"
        : process.env.PROMPT_EVAL_SUITE === "project-summary-archive-conflict" ? "evals/project-summary-archive-conflict.eval.ts"
        : process.env.PROMPT_EVAL_SUITE === "evaluator" ? "evals/evaluator.eval.ts"
          : process.env.PROMPT_EVAL_SUITE === "interview" ? "evals/interview.eval.ts"
          : process.env.PROMPT_EVAL_SUITE === "interview-retry" ? "evals/interview-retry.eval.ts"
            : process.env.PROMPT_EVAL_SUITE === "interview-reverse" ? "evals/interview-reverse.eval.ts"
              : process.env.PROMPT_EVAL_SUITE === "interview-reference" ? "evals/interview-reference.eval.ts"
                : process.env.PROMPT_EVAL_SUITE === "interview-finish" ? "evals/interview-finish.eval.ts"
                  : process.env.PROMPT_EVAL_SUITE === "interview-remediation-create" ? "evals/interview-remediation-create.eval.ts"
                    : process.env.PROMPT_EVAL_SUITE === "interview-series-answer" ? "evals/interview-series-answer.eval.ts"
                      : process.env.PROMPT_EVAL_SUITE === "drill-answer" ? "evals/drill-answer.eval.ts"
                : process.env.PROMPT_EVAL_SUITE === "application-interview-review" ? "evals/application-interview-review.eval.ts"
                  : process.env.PROMPT_EVAL_SUITE === "interview-series-advance" ? "evals/interview-series-advance.eval.ts"
                  : process.env.PROMPT_EVAL_SUITE === "interview-series-finalize" ? "evals/interview-series-finalize.eval.ts"
                    : process.env.PROMPT_EVAL_SUITE === "project-drill-create" ? "evals/project-drill-create.eval.ts"
                      : process.env.PROMPT_EVAL_SUITE === "project-eval-reference-scope" ? "evals/project-eval-reference-scope.eval.ts"
                        : process.env.PROMPT_EVAL_SUITE === "bank-drill-create" ? "evals/bank-drill-create.eval.ts"
            : process.env.PROMPT_EVAL_SUITE === "repo" ? "evals/repo.eval.ts"
              : process.env.PROMPT_EVAL_SUITE === "repo-scan" ? "evals/repo-scan.eval.ts"
              : process.env.PROMPT_EVAL_SUITE === "salary" ? "evals/salary.eval.ts"
                : process.env.PROMPT_EVAL_SUITE === "defense" ? "evals/defense.eval.ts"
                : process.env.PROMPT_EVAL_SUITE === "defense-drill" ? "evals/defense-drill.eval.ts"
                  : process.env.PROMPT_EVAL_SUITE === "jargon-decoder" ? "evals/jargon-decoder.eval.ts"
                    : process.env.PROMPT_EVAL_SUITE === "style-generation" ? "evals/style-generation.eval.ts"
                  : process.env.PROMPT_EVAL_SUITE === "diagnosis" ? "evals/diagnosis.eval.ts"
                    : process.env.PROMPT_EVAL_SUITE === "polish" ? "evals/polish.eval.ts"
                      : process.env.PROMPT_EVAL_SUITE === "import" ? "evals/import.eval.ts"
                        : process.env.PROMPT_EVAL_SUITE === "jd-portrait" ? "evals/jd-portrait.eval.ts"
                            : process.env.PROMPT_EVAL_SUITE === "career-gap" ? "evals/career-gap.eval.ts"
                            : "evals/intro.eval.ts",
    ],
    environment: "node",
    maxWorkers: 1,
    // 无效配置由 harness 写入不完整报告，不能在加载配置时提前终止。
    testTimeout: (parseEvaluationTimeoutMs(process.env.PROMPT_EVAL_TIMEOUT_MS) ?? DEFAULT_EVALUATION_TIMEOUT_MS) + EVALUATION_TEST_GRACE_MS,
  },
});
