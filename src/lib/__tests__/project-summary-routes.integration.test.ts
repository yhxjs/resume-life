import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptySummary, PROJECT_SUMMARY_OUTPUT_LIMITS } from "../summary";

const model = vi.hoisted(() => ({ stream: vi.fn() }));

let directory: string;
let db: DatabaseSync;
const params = { params: Promise.resolve({ id: "1" }) };
const projectRequest = (body: unknown) => new Request("http://localhost/api/projects/1", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

type SummaryProposal = ReturnType<typeof import("../project-summary-history").prepareProjectSummaryProposal>;

describe.each(["full", "resume-only"])("项目总结 %s 的完整输出边界", mode => {
  const output = mode === "full"
    ? { ...emptySummary(), overview: "有材料依据的测试项目，尚未上线" }
    : { techStack: "", brief: "有材料依据的测试项目，尚未上线", achievements: [] };
  const state = () => ["projects", "project_materials", "project_summary_history"]
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  async function generate(raw: string) {
    model.stream.mockResolvedValueOnce(raw);
    return run();
  }
  async function run() {
    const route = await import("@/app/api/projects/[id]/summarize/route");
    const response = await route.POST(new Request(`http://localhost/api/projects/1/summarize?mode=${mode}`, { method: "POST" }), params);
    return response.text();
  }

  it.each([
    "使用 TypeScript 校验接口", "  使用 TypeScript 校验接口 \n", "使用 ＴｙｐｅＳｃｒｉｐｔ 校验接口",
    "使用 typescript 校验接口", "使用 \t TypeScript \n 校验接口",
  ])("拒绝重复成果 %j，不外发可预览草稿，显式重试保留不同任务的成果", async duplicate => {
    const before = state();
    const repeated = { ...output, achievements: ["使用 TypeScript 校验接口", duplicate] };
    const rejected = await generate(JSON.stringify(repeated));
    expect(rejected).toContain("event: error");
    expect(rejected).toContain("成果不得重复");
    expect(rejected).not.toContain("event: done");
    expect(rejected).not.toContain("event: delta");
    expect(state()).toEqual(before);
    const achievements = ["A 任务测试环境使用 TypeScript 校验接口，尚未上线", "B 任务离线使用 TypeScript 校验接口"];
    const retried = await generate(JSON.stringify({ ...output, achievements }));
    expect(retried).toContain("event: done");
    const proposal = JSON.parse(retried.match(/event: done\ndata: ([^\n]+)/)![1]!) as SummaryProposal;
    expect(proposal.summary.achievements).toEqual(achievements);
    expect(state()).toEqual(before);
  });

  it.each([
    ["围栏", (json: string) => ["```json", json, "```"].join("\n")],
    ["前置说明", (json: string) => `以下为初稿：\n${json}`],
    ["后置说明", (json: string) => `${json}\n上述分工仍需修订。`],
    ["追加截断内容", (json: string) => `${json}\n{"correction":`],
  ] as const)("%s 的模型回复不截取后生成草稿，纯 JSON 可显式重试", async (_label, wrap) => {
    const before = state();
    const rejected = await generate(wrap(JSON.stringify(output)));
    expect(rejected).toContain("event: error");
    expect(rejected).not.toContain("event: done");
    expect(rejected).not.toContain("event: delta");
    expect(state()).toEqual(before);
    expect(model.stream.mock.calls[0]!.at(-1)).toMatchObject({ requireJson: "strict" });
    expect(await generate(` \n${JSON.stringify(output)}\t `)).toContain("event: done");
    expect(model.stream).toHaveBeenCalledTimes(2);
    expect(state()).toEqual(before);
  });

  it.each(["valid", "invalid", "upstream-error"])("校验和草稿准备前不外发模型片段：%s", async result => {
    const before = state();
    model.stream.mockImplementationOnce(async (...args: unknown[]) => {
      const raw = JSON.stringify(result === "valid" ? output : { brief: "不完整的三要素不得显示" });
      (args[4] as (text: string) => void)(raw);
      if (result === "upstream-error") throw new Error("合成上游失败");
      return raw;
    });
    const text = await run();
    expect(text).not.toContain("不完整的三要素不得显示");
    if (result === "valid") {
      expect(text).toContain("event: done");
      expect(text.match(/event: delta/g)).toHaveLength(1);
      expect(text.indexOf("event: delta")).toBeLessThan(text.indexOf("event: done"));
    } else {
      expect(text).toContain("event: error");
      expect(text).not.toContain("event: done");
      expect(text).not.toContain("event: delta");
    }
    expect(state()).toEqual(before);
  });
});

describe("完整项目总结的输出契约", () => {
  const sparse = { ...emptySummary(), overview: "有源码支持的项目定位" };
  const invalidOutputs = [
    ...Object.keys(sparse).flatMap((key) => {
      const missing: Record<string, unknown> = { ...sparse };
      delete missing[key];
      return [{ name: `缺少 ${key}`, output: missing }, { name: `${key} 类型错误`, output: { ...sparse, [key]: null } }];
    }),
    { name: "成果混入错误条目", output: { ...sparse, achievements: ["有效成果", false] } },
    { name: "成果混入空白条目", output: { ...sparse, achievements: ["有效成果", " "] } },
    { name: "旧式成果文本", output: { ...sparse, achievements: "成果" } },
    { name: "五维字段超限", output: { ...sparse, overview: "字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.dimension + 1) } },
    { name: "简历字段超限", output: { ...sparse, brief: "字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.brief + 1) } },
    { name: "成果条数超限", output: { ...sparse, achievements: Array.from({ length: PROJECT_SUMMARY_OUTPUT_LIMITS.maxAchievements + 1 }, (_, index) => `成果${index + 1}`) } },
    { name: "单条成果超限", output: { ...sparse, achievements: ["字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.achievement + 1)] } },
    { name: "包含未要求的额外字段", output: { ...sparse, internal_note: "额外字段" } },
  ];

  async function generate(output: unknown) {
    model.stream.mockResolvedValue(JSON.stringify(output));
    const route = await import("@/app/api/projects/[id]/summarize/route");
    const response = await route.POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), params);
    return response.text();
  }

  it.each(invalidOutputs)("拒绝 $name，不产生可采纳草稿或写入", async ({ output }) => {
    db.prepare("UPDATE projects SET summary = ? WHERE id = 1").run(JSON.stringify({ ...sparse, overview: "原稿" }));
    const project = db.prepare("SELECT * FROM projects WHERE id = 1").get();
    const materials = db.prepare("SELECT * FROM project_materials WHERE project_id = 1").all();
    const stream = await generate(output);
    expect(stream).toContain("event: error");
    expect(stream).not.toContain("event: done");
    expect(db.prepare("SELECT * FROM projects WHERE id = 1").get()).toEqual(project);
    expect(db.prepare("SELECT * FROM project_materials WHERE project_id = 1").all()).toEqual(materials);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
  });

  it("完整空总结给出无可靠内容反馈，不产生草稿或写入", async () => {
    db.prepare("UPDATE projects SET summary = ? WHERE id = 1").run(JSON.stringify({ ...sparse, overview: "原稿" }));
    const project = db.prepare("SELECT * FROM projects WHERE id = 1").get();
    const materials = db.prepare("SELECT * FROM project_materials WHERE project_id = 1").all();
    const stream = await generate(emptySummary());
    expect(stream).toContain("当前材料没有可生成的可靠项目总结内容");
    expect(stream).toContain("event: error");
    expect(stream).not.toContain("event: done");
    expect(stream).not.toContain("event: delta");
    expect(db.prepare("SELECT * FROM projects WHERE id = 1").get()).toEqual(project);
    expect(db.prepare("SELECT * FROM project_materials WHERE project_id = 1").all()).toEqual(materials);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
  });

  it("完整稀疏结构可生成，未知个人职责和成果保持明确空值", async () => {
    const stream = await generate(sparse);
    expect(stream).not.toContain("event: error");
    expect(stream).toContain("event: done");
    const proposal = JSON.parse(stream.match(/event: done\ndata: ([^\n]+)/)![1]!) as SummaryProposal;
    expect(proposal.summary).toEqual(sparse);
    expect(db.prepare("SELECT summary FROM projects WHERE id = 1").get()).toEqual({ summary: "{}" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
  });
});

describe("仅提炼简历三要素", () => {
  const previous = {
    ...emptySummary(), overview: "已有项目定位", architecture: "已有架构", highlights: "已有亮点",
    responsibilities: "已有个人职责", challenges: "已有问题与处理", techStack: "旧技术栈", brief: "旧介绍",
    achievements: ["旧成果一", "旧成果二"],
  };
  const nextResume = { techStack: "", brief: "本次材料支持的新介绍", achievements: [] };
  function seed(summary = previous) {
    db.prepare("UPDATE projects SET summary = ? WHERE id = 1").run(JSON.stringify(summary));
  }
  async function generate(output: unknown) {
    model.stream.mockResolvedValue(JSON.stringify(output));
    const route = await import("@/app/api/projects/[id]/summarize/route");
    const response = await route.POST(new Request("http://localhost/api/projects/1/summarize?mode=resume-only", { method: "POST" }), params);
    return response.text();
  }
  function proposal(stream: string): SummaryProposal {
    expect(stream).toContain("event: done");
    return JSON.parse(stream.match(/event: done\ndata: ([^\n]+)/)![1]!);
  }

  it.each([
    null, [], {}, { overview: "只返回五维不能代替三要素" },
    { techStack: "技术", brief: "介绍" }, { techStack: "技术", achievements: [] },
    { brief: "介绍", achievements: [] }, { ...nextResume, techStack: null },
    { ...nextResume, brief: 1 }, { ...nextResume, achievements: "旧式文本" },
    { ...nextResume, source: "额外字段" },
    { ...nextResume, techStack: "字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.techStack + 1) },
    { ...nextResume, achievements: Array.from({ length: PROJECT_SUMMARY_OUTPUT_LIMITS.maxAchievements + 1 }, () => "成果") },
    { ...nextResume, achievements: ["字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.achievement + 1)] },
    { ...nextResume, achievements: ["有效成果", false] }, { ...nextResume, achievements: [" "] },
  ].map((output) => ({ output })))("拒绝缺失或类型错误的三要素：$output", async ({ output }) => {
    seed();
    const before = db.prepare("SELECT * FROM projects WHERE id = 1").get();
    const stream = await generate(output);
    expect(stream).toContain("event: error");
    expect(stream).not.toContain("event: done");
    expect(db.prepare("SELECT * FROM projects WHERE id = 1").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
  });

  it("明确空值成为清空建议，不再恢复旧技术栈与旧成果", async () => {
    seed();
    const done = proposal(await generate(nextResume));
    expect(done.summary).toEqual({ ...previous, ...nextResume });
    expect(done.comparison).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "techStack", previous: "旧技术栈", next: "" }),
      expect.objectContaining({ key: "achievement:0", previous: "旧成果一", next: "" }),
      expect.objectContaining({ key: "achievement:1", previous: "旧成果二", next: "" }),
    ]));
    expect(done.comparison.some((change) => change.key === "overview")).toBe(false);
    expect(db.prepare("SELECT summary FROM projects WHERE id = 1").get()).toEqual({ summary: JSON.stringify(previous) });
  });

  it.each([true, false])("三要素均明确留空时可确认清空，有五维原稿：%s", async (hasFive) => {
    const current = hasFive ? previous : { ...emptySummary(), techStack: previous.techStack, brief: previous.brief, achievements: previous.achievements };
    seed(current);
    const cleared = { techStack: "", brief: "", achievements: [] };
    const done = proposal(await generate(cleared));
    expect(done.summary).toEqual({ ...current, ...cleared });
    const route = await import("@/app/api/projects/[id]/route");
    const response = await route.PATCH(projectRequest({
      summary: done.summary, expectedRevisionId: done.revisionId,
      proposal: { generated: done.summary, acceptedKeys: done.comparison.map((change) => change.key), source: "ai", materialFingerprint: done.materialFingerprint },
    }), params);
    expect(response.status).toBe(200);
    expect(JSON.parse((db.prepare("SELECT summary FROM projects WHERE id = 1").get() as { summary: string }).summary)).toEqual(done.summary);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 1 });
    const detail = await route.GET(new Request("http://localhost/api/projects/1"), params);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ summary: done.summary, summary_corrupt: false });
  });

  it("确认部分清空建议时保留未采纳的原内容", async () => {
    seed();
    const done = proposal(await generate(nextResume));
    const { adoptSummaryChanges } = await import("../project-summary-diff");
    const summary = adoptSummaryChanges(previous, done.summary, {}, ["techStack", "achievement:0"]).summary;
    const route = await import("@/app/api/projects/[id]/route");
    expect((await route.PATCH(projectRequest({
      summary, expectedRevisionId: done.revisionId,
      proposal: { generated: done.summary, acceptedKeys: ["techStack", "achievement:0"], source: "ai", materialFingerprint: done.materialFingerprint },
    }), params)).status).toBe(200);
    expect(summary).toEqual({ ...previous, techStack: "", achievements: ["旧成果二"] });
    expect(JSON.parse((db.prepare("SELECT summary FROM projects WHERE id = 1").get() as { summary: string }).summary)).toEqual(summary);
  });

  it.each([{}, { overview: "残缺草稿" }, { ...emptySummary(), achievements: [false] }])("确认接口拒绝残缺草稿 %j", async (generated) => {
    seed();
    const { prepareProjectSummaryProposal } = await import("../project-summary-history");
    const { materialFingerprint } = prepareProjectSummaryProposal(1, previous);
    const route = await import("@/app/api/projects/[id]/route");
    expect((await route.PATCH(projectRequest({
      summary: previous, expectedRevisionId: 0,
      proposal: { generated, acceptedKeys: [], source: "ai", materialFingerprint },
    }), params)).status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
  });
});

it.each(["first oversized", "exact budget plus newer material"])("总结拒绝不完整材料输入：%s", async (scenario) => {
  const overhead = JSON.stringify({ materialNumber: 1, title: "材料", content: "" }).length + 1;
  db.prepare("UPDATE project_materials SET content = ? WHERE project_id = 1").run("a".repeat(60_000 - overhead + (scenario === "first oversized" ? 1 : 0)));
  if (scenario === "exact budget plus newer material") {
    db.exec("INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,'新增成果','NEW_MATERIAL_SENTINEL','')");
  }
  model.stream.mockResolvedValue(JSON.stringify({ ...emptySummary(), overview: "不应生成" }));
  const summarize = await import("@/app/api/projects/[id]/summarize/route");
  const response = await summarize.POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), params);
  expect(response.status).toBe(413);
  expect((await response.json()).error).toContain("材料");
  expect(model.stream).not.toHaveBeenCalled();
  expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
});

it("材料恰好占满 60000 字符但完整模型输入超限时拒绝且不调用模型", async () => {
  const overhead = JSON.stringify({ materialNumber: 1, title: "材料", content: "" }).length + 1;
  const content = "a".repeat(60_000 - overhead);
  db.prepare("UPDATE project_materials SET content = ? WHERE project_id = 1").run(content);
  const { captureProjectSummaryInput } = await import("../project-summary-history");
  expect(captureProjectSummaryInput(1, 60_000).materialText).toHaveLength(60_000);
  const summarize = await import("@/app/api/projects/[id]/summarize/route");
  const response = await summarize.POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), params);
  expect(response.status).toBe(413);
  expect((await response.json()).error).toContain("完整模型输入超过 64000 字符");
  expect(model.stream).not.toHaveBeenCalled();
  expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
});

it("恰好完整占满模型预算的材料全部传入模型，多一个字符则拒绝", async () => {
  const { buildProjectSummaryMessages, PROJECT_SUMMARY_SYSTEM_PROMPT } = await import("../project-summary-llm");
  const { checkSafeModelInput } = await import("../safe-llm");
  const materialText = (content: string) => JSON.stringify({ materialNumber: 1, title: "材料", content }) + "\n";
  const messages = (content: string) => buildProjectSummaryMessages({ projectName: "项目", materialText: materialText(content), archive: emptySummary() });
  const fullInputLength = (content: string) => checkSafeModelInput(PROJECT_SUMMARY_SYSTEM_PROMPT, messages(content)).reduce((total, message) => {
    if (typeof message.content !== "string") throw new Error("项目总结应只发送文本");
    return total + message.content.length;
  }, 0);
  const content = "a".repeat(64_000 - fullInputLength(""));
  expect(fullInputLength(content)).toBe(64_000);
  expect(materialText(content).length).toBeLessThanOrEqual(60_000);
  db.prepare("UPDATE project_materials SET content = ? WHERE project_id = 1").run(content);
  model.stream.mockResolvedValue(JSON.stringify({ ...emptySummary(), overview: "完整总结" }));
  const summarize = await import("@/app/api/projects/[id]/summarize/route");
  const response = await summarize.POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), params);
  expect(response.status, response.status === 200 ? undefined : await response.clone().text()).toBe(200);
  expect(await response.text()).toContain("event: done");
  expect(model.stream.mock.calls[0]?.[3][0].parts).toContainEqual({ trust: "untrusted", tag: "project_materials", text: materialText(content) });

  db.prepare("UPDATE project_materials SET content = ? WHERE project_id = 1").run(content + "a");
  expect(materialText(content + "a").length).toBeLessThanOrEqual(60_000);
  const oversized = await summarize.POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), params);
  expect(oversized.status).toBe(413);
  expect((await oversized.json()).error).toContain("完整模型输入超过 64000 字符");
  expect(model.stream).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
});

beforeEach(async () => {
  vi.resetModules();
  // Keep the real preflight and its error classes in this test's module registry.
  // A cached partial mock otherwise throws an older ModelInputBudgetError instance.
  vi.doMock("../safe-llm", async (original) => ({
    ...await original<typeof import("../safe-llm")>(),
    safeChatStream: model.stream,
  }));
  model.stream.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-summary-routes-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'项目','',''); INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,'材料','技术事实','')");
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-summary-routes-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("project summary routes", () => {
  it("保存响应返回事务实际写入的总结、版本和时间，供刷新失败时确认结果", async () => {
    const summary = { ...emptySummary(), overview: "已核实的项目概述", achievements: ["  已核实的成果，尚未上线  ", " "] };
    const route = await import("@/app/api/projects/[id]/route");
    const response = await route.PATCH(projectRequest({ summary, expectedRevisionId: 0 }), params);
    expect(response.status).toBe(200);
    const result = await response.json();
    const stored = db.prepare("SELECT summary, summary_updated_at FROM projects WHERE id = 1").get() as { summary: string; summary_updated_at: string };
    const history = db.prepare("SELECT id, summary, created_at FROM project_summary_history WHERE project_id = 1").get() as { id: number; summary: string; created_at: string };
    expect(result).toEqual({ ok: true, revisionId: history.id, summary: JSON.parse(stored.summary), summary_updated_at: stored.summary_updated_at });
    expect(result.summary.achievements).toEqual(["已核实的成果，尚未上线"]);
    expect(stored.summary).toBe(history.summary);
    expect(stored.summary_updated_at).toBe(history.created_at);
  });

  it.each([
    { name: "旧空档案", summary: {} },
    { name: "仅技术栈", summary: { ...emptySummary(), techStack: "TypeScript" } },
    { name: "仅项目介绍", summary: { ...emptySummary(), brief: "已验证的项目介绍" } },
    { name: "仅项目成果", summary: { ...emptySummary(), achievements: ["已验证的项目成果"] } },
  ])("带更新时间的合法档案不误报损坏：$name", async ({ summary }) => {
    db.prepare("UPDATE projects SET summary = ?, summary_updated_at = ? WHERE id = 1").run(JSON.stringify(summary), "2026-10-25T00:00:00.000Z");
    const before = db.prepare("SELECT * FROM projects WHERE id = 1").get();
    const route = await import("@/app/api/projects/[id]/route");
    const detail = await route.GET(new Request("http://localhost/api/projects/1"), params);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ summary: { ...emptySummary(), ...summary }, summary_corrupt: false });
    expect(db.prepare("SELECT * FROM projects WHERE id = 1").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
    expect(model.stream).not.toHaveBeenCalled();
  });

  it("returns 413 and rolls back the combined name write for an oversized history snapshot", async () => {
    const insert = db.prepare("INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,?,'正文','')");
    for (let i = 0; i < 5; i++) insert.run("T".repeat(450_000));
    const summary = { ...emptySummary(), overview: "不能保存" };
    const history = await import("../project-summary-history");
    const materialFingerprint = history.prepareProjectSummaryProposal(1, summary).materialFingerprint;
    const before = db.prepare("SELECT * FROM projects WHERE id = 1").get();
    const response = await (await import("@/app/api/projects/[id]/route")).PATCH(projectRequest({
      name: "不能改名", summary, expectedRevisionId: 0,
      proposal: { generated: summary, acceptedKeys: ["overview"], source: "repo", materialFingerprint },
    }), params);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "项目总结历史内容过大，请精简总结或材料标题后重试" });
    expect(db.prepare("SELECT * FROM projects WHERE id = 1").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
  });

  it.each(["json", "multipart"])("rejects an oversized material title on creation (%s)", async (format) => {
    const title = "中".repeat(201);
    const form = new FormData();
    form.set("title", title);
    form.set("file", new Blob(["正文"], { type: "text/plain" }), "material.txt");
    const response = await (await import("@/app/api/projects/[id]/materials/route")).POST(new Request("http://localhost/api/projects/1/materials", {
      method: "POST",
      body: format === "json" ? JSON.stringify({ title, content: "正文" }) : form,
      headers: format === "json" ? { "Content-Type": "application/json" } : undefined,
    }), params);
    expect(response.status).toBe(413);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_materials").get()).toEqual({ count: 1 });
  });

  it("rejects an oversized material title on edit without changing the material", async () => {
    const route = await import("@/app/api/projects/[id]/materials/[mid]/route");
    const context = { params: Promise.resolve({ id: "1", mid: "1" }) };
    const before = db.prepare("SELECT * FROM project_materials WHERE id = 1").get();
    const detail = await route.GET(new Request("http://localhost/api/projects/1/materials/1"), context);
    const { revision } = await detail.json();
    const response = await route.PATCH(new Request("http://localhost/api/projects/1/materials/1", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "T".repeat(201), content: "不应保存", expectedRevision: revision }),
    }), context);
    expect(response.status).toBe(413);
    expect(db.prepare("SELECT * FROM project_materials WHERE id = 1").get()).toEqual(before);
  });

  it.each([
    { overview: 123 }, { achievements: [{}] }, { achievements: "错误类型" },
    { unknown: "未知字段" }, null, [], "错误结构",
  ].map((summary) => ({ summary })))("rejects invalid summary $summary without changing the project or history", async ({ summary }) => {
    const route = await import("@/app/api/projects/[id]/route");
    const saved = await route.PATCH(projectRequest({ summary: { ...emptySummary(), overview: "保留原总结" }, expectedRevisionId: 0 }), params);
    expect(saved.status).toBe(200);
    const revisionId = (await saved.json()).revisionId;
    const before = db.prepare("SELECT * FROM projects WHERE id = 1").get();
    const count = db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get();
    const response = await route.PATCH(projectRequest({ summary, expectedRevisionId: revisionId, name: "也不能改名" }), params);
    expect(response.status).toBe(400);
    expect(db.prepare("SELECT * FROM projects WHERE id = 1").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual(count);
  });

  it("accepts deliberate empty fields and name-only updates", async () => {
    const route = await import("@/app/api/projects/[id]/route");
    const first = await route.PATCH(projectRequest({ summary: { ...emptySummary(), overview: "待清空", achievements: ["成果"] }, expectedRevisionId: 0 }), params);
    expect(first.status).toBe(200);
    const saved = await route.PATCH(projectRequest({ summary: emptySummary(), expectedRevisionId: (await first.json()).revisionId }), params);
    expect(saved.status).toBe(200);
    expect(JSON.parse((db.prepare("SELECT summary FROM projects WHERE id = 1").get() as { summary: string }).summary)).toEqual(emptySummary());
    const detail = await route.GET(new Request("http://localhost/api/projects/1"), params);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ summary: emptySummary(), summary_corrupt: false });
    const count = db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get();
    expect((await route.PATCH(projectRequest({ name: "新名称" }), params)).status).toBe(200);
    expect(db.prepare("SELECT name FROM projects WHERE id = 1").get()).toEqual({ name: "新名称" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual(count);
  });

  it("rejects a stale material editor without overwriting the newer content", async () => {
    const materialRoute = await import("@/app/api/projects/[id]/materials/[mid]/route");
    const detail = await materialRoute.GET(new Request("http://localhost/api/projects/1/materials/1"), { params: Promise.resolve({ id: "1", mid: "1" }) });
    const snapshot = await detail.json() as { revision: string; content: string; title: string };
    const first = await materialRoute.PATCH(new Request("http://localhost/api/projects/1/materials/1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "新标题", content: "新正文", expectedRevision: snapshot.revision }) }), { params: Promise.resolve({ id: "1", mid: "1" }) });
    expect(first.status).toBe(200);
    const stale = await materialRoute.PATCH(new Request("http://localhost/api/projects/1/materials/1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: snapshot.title, content: "旧标签页正文", expectedRevision: snapshot.revision }) }), { params: Promise.resolve({ id: "1", mid: "1" }) });
    expect(stale.status).toBe(409);
    expect((db.prepare("SELECT title, content FROM project_materials WHERE id = 1").get())).toEqual({ title: "新标题", content: "新正文" });
  });

  it("rolls back summary history when the combined project name write fails", async () => {
    db.exec("CREATE TRIGGER block_project_name BEFORE UPDATE OF name ON projects BEGIN SELECT RAISE(ABORT, 'name blocked'); END;");
    const before = db.prepare("SELECT name, summary, summary_updated_at, updated_at FROM projects WHERE id = 1").get();
    const response = await (await import("@/app/api/projects/[id]/route")).PATCH(projectRequest({ summary: { ...emptySummary(), overview: "不应保存" }, expectedRevisionId: 0, name: "新名称" }), params);
    expect(response.status).toBe(500);
    expect(db.prepare("SELECT name, summary, summary_updated_at, updated_at FROM projects WHERE id = 1").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history WHERE project_id = 1").get()).toEqual({ count: 0 });
  });

  it("returns a comparison in regeneration SSE and preserves corrected text through selective adoption", async () => {
    const route = await import("@/app/api/projects/[id]/route");
    const ai = { ...emptySummary(), overview: "AI 原稿", architecture: "旧架构" };
    const history = await import("../project-summary-history");
    const firstFingerprint = history.prepareProjectSummaryProposal(1, ai).materialFingerprint;
    const first = await route.PATCH(projectRequest({ summary: ai, expectedRevisionId: 0, proposal: { generated: ai, acceptedKeys: ["overview", "architecture"], source: "ai", materialFingerprint: firstFingerprint } }), params);
    expect(first.status).toBe(200);
    const firstId = (await first.json()).revisionId as number;
    const manual = await route.PATCH(projectRequest({ summary: { ...ai, overview: "用户校正" }, expectedRevisionId: firstId }), params);
    expect(manual.status).toBe(200);
    const secondId = (await manual.json()).revisionId as number;

    model.stream.mockResolvedValue(JSON.stringify({ ...ai, overview: "AI 新稿", architecture: "新架构" }));
    const summarize = await import("@/app/api/projects/[id]/summarize/route");
    const response = await summarize.POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), params);
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"status":"conflict"');
    expect(stream).toContain('"status":"changed"');
    expect(stream).toContain(`"revisionId":${secondId}`);

    const adopted = await route.PATCH(projectRequest({
      summary: { ...ai, overview: "用户校正", architecture: "新架构" },
      expectedRevisionId: secondId,
      proposal: { generated: { ...ai, overview: "AI 新稿", architecture: "新架构" }, acceptedKeys: ["architecture"], source: "ai", materialFingerprint: firstFingerprint },
    }), params);
    expect(adopted.status).toBe(200);
    const detail = await route.GET(new Request("http://localhost/api/projects/1"), params);
    expect(await detail.json()).toMatchObject({ summary: { overview: "用户校正", architecture: "新架构" }, summary_revision_id: (await adopted.json()).revisionId });
  });

  it("rejects stale and invalid proposal writes, and paginates immutable history", async () => {
    const route = await import("@/app/api/projects/[id]/route");
    const summary = { ...emptySummary(), overview: "第一版" };
    const first = await route.PATCH(projectRequest({ summary, expectedRevisionId: 0 }), params);
    expect(first.status).toBe(200);
    const firstId = (await first.json()).revisionId as number;
    expect((await route.PATCH(projectRequest({ summary, expectedRevisionId: 0 }), params)).status).toBe(409);
    expect((await route.PATCH(projectRequest({ summary, expectedRevisionId: firstId, proposal: { generated: summary, acceptedKeys: ["bogus"], source: "ai", materialFingerprint: "0".repeat(64) } }), params)).status).toBe(400);
    const second = await route.PATCH(projectRequest({ summary: { ...summary, overview: "第二版" }, expectedRevisionId: firstId }), params);
    expect(second.status).toBe(200);

    const history = await import("@/app/api/projects/[id]/summary-history/route");
    const page = await history.GET(new Request("http://localhost/api/projects/1/summary-history?limit=1"), params);
    expect(page.status).toBe(200);
    const body = await page.json() as { items: Array<{ summary: { overview: string } }>; nextCursor: string };
    expect(body.items[0]?.summary.overview).toBe("第二版");
    const older = await history.GET(new Request(`http://localhost/api/projects/1/summary-history?limit=1&cursor=${body.nextCursor}`), params);
    expect((await older.json()).items[0].summary.overview).toBe("第一版");
    expect((await history.GET(new Request("http://localhost/api/projects/1/summary-history?cursor=bad"), params)).status).toBe(400);
  });

  it("rejects a proposal when materials change after generation", async () => {
    const route = await import("@/app/api/projects/[id]/route");
    const summarize = await import("@/app/api/projects/[id]/summarize/route");
    const generated = { ...emptySummary(), overview: "AI 原稿" };
    model.stream.mockResolvedValue(JSON.stringify(generated));
    const response = await summarize.POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), params);
    const stream = await response.text();
    const done = JSON.parse(stream.match(/event: done\ndata: ([^\n]+)/)?.[1] ?? "{}") as { materialFingerprint?: string };
    expect(done.materialFingerprint).toMatch(/^[a-f0-9]{64}$/);
    db.exec("INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,'后加材料','尚未总结','')");
    const saved = await route.PATCH(projectRequest({
      summary: generated,
      expectedRevisionId: 0,
      proposal: { generated, acceptedKeys: ["overview"], source: "ai", materialFingerprint: done.materialFingerprint },
    }), params);
    expect(saved.status).toBe(409);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
  });

  it("keeps the generation-start revision when another save happens during summarization", async () => {
    const route = await import("@/app/api/projects/[id]/route");
    const summarize = await import("@/app/api/projects/[id]/summarize/route");
    const generated = { ...emptySummary(), overview: "AI 新稿" };
    model.stream.mockImplementation(async () => {
      const concurrent = await route.PATCH(projectRequest({ summary: { ...emptySummary(), overview: "另一处保存" }, expectedRevisionId: 0 }), params);
      expect(concurrent.status).toBe(200);
      return JSON.stringify(generated);
    });
    const response = await summarize.POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), params);
    const stream = await response.text();
    const done = JSON.parse(stream.match(/event: done\ndata: ([^\n]+)/)?.[1] ?? "{}") as { revisionId: number; materialFingerprint: string };
    expect(done.revisionId).toBe(0);
    const saved = await route.PATCH(projectRequest({
      summary: generated,
      expectedRevisionId: done.revisionId,
      proposal: { generated, acceptedKeys: ["overview"], source: "ai", materialFingerprint: done.materialFingerprint },
    }), params);
    expect(saved.status).toBe(409);
  });
});
