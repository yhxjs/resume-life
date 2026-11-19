import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directories: string[] = [];
type Scenario = "complete" | "skipped" | "all-skipped" | "missing" | "extra" | "wrong-suite" | "wrong-mode" | "invalid-json" | "incomplete" | "zero-samples" | "child-failed";

async function runEntry(vision: boolean, scenario: Scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-eval-entry-"));
  directories.push(root);
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(scripts);
  const entry = vision ? "eval-vision.mjs" : "eval-prompts.mjs";
  for (const file of [entry, "check-runtime.mjs", "eval-completion.mjs", "eval-selection.mjs"]) {
    const source = path.resolve("scripts", file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(scripts, file));
  }
  const config = path.join(root, "fixture.config.mjs");
  fs.writeFileSync(config, `export default ${JSON.stringify({
    root: process.cwd(),
    resolve: { alias: { "@": path.resolve("src") } },
    test: { include: ["src/lib/__tests__/fixtures/prompt-eval-completeness.fixture.ts"], environment: "node", maxWorkers: 1 },
  })};`);
  const childDirectory = path.join(root, "node_modules/vitest");
  fs.mkdirSync(childDirectory, { recursive: true });
  fs.writeFileSync(path.join(childDirectory, "vitest.mjs"), `
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const scenario = ${JSON.stringify(scenario)};
const output = process.env.${vision ? "VISION_EVAL_OUTPUT" : "PROMPT_EVAL_OUTPUT"};
const synthetic = ["wrong-suite", "wrong-mode", "invalid-json", "incomplete", "zero-samples", "child-failed"].includes(scenario);
if (synthetic) {
  fs.writeFileSync(path.join(output, "summary.json"), scenario === "invalid-json" ? "{invalid" : JSON.stringify({
    suite: scenario === "wrong-suite" ? "another-suite" : ${JSON.stringify(vision ? "vision-ocr" : "project")},
    mode: scenario === "wrong-mode" ? "live" : "snapshot", status: scenario === "incomplete" ? "incomplete" : "completed",
    expectedSamples: scenario === "incomplete" ? 2 : scenario === "zero-samples" ? 0 : 1,
    recordedSamples: scenario === "zero-samples" ? 0 : 1, missingSamples: scenario === "incomplete" ? 1 : 0,
    results: scenario === "zero-samples" ? [] : [{ id: "synthetic", protocol: "not-run" }],
  }));
  process.exitCode = scenario === "child-failed" ? 7 : 0;
} else {
  const child = spawn(process.execPath, [${JSON.stringify(path.resolve("node_modules/vitest/vitest.mjs"))}, "run", "--config", ${JSON.stringify(config)}, "--reporter=json", "--outputFile", path.join(output, "vitest.json")], {
    stdio: "inherit", windowsHide: true,
    env: { ...process.env, PROMPT_EVAL_COMPLETENESS_TEST: scenario, PROMPT_EVAL_ARTIFACT_TEST_VISION: ${JSON.stringify(vision ? "1" : "0")} },
  });
  child.on("error", () => { process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
}
`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(PROMPT|VISION)_EVAL_/.test(name)) delete env[name];
  const child = spawn(process.execPath, [path.join(scripts, entry), ...(vision ? [] : ["--suite=project"])], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env,
  });
  let text = "";
  child.stdout.on("data", chunk => { text += chunk; });
  child.stderr.on("data", chunk => { text += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Evaluation entry fixture exceeded 20s")); }, 20_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", status => { clearTimeout(timeout); resolve(status); });
  });
  const output = text.match(/(?:提示词快照（零模型调用）|视觉评估目录)：([^\r\n]+)/)?.[1];
  expect(output, text).toBeTruthy();
  directories.push(output!);
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(output!, name), "utf8"));
  return { code, text, output: output!, read };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !/^resume-life-(?:eval-entry|prompt-eval|vision-eval)-/.test(path.basename(target))) throw new Error("Unsafe evaluation fixture cleanup");
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("评测入口核对本轮汇总", () => {
  it.each([false, true].flatMap(vision => (["complete", "skipped", "all-skipped", "missing", "extra"] as const).map(scenario => ({ vision, scenario }))))(
    "真实 Vitest 生命周期 $scenario，vision=$vision", async ({ vision, scenario }) => {
      const result = await runEntry(vision, scenario);
      expect.soft(result.code, result.text).toBe(scenario === "complete" ? 0 : 1);
      if (scenario === "all-skipped") {
        expect(result.read("vitest.json")).toMatchObject({ success: true, numPendingTests: 2 });
        expect(fs.existsSync(path.join(result.output, "summary.json"))).toBe(false);
      } else {
        expect(result.read("summary.json")).toMatchObject({ status: scenario === "complete" ? "completed" : "incomplete" });
        expect(result.read("first.json")).toMatchObject({ id: "first", raw: null, protocol: "not-run" });
      }
      expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
    }, 25_000,
  );

  it.each([false, true].flatMap(vision => (["wrong-suite", "wrong-mode", "invalid-json", "incomplete", "zero-samples", "child-failed"] as const).map(scenario => ({ vision, scenario }))))(
    "汇总身份或内容异常不成功、保留子进程失败码：$scenario，vision=$vision", async ({ vision, scenario }) => {
      const result = await runEntry(vision, scenario);
      expect(result.code, result.text).toBe(scenario === "child-failed" ? 7 : 1);
      expect(fs.existsSync(path.join(result.output, "summary.json"))).toBe(true);
    }, 25_000,
  );
});
