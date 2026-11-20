import { it } from "vitest";
import { buildPolishMessages, validateGeneratedPolishResult } from "@/lib/polish";
import { buildDiagnosisMessages } from "@/lib/diagnosis-llm";
import { sanitizeModulesForDiagnosis, validateGeneratedDiagnosis } from "@/lib/diagnosis";
import { DIAGNOSIS_PRODUCTION_SYSTEM_PROMPT } from "@/lib/diagnosis-production-prompt";
import { buildResumeImportMessages, RESUME_IMPORT_SYSTEM_PROMPT, validateGeneratedResumeImport } from "@/lib/resume-import-llm";
import { LLM_FEATURES, safeChat } from "@/lib/safe-llm";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "@/lib/settings-constants";
import { createEvaluationSuite } from "./harness";
import { RESUME_JOB_SEARCH_CASES, RESUME_JOB_SEARCH_RUBRIC } from "./resume-job-search-fixture";

const evaluate = createEvaluationSuite("resume-job-search", RESUME_JOB_SEARCH_CASES.length, DEFAULT_MAX_OUTPUT_TOKENS);

for (const sample of RESUME_JOB_SEARCH_CASES) {
  it(sample.id, async () => {
    const request = sample.request;
    const shared = { id: sample.id, input: sample, rubric: [...RESUME_JOB_SEARCH_RUBRIC, ...sample.checks] };
    if (request.kind === "polish") {
      const { system, messages } = buildPolishMessages(request.args);
      const sourceCount = request.args.sourceParagraphs?.filter(text => text.trim()).length || (request.args.text.trim() ? 1 : 0);
      await evaluate({ ...shared, system, messages,
        call: opts => safeChat("summary", { feature: LLM_FEATURES.resumePolish }, system, messages, opts),
        validate: value => validateGeneratedPolishResult(value, request.args.context, { sourceCount,
          originalSourceCount: request.args.originalSourceParagraphs?.filter(text => text.trim()).length,
          moduleType: request.args.moduleType, mode: request.args.mode }),
      });
    } else if (request.kind === "diagnosis") {
      const system = `${DIAGNOSIS_PRODUCTION_SYSTEM_PROMPT}\n所有非空文本必须包含可见内容，不用零宽、控制字符或纯标点占位；协议允许的空 gaps 与 suggestions 继续为空。`;
      const messages = buildDiagnosisMessages(request.jd, sanitizeModulesForDiagnosis(request.modules));
      await evaluate({ ...shared, system, messages,
        call: opts => safeChat("evaluate", { feature: LLM_FEATURES.resumeDiagnose }, system, messages, opts),
        validate: value => validateGeneratedDiagnosis(value, request.modules),
      });
    } else {
      const messages = buildResumeImportMessages(request.resumeText);
      await evaluate({ ...shared, system: RESUME_IMPORT_SYSTEM_PROMPT, messages,
        call: opts => safeChat("parse", { feature: LLM_FEATURES.resumeImportParse }, RESUME_IMPORT_SYSTEM_PROMPT, messages, opts),
        validate: value => validateGeneratedResumeImport(value).ok,
      });
    }
  });
}
