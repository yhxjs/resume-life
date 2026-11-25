import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canArchiveDiagnosisSnapshot } from "../diagnosis-history";
import { sanitizeModulesForDiagnosis, type DiagnosisSnapshot } from "../diagnosis";
import { buildDiagnosisMessages } from "../diagnosis-llm";
import type { ModuleData } from "../modules";
import { assertResumeModelModules } from "../resume-model-material";
import { checkSafeModelInput } from "../safe-llm";

const ids = ["language-alternative-python-evidence", "language-conjunction-python-evidence"];
type Sample = {
  id: string;
  input: { jd: string; snapshot: DiagnosisSnapshot; modules: ModuleData[] };
  assembledMessages: { role: string; content: string }[];
  rubric: string[];
  semanticReviewItems: { criterion: string; verdict: string; evidence: string }[];
  protocol: string;
  raw: string | null;
  observedHttpStatuses: number[];
  observedUsage: unknown;
};
let output: string | undefined;
let samples: Sample[];

function samplePair(): [Sample, Sample] {
  const [alternative, conjunction] = samples;
  if (!alternative || !conjunction) throw new Error("缺少完整的诊断语言要求对照");
  return [alternative, conjunction];
}

beforeAll(async () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:PROMPT_EVAL_|VISION_EVAL_)/.test(key)) delete env[key];
  }
  const child = spawn(process.execPath, [
    path.resolve("scripts/eval-prompts.mjs"), "--suite=diagnosis", ...ids.map(id => `--sample=${id}`),
  ], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
  let log = "";
  child.stdout.on("data", chunk => { log += chunk; });
  child.stderr.on("data", chunk => { log += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("诊断语言要求快照超过 20 秒"));
    }, 20_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", status => { clearTimeout(timer); resolve(status); });
  });
  output = log.match(/提示词快照（零模型调用）：([^\r\n]+)/)?.[1]?.trim();
  expect(code, log).toBe(0);
  expect(output, log).toBeDefined();
  const summary = JSON.parse(fs.readFileSync(path.join(output!, "summary.json"), "utf8"));
  expect(summary).toMatchObject({
    status: "completed", mode: "snapshot", expectedSamples: 2, recordedSamples: 2,
    semanticQuality: "not-evaluated",
    protocolCounts: { "not-run": 2, pass: 0, fail: 0, error: 0 },
    selection: { suiteSamples: 11, requestedIds: ids },
  });
  expect(summary.results.map((result: { id: string }) => result.id)).toEqual(ids);
  expect(fs.existsSync(path.join(output!, "data"))).toBe(false);
  samples = ids.map(id => JSON.parse(fs.readFileSync(path.join(output!, `${id}.json`), "utf8")) as Sample);
}, 30_000);

afterAll(() => {
  if (!output) return;
  const absolute = path.resolve(output);
  if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith("resume-life-prompt-eval-")) {
    throw new Error("拒绝清理非评测临时目录");
  }
  fs.rmSync(absolute, { recursive: true, force: true });
});

describe("诊断语言替代与同时要求的受控评测材料", () => {
  it("两例共用可归档的 Python 材料，JD 和实际模型消息仅改变一个连接词", () => {
    const [alternative, conjunction] = samplePair();
    expect(alternative.input.jd).toBe("开发工程师，要求具备 Go 或 Python 实际开发经验。");
    expect(conjunction.input.jd).toBe(alternative.input.jd.replace(" 或 ", " 和 "));
    expect(conjunction.input.snapshot).toEqual(alternative.input.snapshot);
    expect(conjunction.input.modules).toEqual(alternative.input.modules);
    expect(alternative.input.snapshot.modules).toEqual([
      { key: "work", type: "work", label: "工作经历", sort: 0, content: [
        { id: "python-tool", company: "示例公司", title: "开发工程师", start: "2024-01", end: "2024-12",
          description: "使用 Python 编写 CSV 文件校验工具，实现字段校验和错误行报告；本人负责该工具的开发与单元测试，工具供团队内部使用。",
          subItems: [], descriptionItems: [], descriptionStyle: "unordered" },
      ] },
      { key: "skills", type: "skills", label: "技能", sort: 1, content: { items: ["Python：编写文件校验工具与单元测试"] } },
    ]);
    for (const sample of samples) {
      expect(canArchiveDiagnosisSnapshot(sample.input.snapshot)).toBe(true);
      expect(() => assertResumeModelModules(sample.input.snapshot.modules)).not.toThrow();
      const modelModules = sanitizeModulesForDiagnosis(sample.input.snapshot.modules);
      expect(sample.input.modules).toEqual(modelModules);
      expect(sample.assembledMessages.slice(1)).toEqual(checkSafeModelInput("", buildDiagnosisMessages(sample.input.jd, modelModules)).slice(1));
    }
    const expectedMessages = structuredClone(alternative.assembledMessages);
    const userMessage = expectedMessages[1];
    if (!userMessage) throw new Error("缺少实际模型用户消息");
    userMessage.content = userMessage.content.replace(alternative.input.jd, conjunction.input.jd);
    expect(conjunction.assembledMessages).toEqual(expectedMessages);
  });

  it("审阅判据保留替代与同时要求的差别，且不进入模型消息或冒充模型结果", () => {
    const [alternative, conjunction] = samplePair();
    expect(alternative.rubric[3]).toContain("不得将 Go 未展示列为尚未满足的硬性要求");
    expect(conjunction.rubric[3]).toContain("Go 开发经验尚未展示");
    expect(alternative.rubric.slice(4)).toEqual(conjunction.rubric.slice(4));
    for (const sample of samples) {
      expect(sample.rubric).toHaveLength(6);
      expect(sample.rubric[4]).toContain("Go 未展示不等于不会");
      expect(sample.rubric[5]).toContain("不强制两份对照同分或不同分");
      for (const criterion of sample.rubric) {
        expect(sample.assembledMessages.map(message => message.content).join("\n")).not.toContain(criterion);
      }
      expect(sample.semanticReviewItems).toEqual(sample.rubric.map(criterion => ({ criterion, verdict: "pending", evidence: "" })));
      expect(sample.protocol).toBe("not-run");
      expect(sample.raw).toBeNull();
      expect(sample.observedHttpStatuses).toEqual([]);
      expect(sample.observedUsage).toBeNull();
    }
  });
});
