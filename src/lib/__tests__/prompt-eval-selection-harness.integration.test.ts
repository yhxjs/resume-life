import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluationExitCode } from "../../../scripts/eval-completion.mjs";

const directories: string[] = [];
type Mode = "complete" | "missing" | "wrong-id" | "duplicate-record" | "duplicate-registration" | "skip" | "todo";

function createOutput() {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-prompt-eval-selection-"));
  directories.push(output);
  return output;
}

async function runFixture({
  ids, mode = "complete", live = false, rawSelection,
}: { ids?: string[]; mode?: Mode; live?: boolean; rawSelection?: string } = {}) {
  const output = createOutput();
  const config = path.join(output, "vitest.config.mjs");
  fs.writeFileSync(config, `export default ${JSON.stringify({
    root: process.cwd(), resolve: { alias: { "@": path.resolve("src") } },
    test: {
      include: ["src/lib/__tests__/fixtures/prompt-eval-selection.fixture.ts"],
      environment: "node", maxWorkers: 1,
      // 固定测试 ID 不含正则元字符；不复用生产选择 helper 来掩盖匹配问题。
      ...(ids?.length ? { testNamePattern: `^(?:${ids.join("|")})$` } : {}),
    },
  })};`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("PROMPT_EVAL_")) delete env[name];
  const child = spawn(process.execPath, [
    path.resolve("node_modules/vitest/vitest.mjs"), "run", "--config", config,
    "--reporter=json", "--outputFile", path.join(output, "vitest.json"),
  ], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env, PROMPT_EVAL_OUTPUT: output, PROMPT_EVAL_LIVE: live ? "1" : "0",
      ...(rawSelection === undefined && ids === undefined ? {} : {
        PROMPT_EVAL_SAMPLE_IDS: rawSelection ?? JSON.stringify(ids),
      }),
      PROMPT_EVAL_SELECTION_TEST_MODE: mode,
      PROMPT_EVAL_MODEL: "synthetic-model", PROMPT_EVAL_API_FORMAT: "openai_chat",
      PROMPT_EVAL_BASE_URL: "https://synthetic.invalid/v1",
      PROMPT_EVAL_API_KEY: "synthetic-selection-key-not-a-real-credential",
      RESUME_LIFE_DATA_DIR: path.join(output, "data"),
      RESUME_LIFE_SETTINGS_KEY: randomBytes(32).toString("hex"),
    },
  });
  let text = "";
  child.stdout.on("data", chunk => { text += chunk; });
  child.stderr.on("data", chunk => { text += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Selection fixture exceeded 20s")); }, 20_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", status => { clearTimeout(timer); resolve(status); });
  });
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(output, `${name}.json`), "utf8"));
  return { output, code, text, read };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("resume-life-prompt-eval-selection-")) {
      throw new Error("Unsafe selection fixture cleanup path");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("选择样本的真实 harness 生命周期（合成调用）", () => {
  it.each([false, true])("选择范围保持 CLI 顺序元数据和套件执行顺序，live=%s", async live => {
    const result = await runFixture({ ids: ["beta", "alpha"], live });
    expect(result.code, result.text).toBe(0);
    const summary = result.read("summary");
    expect(summary).toMatchObject({
      expectedSamples: 2, recordedSamples: 2, missingSamples: 0, status: "completed",
      selection: { suiteSamples: 3, requestedIds: ["beta", "alpha"] },
      protocolCounts: live ? { "not-run": 0, pass: 2, fail: 0, error: 0 } : { "not-run": 2, pass: 0, fail: 0, error: 0 },
    });
    expect(summary.results.map((entry: { id: string }) => entry.id)).toEqual(["alpha", "beta"]);
    expect(result.read("observations")).toEqual({ entered: ["alpha", "beta"], called: live ? ["alpha", "beta"] : [] });
    expect(fs.existsSync(path.join(result.output, "gamma.json"))).toBe(false);
    if (!live) expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
  }, 25_000);

  it.each([{ ids: undefined }, { ids: [] as string[] }])("默认全套保持原计数且不新增 selection 元数据：%j", async ({ ids }) => {
    const result = await runFixture({ ids });
    expect(result.code, result.text).toBe(0);
    const summary = result.read("summary");
    expect(summary).toMatchObject({ expectedSamples: 3, recordedSamples: 3, missingSamples: 0, status: "completed" });
    expect(summary).not.toHaveProperty("selection");
    expect(summary.results.map((entry: { id: string }) => entry.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(result.read("observations")).toEqual({ entered: ["alpha", "beta", "gamma"], called: [] });
    expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
  }, 25_000);

  it.each(["missing", "wrong-id", "duplicate-record"] as const)("所选回调%s不能用计数掩盖缺失或错误 ID", async mode => {
    const result = await runFixture({ ids: ["alpha", "beta"], mode, live: true });
    expect(result.code, result.text).toBe(1);
    expect(result.read("summary")).toMatchObject({
      expectedSamples: 2, recordedSamples: 1, missingSamples: 1, status: "incomplete",
      selection: { suiteSamples: 3, requestedIds: ["alpha", "beta"] }, results: [{ id: "alpha" }],
    });
    expect(result.read("observations")).toEqual({ entered: ["alpha", "beta"], called: ["alpha"] });
    expect(fs.existsSync(path.join(result.output, "beta.json"))).toBe(false);
    expect(fs.existsSync(path.join(result.output, "gamma.json"))).toBe(false);
  }, 25_000);

  it.each(["duplicate-registration", "skip", "todo"] as const)("所选注册项%s在任何回调和 settings 写入前拒绝", async mode => {
    const result = await runFixture({ ids: ["alpha", "beta"], mode, live: true });
    expect(result.code, result.text).toBe(1);
    expect(result.read("observations")).toEqual({ entered: [], called: [] });
    expect(result.read("summary")).toMatchObject({ status: "incomplete", recordedSamples: 0, missingSamples: 2 });
    expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
  }, 25_000);

  it("已知与未知 ID 混选在有效样本调用前失败", async () => {
    const result = await runFixture({ ids: ["alpha", "unknown"], live: true });
    expect(result.code, result.text).toBe(1);
    expect(result.read("observations")).toEqual({ entered: [], called: [] });
    expect(result.read("summary")).toMatchObject({ status: "incomplete", recordedSamples: 0 });
    expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
  }, 25_000);

  it.each(["null", "{}", '"alpha"', '["alpha",null]', '["alpha","alpha"]', '["alpha","ALPHA"]', '["a/b","a-b"]', '["summary"]', "not-json"])(
    "直接内部选择环境值 %s 也必须在 settings 前校验", async rawSelection => {
      const result = await runFixture({ live: true, rawSelection });
      expect(result.code, result.text).toBe(1);
      expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
      expect(fs.existsSync(path.join(result.output, "alpha.json"))).toBe(false);
    }, 25_000,
  );
});

describe("父入口 completion 核对本次选择身份", () => {
  const requestedIds = ["beta", "alpha"];
  function completeSummary() {
    return {
      suite: "project", mode: "snapshot", status: "completed",
      expectedSamples: 2, recordedSamples: 2, missingSamples: 0,
      selection: { suiteSamples: 3, requestedIds: [...requestedIds] },
      results: [{ id: "alpha", protocol: "not-run" }, { id: "beta", protocol: "not-run" }],
    };
  }

  function check(summary: unknown, selection = requestedIds, code: number | null = 0) {
    const output = createOutput();
    fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary));
    vi.spyOn(console, "error").mockImplementation(() => {});
    return evaluationExitCode(code, { output, suite: "project", live: false, requestedIds: selection });
  }

  it("接受注册顺序结果，且保留非零子进程退出码", () => {
    expect(check(completeSummary())).toBe(0);
    expect(check(completeSummary(), requestedIds, 7)).toBe(7);
    expect(check(completeSummary(), requestedIds, null)).toBe(1);
  });

  it.each([
    { title: "同数目的其他 ID", ids: ["alpha", "gamma"] },
    { title: "重复结果 ID", ids: ["alpha", "alpha"] },
    { title: "结果大小写改变", ids: ["alpha", "Beta"] },
    { title: "结果 ID 缺失", ids: ["alpha", undefined] },
  ])("拒绝计数完整但$title的结果", ({ ids }) => {
    const summary = { ...completeSummary(), results: ids.map(id => ({ id, protocol: "not-run" })) };
    expect(check(summary)).toBe(1);
  });

  it.each([
    undefined,
    { suiteSamples: 3, requestedIds: ["alpha", "beta"] },
    { suiteSamples: 3, requestedIds: ["beta", "gamma"] },
    { suiteSamples: 3, requestedIds: ["beta", "beta"] },
    { suiteSamples: 1, requestedIds },
    { suiteSamples: 2.5, requestedIds },
  ])("拒绝缺失或伪造的选择元数据 %j", selection => {
    expect(check({ ...completeSummary(), selection })).toBe(1);
  });

  it("无选择模式不接受被环境偷偷缩小的 selection 汇总", () => {
    expect(check(completeSummary(), [])).toBe(1);
    const summary = Object.fromEntries(Object.entries(completeSummary()).filter(([key]) => key !== "selection"));
    expect(check(summary, [])).toBe(0);
  });
});
