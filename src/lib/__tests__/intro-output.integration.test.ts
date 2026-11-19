import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INTRO_GENERATED_COMMENT_MAX_CHARS, INTRO_GENERATED_LIMITS, INTRO_MAX_SENTENCES, INTRO_MAX_TEXT_CHARS, INTRO_MAX_COMMENT_CHARS } from "../intro";
import { INTRO_COMMENT_SYSTEM_PROMPT, INTRO_SYSTEM_PROMPT } from "../intro-llm";

const model = vi.hoisted(() => ({ safeChat: vi.fn(), safeChatStream: vi.fn() }));
vi.mock("@/lib/safe-llm", async (original) => ({
  ...await original<typeof import("@/lib/safe-llm")>(), ...model,
}));

const PREFIX = "resume-life-intro-output-";
const original = [{ text: "原有自我介绍。", comment: "原有点评。" }];
const generated = [{ text: "我参与过接口开发。", comment: "以具体职责定位，避免夸大贡献。" }];
let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  model.safeChat.mockReset();
  model.safeChatStream.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.prepare("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'合成简历','','')").run();
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'summary','summary','介绍',?,'')")
    .run(JSON.stringify({ text: "参与接口开发" }));
  (await import("../resume-versions")).publishResumeVersion(1, { name: "合成版本" });
  db.prepare("INSERT INTO intros (id,resume_id,jd,created_at) VALUES (1,1,'接口开发','')").run();
  for (const kind of ["30s", "2min"]) {
    db.prepare("INSERT INTO intro_versions (intro_id,kind,sentences,updated_at) VALUES (1,?,?,'original')")
      .run(kind, JSON.stringify(original));
  }
});
afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

function stored() {
  return {
    intros: db.prepare("SELECT * FROM intros ORDER BY id").all(),
    versions: db.prepare("SELECT * FROM intro_versions ORDER BY id").all(),
  };
}

it("两版按证据选择篇幅，生成硬上限仍由领域常量控制", () => {
  expect(INTRO_SYSTEM_PROMPT).toContain("通常 4-6 句、约 100-160 字");
  expect(INTRO_SYSTEM_PROMPT).toContain("不预设要填满的句数");
  expect(INTRO_SYSTEM_PROMPT).toContain("在短版之外展开材料中更多有用事实");
  expect(INTRO_SYSTEM_PROMPT).toContain("不是最低要求，材料不足时可以低于这些目标");
  expect(INTRO_SYSTEM_PROMPT).toContain("没有身份信息就直接介绍经历");
  expect(INTRO_SYSTEM_PROMPT).toContain("材料不足时合并或省略不必要部分，只保留有依据的信息，不为结构凑句");
  expect(INTRO_SYSTEM_PROMPT).toContain("不靠复述、解释写作规则或补齐未知背景拉长");
  expect(INTRO_SYSTEM_PROMPT).toContain("正文和点评都必须含可见文字或数字");
  expect(INTRO_COMMENT_SYSTEM_PROMPT).toContain("必须含可见文字或数字，不能用零宽、控制字符等不可见内容占位");
  expect(INTRO_SYSTEM_PROMPT).toContain("只执行对应版本的句数、单句正文、正文总字数与点评总字数硬上限");
  expect(INTRO_SYSTEM_PROMPT).toContain("简单句可用更短的具体点评，不为篇幅重复内容");
  expect(INTRO_COMMENT_SYSTEM_PROMPT).toContain("简单句可用更短的具体点评，不为篇幅重复内容");
  expect(INTRO_SYSTEM_PROMPT).toContain("版本对象 kind 与 sentences、句子对象 text 与 comment");
  expect(INTRO_COMMENT_SYSTEM_PROMPT).toContain("顶层只返回 comments 字段");
  for (const kind of ["30s", "2min"] as const) {
    const limits = INTRO_GENERATED_LIMITS[kind];
    expect(INTRO_SYSTEM_PROMPT).toContain(`生成硬上限 ${limits.maxSentences} 句`);
    expect(INTRO_SYSTEM_PROMPT).toContain(`正文合计 ${limits.totalTextChars} 个非空白字符`);
  }
});

async function generate(action: string, output: unknown, raw?: string, kind: "30s" | "2min" = "30s") {
  const reply = raw ?? JSON.stringify(output);
  model.safeChat.mockResolvedValueOnce(reply);
  model.safeChatStream.mockResolvedValueOnce(reply);
  const isCreate = action === "create";
  const body = isCreate ? { resume_id: 1, jd: "接口开发" } : { kind };
  const request = new Request("http://localhost/api/intros", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const response = isCreate
    ? await (await import("@/app/api/intros/route")).POST(request)
    : await (await import("@/app/api/intros/[id]/regenerate/route")).POST(request, { params: Promise.resolve({ id: "1" }) });
  return { status: response.status, body: await response.text() };
}

describe.each(["create", "regenerate"])("自我介绍 %s 生成结果", (action) => {
  const kinds = action === "create" ? ["30s", "2min"] : ["30s"];
  const output = (sentences: unknown) => ({ versions: kinds.map((kind) => ({ kind, sentences })) });
  const outputByKind = (sentences: Record<string, unknown>) => ({
    versions: kinds.map((kind) => ({ kind, sentences: sentences[kind] ?? generated })),
  });
  const twoMinuteOutput = (sentences: unknown) => action === "create"
    ? outputByKind({ "2min": sentences })
    : { versions: [{ kind: "2min", sentences }] };

  it.each([
    ["围栏", (json: string) => ["```json", json, "```"].join("\n")],
    ["前置说明", (json: string) => `以下为初稿：\n${json}`],
    ["后置说明", (json: string) => `${json}\n上述分工仍需修订。`],
    ["追加截断内容", (json: string) => `${json}\n{"correction":`],
  ] as const)("%s 的模型回复不截取后保存，保留旧版本，纯 JSON 可显式重试", async (_label, wrap) => {
    const before = stored();
    const json = JSON.stringify(output(generated));
    const rejected = await generate(action, null, wrap(json));
    expect(rejected.status).toBe(action === "create" ? 200 : 502);
    expect(rejected.body).toContain(action === "create" ? "event: error" : "AI 生成结果异常");
    expect(rejected.body).not.toContain("event: done");
    expect(rejected.body).not.toContain("event: delta");
    expect(stored()).toEqual(before);
    const caller = action === "create" ? model.safeChatStream : model.safeChat;
    expect(caller.mock.calls[0]!.at(-1)).toMatchObject({ requireJson: "strict" });
    const retried = await generate(action, null, ` \n${json}\t `);
    expect(retried.status).toBe(200);
    expect(caller).toHaveBeenCalledTimes(2);
    if (action === "create") {
      expect(retried.body).toContain("event: done");
      expect(stored().intros.slice(0, -1)).toEqual(before.intros);
      expect(stored().versions.slice(0, before.versions.length)).toEqual(before.versions);
    } else {
      expect(stored().intros).toEqual(before.intros);
      expect(stored().versions[1]).toEqual(before.versions[1]);
    }
    const saved = db.prepare("SELECT sentences FROM intro_versions WHERE intro_id=? AND kind='30s'")
      .get(action === "create" ? 2 : 1) as { sentences: string };
    expect(JSON.parse(saved.sentences)).toEqual(generated);
  });

  it.each([
    ["混有空句", [...generated, { text: " ", comment: "不能跳过此句" }]],
    ["混有无效句子", [...generated, null]],
    ["正文类型错误", [{ text: 1, comment: "点评" }]],
    ["缺少点评", [{ text: "我参与过接口开发。" }]],
    ["正文缺句末标点", [{ text: "负责后台开发", comment: "以具体职责定位，避免夸大贡献。" }]],
    ["空点评", [{ text: "我参与过接口开发。", comment: " " }]],
    ["点评类型错误", [{ text: "我参与过接口开发。", comment: false }]],
    ["仅含零宽字符的点评", [{ text: "我参与过接口开发。", comment: "\u200b\u2060" }]],
    ["仅含零宽字符的正文", [{ text: "\u200b\u2060", comment: "完整点评" }]],
    ["正文超限", [{ text: "字".repeat(INTRO_MAX_TEXT_CHARS + 1), comment: "点评" }]],
    ["单句正文超过版本上限", [{ text: "字".repeat(INTRO_GENERATED_LIMITS[kinds[0] as "30s" | "2min"].maxTextCharsPerSentence + 1), comment: "完整点评" }]],
    ["点评超限", [{ text: "完整句子。", comment: "字".repeat(INTRO_MAX_COMMENT_CHARS + 1) }]],
    ["新生成点评超限", [{ text: "完整句子。", comment: "字".repeat(INTRO_GENERATED_COMMENT_MAX_CHARS + 1) }]],
    ["句数超限", Array.from({ length: INTRO_MAX_SENTENCES + 1 }, () => generated[0])],
    ["超出该版本生成句数上限", Array.from({ length: INTRO_GENERATED_LIMITS[kinds[0] as "30s" | "2min"].maxSentences + 1 }, () => generated[0])],
    ["正文总字数超限", [{ text: "字".repeat(141), comment: "完整点评" }, { text: "字".repeat(140), comment: "完整点评" }]],
    ["点评总字数超限", Array.from({ length: 10 }, () => ({ text: "完整句子。", comment: "评".repeat(121) }))],
    ["空句子列表", []],
  ])("拒绝%s，已有版本和记录保持完整", async (_label, sentences) => {
    const before = stored();
    const response = await generate(action, output(sentences));
    expect(response.status).toBe(action === "create" ? 200 : 502);
    expect(response.body).toContain(action === "create" ? "event: error" : "AI 生成结果异常");
    expect(response.body).not.toContain("event: done");
    expect(stored()).toEqual(before);
  });

  it("2 分钟版超过总字数上限时整体拒绝，不保存任何版本", async () => {
    const before = stored();
    const tooLong = Array.from({ length: 6 }, (_, index) => ({
      text: "字".repeat(200), comment: `保留第 ${index + 1} 句的事实依据。`,
    }));
    const response = await generate(action, twoMinuteOutput(tooLong), undefined, "2min");
    expect(response.status).toBe(action === "create" ? 200 : 502);
    expect(response.body).toContain(action === "create" ? "event: error" : "AI 生成结果异常");
    expect(response.body).not.toContain("event: done");
    expect(stored()).toEqual(before);
  });

  it("2 分钟版超过单句上限时整体拒绝，不保存任何版本", async () => {
    const before = stored();
    const response = await generate(action, twoMinuteOutput([
      { text: "字".repeat(INTRO_GENERATED_LIMITS["2min"].maxTextCharsPerSentence + 1), comment: "完整点评" },
    ]), undefined, "2min");
    expect(response.status).toBe(action === "create" ? 200 : 502);
    expect(response.body).toContain(action === "create" ? "event: error" : "AI 生成结果异常");
    expect(response.body).not.toContain("event: done");
    expect(stored()).toEqual(before);
  });

  it("2 分钟版达到单句与正文总上限时可单独生成，另一版保持原样", async () => {
    const before = stored();
    const limits = INTRO_GENERATED_LIMITS["2min"];
    const ending = "尚未上线。";
    const sentences = Array.from({ length: 4 }, (_, index) => ({
      text: "字".repeat(limits.maxTextCharsPerSentence - ending.length) + ending,
      comment: `保留第 ${index + 1} 句事实限定。`,
    }));
    const response = await generate(action, twoMinuteOutput(sentences), undefined, "2min");
    expect(response.status).toBe(200);
    const owner = action === "create" ? 2 : 1;
    const saved = db.prepare("SELECT sentences FROM intro_versions WHERE intro_id=? AND kind='2min'").get(owner)!;
    expect(JSON.parse(String(saved.sentences))).toEqual(sentences);
    if (action === "create") {
      expect(response.body).toContain("event: done");
      expect(stored().versions.slice(0, before.versions.length)).toEqual(before.versions);
    } else {
      expect(stored().intros).toEqual(before.intros);
      expect(stored().versions[0]).toEqual(before.versions[0]);
      expect(JSON.parse(response.body).sentences).toEqual(sentences);
    }
  });

  it.each([
    ["缺少版本", []],
    ["重复版本", ["30s", "30s"]],
    ["无关版本", ["unknown", "2min"]],
    ["多余版本", ["30s", "2min", "extra"]],
  ])("拒绝%s且不保存部分结果", async (_label, returnedKinds) => {
    const before = stored();
    const response = await generate(action, { versions: returnedKinds.map((kind) => ({ kind, sentences: generated })) });
    expect(response.body).toContain(action === "create" ? "event: error" : "AI 生成结果异常");
    expect(stored()).toEqual(before);
  });

  it.each([
    ["顶层", (value: ReturnType<typeof output>) => ({ ...value, note: "额外字段" })],
    ["版本", (value: ReturnType<typeof output>) => ({ versions: value.versions.map((version) => ({ ...version, note: "额外字段" })) })],
    ["句子", (value: ReturnType<typeof output>) => ({ versions: value.versions.map((version) => ({ ...version, sentences: [{ ...generated[0]!, note: "额外字段" }] })) })],
  ])("拒绝含未声明%s字段的结果且不保存", async (_label, addExtra) => {
    const before = stored();
    const response = await generate(action, addExtra(output(generated)));
    expect(response.body).toContain(action === "create" ? "event: error" : "AI 生成结果异常");
    expect(stored()).toEqual(before);
  });

  it("JSON 损坏时返回明确生成错误且不写入", async () => {
    const before = stored();
    const response = await generate(action, null, '{"versions":[');
    expect(response.body).toContain("AI 生成结果异常");
    expect(stored()).toEqual(before);
  });

  it("保存完整有效结果，按请求顺序排列版本", async () => {
    const response = await generate(action, { versions: [...kinds].reverse().map((kind) => ({ kind, sentences: generated })) });
    expect(response.status).toBe(200);
    if (action === "create") expect(response.body).toContain("event: done");
    const rows = db.prepare("SELECT kind,sentences FROM intro_versions WHERE intro_id=? ORDER BY id").all(action === "create" ? 2 : 1);
    expect(rows.map((row) => row.kind)).toEqual(action === "create" ? kinds : ["30s", "2min"]);
    expect(JSON.parse(rows[0]!.sentences as string)).toEqual(generated);
    if (action === "regenerate") expect(JSON.parse(rows[1]!.sentences as string)).toEqual(original);
  });

  it("接受句末标点位于闭合引号前后的完整句子", async () => {
    const sentences = [
      { text: "我参与过接口开发！", comment: "以具体职责定位，避免夸大贡献。" },
      { text: "我负责测试（尚未上线）。", comment: "保留了项目当前的验证状态。" },
      { text: "他说“参与接口开发。”", comment: "以具体职责定位，避免夸大贡献。" },
    ];
    const response = await generate(action, output(sentences));
    expect(response.status).toBe(200);
  });

  it("各版本生成字数与句数达到硬上限时完整保存", async () => {
    const boundaryOutput = {
      versions: kinds.map((kind) => {
        const limits = INTRO_GENERATED_LIMITS[kind as "30s" | "2min"];
        const baseLength = Math.floor(limits.totalTextChars / limits.maxSentences);
        const extra = limits.totalTextChars % limits.maxSentences;
        const sentences = Array.from({ length: limits.maxSentences }, (_, index) => {
          const textLength = baseLength + (index < extra ? 1 : 0);
          return {
            text: "字".repeat(textLength - 1) + "。",
            comment: "评".repeat(limits.totalCommentChars / limits.maxSentences),
          };
        });
        return { kind, sentences };
      }),
    };
    const response = await generate(action, boundaryOutput);
    expect(response.status).toBe(200);
    if (action === "create") expect(response.body).toContain("event: done");
    for (const version of boundaryOutput.versions) {
      const row = db.prepare("SELECT sentences FROM intro_versions WHERE intro_id=? AND kind=?")
        .get(action === "create" ? 2 : 1, version.kind) as { sentences: string };
      expect(JSON.parse(row.sentences)).toEqual(version.sentences);
    }
  });
});

it.each(["valid", "invalid", "upstream-error"])("创建流不转发未校验模型片段（%s），只有校验并存档后才完成", async (mode) => {
  const before = stored();
  const secret = '{"versions":[{"text":"不完整临时正文不得显示"';
  model.safeChatStream.mockImplementationOnce(async (...args: unknown[]) => {
    (args[4] as (delta: string) => void)(secret);
    if (mode === "upstream-error") throw new Error("合成上游失败");
    return mode === "valid" ? JSON.stringify({ versions: ["30s", "2min"].map((kind) => ({ kind, sentences: generated })) }) : secret;
  });
  const response = await (await import("@/app/api/intros/route")).POST(new Request("http://localhost/api/intros", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resume_id: 1, jd: "接口开发" }),
  }));
  const body = await response.text();
  expect(body).not.toContain("event: delta");
  expect(body).not.toContain("不完整临时正文不得显示");
  if (mode === "valid") {
    expect(body).toContain("event: done");
    expect(db.prepare("SELECT sentences FROM intro_versions WHERE intro_id = 2").all()).toHaveLength(2);
  } else {
    expect(body).toContain("event: error");
    expect(body).not.toContain("event: done");
    expect(stored()).toEqual(before);
  }
});

describe("自我介绍重新点评的逐句对应与原稿保护", () => {
  const source = [
    { text: "  我参与过接口开发。\n", comment: "旧点评一" },
    { text: "项目处理延迟 < 1 秒 & 尚未上线。", comment: "旧点评二" },
  ];
  beforeEach(() => {
    db.prepare("UPDATE intro_versions SET sentences=? WHERE intro_id=1 AND kind='30s'").run(JSON.stringify(source));
  });
  async function recomment(output: unknown, raw?: string) {
    model.safeChat.mockResolvedValueOnce(raw ?? JSON.stringify(output));
    const { POST } = await import("@/app/api/intros/[id]/recomment/route");
    return POST(new Request("http://localhost/api/intros/1/recomment", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "30s" }),
    }), { params: Promise.resolve({ id: "1" }) });
  }

  it.each([
    ["围栏", (json: string) => ["```json", json, "```"].join("\n")],
    ["前置说明", (json: string) => `以下为初稿：\n${json}`],
    ["后置说明", (json: string) => `${json}\n上述分工仍需修订。`],
    ["追加截断内容", (json: string) => `${json}\n{"correction":`],
  ] as const)("%s 的模型回复不截取后保存，保留正文与点评，纯 JSON 可显式重试", async (_label, wrap) => {
    const before = stored();
    const comments = ["保留实际参与范围。", "保留尚未上线的限定。"];
    const json = JSON.stringify({ comments });
    expect((await recomment(null, wrap(json))).status).toBe(502);
    expect(stored()).toEqual(before);
    expect(model.safeChat.mock.calls[0]!.at(-1)).toMatchObject({ requireJson: "strict" });
    const retried = await recomment(null, ` \n${json}\t `);
    expect(retried.status).toBe(200);
    expect(model.safeChat).toHaveBeenCalledTimes(2);
    expect((await retried.json()).sentences).toEqual(source.map((sentence, index) => ({ ...sentence, comment: comments[index] })));
    expect(stored().intros).toEqual(before.intros);
    expect(stored().versions[1]).toEqual(before.versions[1]);
    expect(JSON.parse(stored().versions[0]!.sentences as string)).toEqual(source.map((sentence, index) => ({ ...sentence, comment: comments[index] })));
  });

  it.each([
    ["缺少点评", {}], ["根值为空", null], ["根值为数组", []],
    ["未声明顶层字段", { comments: ["第一句点评", "第二句点评"], sentences: [] }],
    ["点评不是数组", { comments: "点评" }],
    ["少一条", { comments: ["第一句点评"] }],
    ["多一条", { comments: ["第一句点评", "第二句点评", "多余点评"] }],
    ["空点评", { comments: ["第一句点评", " \n "] }],
    ["仅含零宽字符的点评", { comments: ["第一句点评", "\u200b\u2060"] }],
    ["类型错误", { comments: ["第一句点评", 42] }],
    ["嵌套数组", { comments: ["第一句点评", ["第二句点评"]] }],
    ["点评超限", { comments: ["第一句点评", "字".repeat(INTRO_MAX_COMMENT_CHARS + 1)] }],
    ["新点评超限", { comments: ["第一句点评", "字".repeat(INTRO_GENERATED_COMMENT_MAX_CHARS + 1)] }],
  ])("拒绝%s且正文、原点评与修订信息不变", async (_label, output) => {
    const before = stored();
    expect((await recomment(output)).status).toBe(502);
    expect(stored()).toEqual(before);
  });

  it("JSON 损坏时不覆盖任一句原稿或点评", async () => {
    const before = stored();
    expect((await recomment(null, '{"comments":[')).status).toBe(502);
    expect(stored()).toEqual(before);
  });

  it.each([
    ["损坏 JSON", "{broken"], ["非数组原稿", "{}"], ["null 原稿", "null"],
    ["混入无效句", JSON.stringify([...source, null])],
    ["混入空句", JSON.stringify([...source, { text: " \n ", comment: "不可静默丢弃" }])],
    ["正文类型错误", JSON.stringify([...source, { text: 42, comment: "旧点评" }])],
    ["旧点评类型错误", JSON.stringify([{ text: "正文", comment: null }])],
    ["正文超限", JSON.stringify([{ text: "字".repeat(INTRO_MAX_TEXT_CHARS + 1), comment: "" }])],
    ["句数超限", JSON.stringify(Array.from({ length: INTRO_MAX_SENTENCES + 1 }, () => source[0]))],
  ])("原稿%s时返回 422，保留完整原始数据且不调用模型", async (_label, sentences) => {
    db.prepare("UPDATE intro_versions SET sentences=? WHERE intro_id=1 AND kind='30s'").run(sentences);
    const before = stored();
    expect((await recomment({ comments: ["新点评一", "新点评二"] })).status).toBe(422);
    expect(model.safeChat).not.toHaveBeenCalled();
    expect(stored()).toEqual(before);
  });

  it("正常空原稿保持 400，不调用模型", async () => {
    db.exec("UPDATE intro_versions SET sentences='[]' WHERE intro_id=1 AND kind='30s'");
    const before = stored();
    expect((await recomment({ comments: [] })).status).toBe(400);
    expect(model.safeChat).not.toHaveBeenCalled();
    expect(stored()).toEqual(before);
  });

  it("点评按序完整保存，正文字符与其他版本保持不变", async () => {
    const before = stored();
    const comments = ["  说明具体职责，不扩大个人贡献。  ", "指标需要核对，保留尚未上线的限定。"];
    const response = await recomment({ comments });
    expect(response.status).toBe(200);
    const result = await response.json();
    const expected = source.map((sentence, index) => ({ text: sentence.text, comment: comments[index]!.trim() }));
    expect(result.sentences).toEqual(expected);
    expect(result.revision).toEqual(expect.any(String));
    const after = stored();
    expect(JSON.parse(after.versions[0]!.sentences as string)).toEqual(expected);
    expect(after.versions[1]).toEqual(before.versions[1]);
    expect(after.intros).toEqual(before.intros);
    const { GET } = await import("@/app/api/intros/[id]/route");
    const refreshed = await (await GET(new Request("http://localhost/api/intros/1"), { params: Promise.resolve({ id: "1" }) })).json();
    expect(refreshed.versions.find((version: { kind: string }) => version.kind === "30s")).toMatchObject({ sentences: expected, revision: result.revision });
  });

  it("最大句数与点评长度完整保存，句尾限定保留", async () => {
    const sentences = Array.from({ length: INTRO_MAX_SENTENCES }, (_, index) => ({ text: `第 ${index + 1} 句原稿。`, comment: "" }));
    const comments = sentences.map((_, index) => "评".repeat(INTRO_GENERATED_COMMENT_MAX_CHARS - 8) + String(index).padStart(4, "0") + "待核实");
    db.prepare("UPDATE intro_versions SET sentences=? WHERE intro_id=1 AND kind='30s'").run(JSON.stringify(sentences));
    const response = await recomment({ comments });
    expect(response.status).toBe(200);
    expect((await response.json()).sentences).toEqual(sentences.map((sentence, index) => ({ ...sentence, comment: comments[index] })));
  });

  it("允许编辑后为空或缺省的旧点评，完整保留正文", async () => {
    db.prepare("UPDATE intro_versions SET sentences=? WHERE intro_id=1 AND kind='30s'")
      .run(JSON.stringify([{ text: "编辑后的句子。" }, { text: "第二句话。", comment: "" }]));
    const response = await recomment({ comments: ["第一句新点评", "第二句新点评"] });
    expect(response.status).toBe(200);
    expect((await response.json()).sentences).toEqual([
      { text: "编辑后的句子。", comment: "第一句新点评" }, { text: "第二句话。", comment: "第二句新点评" },
    ]);
  });
});
