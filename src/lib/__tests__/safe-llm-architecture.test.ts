import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });
const controlledFile = "src/app/api/__guard-probe__/route.ts";
const productionLocations = [
  { name: "plain lib helper", filePath: "src/lib/model-client.ts", relativeSource: "./llm" },
  {
    name: "component",
    filePath: "src/components/model-probe.tsx",
    relativeSource: "../lib/llm",
  },
  {
    name: "other production helper",
    filePath: "src/features/model-helper.ts",
    relativeSource: "../lib/llm",
  },
] as const;

const productionImportCases = productionLocations.flatMap((location) => [
  [`${location.name} alias extensionless`, location.filePath, "@/lib/llm"],
  [`${location.name} alias with extension`, location.filePath, "@/lib/llm.js"],
  [`${location.name} relative extensionless`, location.filePath, location.relativeSource],
  [`${location.name} relative with extension`, location.filePath, `${location.relativeSource}.js`],
] as const);

let cachedWarmUp: ESLint.LintResult | null = null;

/** ESLint 首次 lint 要建缓存，被抢 CPU 时可能远超常规耗时。
 *  放在用例内而非 beforeAll：hook 超时会把整个文件的用例判跳过，用例超时只影响自己。
 *  预热只做一次，其余用例经 guardRuleIds 复用同一结果。 */
async function warmUp(): Promise<ESLint.LintResult> {
  if (cachedWarmUp) return cachedWarmUp;
  const [result] = await eslint.lintText("void 0;", { filePath: controlledFile });
  cachedWarmUp = result!;
  return result!;
}

async function guardRuleIds(code: string, filePath = controlledFile) {
  await warmUp();
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages
    .map((message) => message.ruleId)
    .filter((ruleId): ruleId is string =>
      ruleId === "no-restricted-imports" || ruleId === "no-restricted-syntax"
    );
}

describe("safe LLM ESLint architecture guard", () => {
  it("预热 ESLint 缓存：无害代码不触发任何守卫规则", async () => {
    const result = await warmUp();

    // void 0 既不导入 llm 也不调用 req.json，任何 no-restricted-* 命中都说明选择器写得过宽
    expect(result.messages.filter((message) => message.ruleId?.startsWith("no-restricted"))).toEqual([]);
  }, 60_000);

  it.each([
    ["alias", "@/lib/llm"],
    ["relative", "../../../lib/llm"],
  ])("rejects a normal named static import through %s resolution", async (_name, source) => {
    const rules = await guardRuleIds(`import { chat } from "${source}";\nvoid chat;`);

    expect(rules).toContain("no-restricted-imports");
  });

  it.each([
    ["alias", "@/lib/llm.js"],
    ["relative", "../../../lib/llm.js"],
  ])("rejects a .js named static import through %s resolution", async (_name, source) => {
    const rules = await guardRuleIds(`import { chatStream } from "${source}";\nvoid chatStream;`);

    expect(rules).toContain("no-restricted-imports");
  });

  it.each([
    ["alias extensionless", "@/lib/llm"],
    ["alias with extension", "@/lib/llm.js"],
    ["relative extensionless", "../../../lib/llm"],
    ["relative with extension", "../../../lib/llm.js"],
  ])("rejects a dynamic import through %s resolution", async (_name, source) => {
    const rules = await guardRuleIds(
      `const { chatStream } = await import("${source}");\nvoid chatStream;`,
    );

    expect(rules).toContain("no-restricted-syntax");
  });

  it("allows safe-llm to import the underlying model functions", async () => {
    const rules = await guardRuleIds(
      'import { chat } from "./llm";\nconst { chatStream } = await import("./llm.js");\nvoid chat;\nvoid chatStream;',
      "src/lib/safe-llm.ts",
    );

    expect(rules).toEqual([]);
  });

  it.each(productionImportCases)(
    "rejects static model calls from %s",
    async (_name, filePath, source) => {
      const rules = await guardRuleIds(
        `import { chat } from "${source}";\nvoid chat;`,
        filePath,
      );

      expect(rules).toContain("no-restricted-imports");
    },
  );

  it.each(productionImportCases)(
    "rejects dynamic model calls from %s",
    async (_name, filePath, source) => {
      const rules = await guardRuleIds(
        `const { chatStream } = await import("${source}");\nvoid chatStream;`,
        filePath,
      );

      expect(rules).toContain("no-restricted-syntax");
    },
  );

  it.each([
    "src/lib/__tests__/llm-input-budget.test.ts",
    "src/lib/llm-direct.test.ts",
    "src/components/model-probe.spec.tsx",
  ])("allows direct underlying model imports in test code at %s", async (filePath) => {
    const rules = await guardRuleIds(
      'import { chat } from "@/lib/llm";\nconst { chatStream } = await import("@/lib/llm.js");\nvoid chat;\nvoid chatStream;',
      filePath,
    );

    expect(rules).toEqual([]);
  });

  it("allows non-call exports from the underlying model module", async () => {
    const rules = await guardRuleIds(
      'import { extractJson, LlmConfigError, type LlmTask } from "@/lib/llm.js";\nvoid extractJson;\nvoid LlmConfigError;\nconst task: LlmTask = "parse";\nvoid task;',
      "src/lib/model-client.ts",
    );

    expect(rules).toEqual([]);
  });
});
