import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JD_PORTRAIT_OUTPUT_LIMITS as LIMITS, parseJdPortraitResult } from "../jd-portrait";
import { JD_PORTRAIT_SYSTEM_PROMPT } from "../jd-portrait-llm";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({
  ...await original<typeof import("@/lib/llm")>(), chat: model.chat,
}));
const PREFIX = "resume-life-jd-output-";
const jd = "维护 TypeScript 平台。Azure Kubernetes Service 经验仅为加分项，不是硬性要求。";
const report = {
  role: "平台开发岗位",
  must_skills: [{ name: "Azure Kubernetes Service", weight: 4, why: "JD 提及该项经验，但仅为加分项，不是硬性要求" }],
  followups: [{ topic: "平台维护", questions: ["如果需要排查类型错误，你会如何定位？"] }],
  company_style: { style: "明确维护职责，团队协作风格信息不足", signals: ["维护 TypeScript 平台"] },
};
let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.prepare("INSERT INTO applications (id,company,role,stage,jd,created_at,updated_at) VALUES (1,'合成公司','平台开发','interested',?,'original','original')").run(jd);
  db.prepare("INSERT INTO jd_portraits (id,jd,result,created_at) VALUES (1,'历史岗位',?,'original')")
    .run(JSON.stringify({ role: "历史画像", mustSkills: [], followups: [], companyStyle: { style: "历史说明", signals: [] } }));
  db.exec("INSERT INTO application_preparation_resources (application_id,portrait_id) VALUES (1,1)");
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

function snapshot() {
  return {
    portraits: db.prepare("SELECT * FROM jd_portraits ORDER BY id").all(),
    links: db.prepare("SELECT * FROM application_preparation_resources ORDER BY id").all(),
    applications: db.prepare("SELECT * FROM applications ORDER BY id").all(),
  };
}
function changed(field: string, value: unknown): unknown {
  const output = structuredClone(report) as Record<string, unknown>;
  const keys = field.split(".");
  let target = output;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = value;
  return output;
}
async function generate(output: unknown) {
  model.chat.mockResolvedValueOnce(JSON.stringify(output));
  const { POST } = await import("@/app/api/tools/jd-portraits/route");
  return POST(new Request("http://localhost/api/tools/jd-portraits", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jd, application_id: 1 }),
  }));
}
const textFields: [string, number][] = [
  ["role", LIMITS.role], ["must_skills.0.name", LIMITS.skillName], ["must_skills.0.why", LIMITS.skillWhy],
  ["followups.0.topic", LIMITS.topic], ["followups.0.questions.0", LIMITS.question],
  ["company_style.style", LIMITS.companyStyle], ["company_style.signals.0", LIMITS.signal],
];

describe("JD 画像保留完整名称、条件与全部条目", () => {
  it.each(["——", "（）", "「」 \n\t", "\u200b", "（\u200b）？"])("拒绝无内容追问 %j，不新增画像或投递关联", async (question) => {
    const before = snapshot();
    expect((await generate(changed("followups.0.questions.0", question))).status).toBe(502);
    expect(snapshot()).toEqual(before);
  });

  it("有效追问保留技术运算符，不以问号判断有无内容", async () => {
    const question = "解释 C++ 中 operator< 与 operator> 的用途";
    expect((await generate(changed("followups.0.questions.0", question))).status).toBe(201);
    const saved = snapshot().portraits.at(-1)!;
    expect(parseJdPortraitResult(String(saved.result))?.followups[0]?.questions).toEqual([question]);
    expect(model.chat.mock.calls[0]![1][0].content).toContain("问题不得只含标点或空白");
    expect(model.chat.mock.calls[0]![1][0].content).toContain("也不得仅用零宽、控制字符等不可见字符占位");
  });

  it.each(textFields)("拒绝 %s 中仅含不可见字符或纯标点的文本，不新增画像或投递关联", async (field) => {
    const before = snapshot();
    for (const placeholder of ["\u200b\u2060", "!!!"]) {
      expect((await generate(changed(field, placeholder))).status).toBe(502);
      expect(snapshot()).toEqual(before);
    }
  });

  it("必填字段拒绝占位，但允许空技能、追问与信号列表", async () => {
    const sparse = { ...report, role: "岗位信息不足", must_skills: [], followups: [], company_style: { style: "无法推断", signals: [] } };
    expect((await generate(sparse)).status).toBe(201);
    expect(JD_PORTRAIT_SYSTEM_PROMPT).toContain("所有必填文本及已提供的列表项必须包含可见内容");
    expect(JD_PORTRAIT_SYSTEM_PROMPT).toContain("规则允许为空的数组仍返回 []");
  });

  it("中文解释要求保留英文技术专名，与保存协议一致", async () => {
    const response = await generate(report);
    expect(response.status).toBe(201);
    const system = model.chat.mock.calls[0]![1][0].content;
    expect(system).toContain("说明性文字使用中文");
    expect(system).toContain("JSON 字段名、规定枚举、原文引文、技术名称和公司/产品专名保留原样");
    expect(system).not.toContain("全部用中文");
    const saved = snapshot().portraits.at(-1)!;
    expect(parseJdPortraitResult(String(saved.result))?.mustSkills[0]?.name).toBe("Azure Kubernetes Service");
  });

  it("追问方向和每个方向的问题数区分常见篇幅与硬上限", () => {
    expect(JD_PORTRAIT_SYSTEM_PROMPT).toContain(`通常 3-5 个基于 JD 技术点或业务场景的练习方向，材料少时可减少，最多 ${LIMITS.followups} 个`);
    expect(JD_PORTRAIT_SYSTEM_PROMPT).toContain(`每个方向通常给 2-4 个具体问题，材料不足时可缩减到 1 个，最多 ${LIMITS.questions} 个`);
  });

  it.each([
    ["围栏", (json: string) => ["```json", json, "```"].join("\n")],
    ["前置说明", (json: string) => `以下为初稿：\n${json}`],
    ["后置说明", (json: string) => `${json}\n仍需核实上述条件。`],
    ["追加截断内容", (json: string) => `${json}\n{"correction":`],
  ] as const)("%s 的模型回复整份拒绝，不新增画像或关联，纯 JSON 重试可正常保存", async (_label, wrap) => {
    const before = snapshot();
    model.chat.mockResolvedValueOnce(wrap(JSON.stringify(report)));
    const { POST } = await import("@/app/api/tools/jd-portraits/route");
    const response = await POST(new Request("http://localhost/api/tools/jd-portraits", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jd, application_id: 1 }),
    }));
    expect(response.status).toBe(502);
    expect(snapshot()).toEqual(before);
    expect((await generate(report)).status).toBe(201);
    expect(model.chat).toHaveBeenCalledTimes(2);
    expect(snapshot().portraits.slice(0, -1)).toEqual(before.portraits);
    expect(snapshot().links).toHaveLength(before.links.length + 1);
  });

  it.each([
    { mustSkills: [] },
    { role: "历史画像", mustSkills: [null], followups: [], companyStyle: { style: "信息不足", signals: [] } },
    { role: "历史画像", mustSkills: [], followups: [{ topic: "原方向", questions: {} }], companyStyle: { style: "信息不足", signals: [] } },
  ])("GET 遇到损坏历史结构返回恢复状态，原始 JD、关联和记录不被改写（%#）", async (output) => {
    const source = "原 JD <T> &amp;\n规模与团队安排尚未确认。";
    db.prepare("UPDATE jd_portraits SET jd=?, result=? WHERE id=1").run(source, JSON.stringify(output));
    const before = snapshot();
    const { GET } = await import("@/app/api/tools/jd-portraits/[id]/route");
    const response = await GET(new Request("http://localhost/api/tools/jd-portraits/1"), { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 1, jd: source, result: null, created_at: "original" });
    expect(snapshot()).toEqual(before);
    expect(model.chat).not.toHaveBeenCalled();
  });

  it.each(textFields)("%s 超限时整份拒绝，不创建画像或资料关联", async (field, limit) => {
    const before = snapshot();
    const response = await generate(changed(field, "字".repeat(limit + 1)));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("超限");
    expect(snapshot()).toEqual(before);
  });

  it.each(textFields)("%s 达到上限时完整保存句尾限定并可正常回读", async (field, limit) => {
    const ending = "不是硬性要求";
    const value = "字".repeat(limit - ending.length) + ending;
    const response = await generate(changed(field, value));
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const saved = db.prepare("SELECT * FROM jd_portraits WHERE id=?").get(id)!;
    const parsed = parseJdPortraitResult(String(saved.result))!;
    const storedPath = field.replace("must_skills", "mustSkills").replace("company_style", "companyStyle");
    let stored: unknown = parsed;
    for (const key of storedPath.split(".")) stored = (stored as Record<string, unknown>)[key];
    expect(stored).toBe(value);
    expect(db.prepare("SELECT portrait_id FROM application_preparation_resources WHERE portrait_id=?").all(id)).toEqual([{ portrait_id: id }]);
    const { GET } = await import("@/app/api/tools/jd-portraits/[id]/route");
    expect((await (await GET(new Request("http://localhost/api/tools/jd-portraits"), { params: Promise.resolve({ id: String(id) }) })).json()).result).toEqual(parsed);
    const { invalidDomainColumn } = await import("../backup-domain");
    expect(invalidDomainColumn("jd_portraits", saved)).toBeUndefined();
  });

  it.each([
    ["must_skills", [...report.must_skills, null]],
    ["must_skills", Array.from({ length: LIMITS.skills + 1 }, (_, index) => ({ ...report.must_skills[0], name: `技能${index}` }))],
    ["must_skills", [...report.must_skills, { ...report.must_skills[0], name: " azure kubernetes service " }]],
    ["must_skills", [...report.must_skills, { ...report.must_skills[0], name: "Ａｚｕｒｅ Kubernetes Service" }]],
    ["must_skills.0.why", undefined], ["must_skills.0.why", "  "],
    ["followups", [...report.followups, null]],
    ["followups", Array.from({ length: LIMITS.followups + 1 }, (_, index) => ({ topic: `主题${index}`, questions: [`问题${index}`] }))],
    ["followups", [...report.followups, { ...report.followups[0], topic: " 平台维护 ", questions: ["另一个问题"] }]],
    ["followups", [{ ...report.followups[0]!, topic: "平台 维护" }, { topic: "平台   维护", questions: ["另一个问题"] }]],
    ["followups", [...report.followups, { topic: "其他主题", questions: [...report.followups[0]!.questions] }]],
    ["followups.0.questions", [report.followups[0]!.questions[0], false]],
    ["followups.0.questions", [report.followups[0]!.questions[0], "  "]],
    ["followups.0.questions", []],
    ["followups.0.questions", Array.from({ length: LIMITS.questions + 1 }, (_, index) => `问题${index}`)],
    ["followups.0.questions", ["如何定位？", " 如何定位？ "]],
    ["followups.0.questions", ["确认 API 经验吗？", "确认 ａｐｉ　经验吗！"]],
    ["followups.0.questions", ["如何定位？", "如何定位？ \n ！"]],
    ["followups", [{ topic: "第一方向", questions: ["如何定位？"] }, { topic: "第二方向", questions: ["如何定位？ \n ！"] }]],
    ["company_style.signals", ["明确维护职责", false]],
    ["company_style.signals", ["明确维护职责", " 明确维护职责 "]],
    ["company_style.signals", ["Maintain TypeScript", " ｍａｉｎｔａｉｎ   typescript "]],
    ["company_style.signals", Array.from({ length: LIMITS.signals + 1 }, (_, index) => `信号${index}`)],
    ["company_style.signals", undefined],
  ] as [string, unknown][])("%s 的无效、超项或重复结果不丢项后保存（%#）", async (field, value) => {
    const before = snapshot();
    expect((await generate(changed(field, value))).status).toBe(502);
    expect(snapshot()).toEqual(before);
  });

  it("合法长技术名完整保存，非法结果后可重试，旧画像保持不变", async () => {
    const before = snapshot();
    expect((await generate(changed("must_skills.0.weight", "4"))).status).toBe(502);
    expect(snapshot()).toEqual(before);
    const response = await generate(report);
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const after = snapshot();
    expect(after.portraits.slice(0, -1)).toEqual(before.portraits);
    expect(after.applications).toEqual(before.applications);
    expect(after.links).toHaveLength(before.links.length + 1);
    expect(parseJdPortraitResult(String(after.portraits.at(-1)!.result))?.mustSkills).toEqual(report.must_skills);
    expect(after.links.at(-1)).toMatchObject({ application_id: 1, portrait_id: id });
    const [, messages, options] = model.chat.mock.calls[1]! as [string, { role: string; content: string }[], { signal: AbortSignal; requireJson: "strict" }];
    const { wrapUntrustedData } = await import("../prompt-safety");
    expect(messages[1]!.content).toContain(wrapUntrustedData("job_description", jd));
    expect(options.requireJson).toBe("strict");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([0, 1, 2])("接受 %i 个技能的稀疏画像，不补造考点、问题或公司信号", async (count) => {
    const sparse = { ...report, role: count ? "平台开发岗位" : "岗位信息不足", must_skills: Array.from({ length: count }, (_, index) => ({ name: `技能${index}`, weight: 1, why: "弱关联线索" })), followups: [], company_style: { style: "无法推断", signals: [] } };
    const response = await generate(sparse);
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const { result } = db.prepare("SELECT result FROM jd_portraits WHERE id=?").get(id) as { result: string };
    expect(parseJdPortraitResult(result)).toEqual({ role: sparse.role, mustSkills: sparse.must_skills, followups: [], companyStyle: { style: "无法推断", signals: [] } });
  });

  it("各数组达到上限时完整保留末项，不再清洗掉部分方向或问题", async () => {
    const output = {
      ...report,
      must_skills: Array.from({ length: LIMITS.skills }, (_, index) => ({ name: `技能${index}`, weight: LIMITS.skills - index, why: `要求${index}，具体范围待确认` })),
      followups: Array.from({ length: LIMITS.followups }, (_, index) => ({
        topic: `主题${index}`, questions: Array.from({ length: LIMITS.questions }, (_, number) => `主题${index}的具体练习问题${number}？`),
      })),
      company_style: { style: "信息不足，仍需核实", signals: Array.from({ length: LIMITS.signals }, (_, index) => `原文信号${index}`) },
    };
    const response = await generate(output);
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const { result } = db.prepare("SELECT result FROM jd_portraits WHERE id=?").get(id) as { result: string };
    expect(parseJdPortraitResult(result)).toEqual({ role: output.role, mustSkills: output.must_skills, followups: output.followups, companyStyle: output.company_style });
  });
});
