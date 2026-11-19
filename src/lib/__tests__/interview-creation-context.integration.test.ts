import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wrapUntrustedData } from "../prompt-safety";

const model = vi.hoisted(() => ({ chat: vi.fn(), chatStream: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
const PREFIX = "resume-life-interview-creation-context-";
const conflict = "参考简历或所选发布版本已变化或删除，请核对材料后重新生成";
const advanceConflict = "参考简历或所选发布版本已变化或删除，请核对材料后重新推进";
const question = "请说明一次实际参与的接口验证过程。";
const reply = JSON.stringify({ question });
let directory: string;
let db: DatabaseSync;
let firstVersion: number;
let secondVersion: number;
let applicationId: number;

beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset(); model.chatStream.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'所选简历','',''),(2,'其他简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'summary','summary','简介',?,'')")
    .run(JSON.stringify({ text: "原发布经历：只参与校验，尚未上线。" }));
  const { publishResumeVersion } = await import("../resume-versions");
  firstVersion = publishResumeVersion(1, { name: "固定发布版" }).id;
  secondVersion = publishResumeVersion(1, { name: "另一发布版" }).id;
  applicationId = (await import("../applications")).createApplication({ company: "甲公司", role: "接口校验", jd: "接口校验岗位", resume_id: 1, resume_version_id: firstVersion }).id;
  db.prepare("INSERT INTO interview_series (id,resume_id,resume_version_id,jd,rounds,created_at) VALUES (1,1,?,'接口校验岗位',1,'')").run(firstVersion);
  db.prepare(`INSERT INTO interviews (id,resume_id,resume_version_id,jd,rounds,style,series_id,round_no,status,report,created_at)
    VALUES (1,1,?,'接口校验岗位',1,'deep',1,1,'finished',?,'')`).run(firstVersion, JSON.stringify({
      depth: 5, structure: 6, authenticity: 6, completeness: 5, jd_match: 6, overall: 5.6,
      strengths: "职责明确", weaknesses: "结果待验证", suggestions: "核对验收记录",
    }));
  db.exec(`INSERT INTO interviews (id,resume_id,jd,rounds,created_at) VALUES (2,2,'其他存档',1,'');
    INSERT INTO interview_turns (id,interview_id,idx,question,answer,comment,answered_at)
      VALUES (1,1,1,'你实际负责哪些工作？','只负责校验','原点评','已答'),(2,2,1,'其他存档原题','其他存档原答','其他点评','已答');
    INSERT INTO notebook_entries (id,source,source_id,question,answer,comment,created_at,updated_at)
      VALUES (1,'interview',2,'收藏原题','收藏原答','收藏点评','','');
    INSERT INTO review_cards (notebook_id,next_review_date,created_at) VALUES (1,'2026-10-29','');
    INSERT INTO review_attempts (card_id,request_id,answer,grade,reviewed_at,review_date,interval_days,next_review_date)
      VALUES (1,'8249702d-1da9-4976-938b-fd4e3f988b32','复习原答','good','2026-10-28T00:00:00Z','2026-10-28',1,'2026-10-29');`);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});
function state() {
  return Object.fromEntries(["resumes", "resume_modules", "resume_versions", "applications", "application_preparation_resources", "interviews", "interview_series", "interview_turns", "notebook_entries", "review_cards", "review_attempts", "runtime_state"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}
function writerChange(mutate: (writer: DatabaseSync) => void) {
  const writer = new DatabaseSync(path.join(directory, "resume-life.db"));
  try { writer.exec("PRAGMA foreign_keys=ON"); mutate(writer); } finally { writer.close(); }
  return state();
}
function changeSnapshot(writer: DatabaseSync, versionId: number, text: string) {
  const row = writer.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(versionId)!;
  const snapshot = JSON.parse(row.snapshot as string); snapshot.modules[0].content.text = text;
  writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), versionId);
}
const request = (body: unknown) => new Request("http://localhost/api/interviews", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
async function create(mode: string, extra: Record<string, unknown> = {}) {
  return (await import("@/app/api/interviews/route")).POST(request({ resume_id: 1, resume_version_id: firstVersion, jd: "接口校验岗位", mode, rounds: 1, ...extra }));
}
const invalidJsonWrappers = [
  ["围栏", (json: string) => ["```json", json, "```"].join("\n")],
  ["前置说明", (json: string) => `以下为初稿：\n${json}`],
  ["后置说明", (json: string) => `${json}\n上述首题仍需修订。`],
  ["追加截断内容", (json: string) => `${json}\n{"correction":`],
] as const;

describe.each([
  { mode: "single", style: "gentle" },
  { mode: "single", style: "mining" },
  { mode: "series", style: "deep" },
])("$mode / $style 首题的完整 JSON 协议", ({ mode, style }) => {
  it("拒绝题目对象中的额外字段，不创建面试", async () => {
    const output = JSON.stringify({ question, extra: true });
    model.chatStream.mockResolvedValueOnce(output);
    const before = state();
    const events = await (await create(mode, { style, application_id: applicationId })).text();
    expect(events).toContain("event: error");
    expect(events).not.toContain("event: done");
    expect(state()).toEqual(before);
  });

  it.each(invalidJsonWrappers)("%s 不展示首题或创建关联记录，纯 JSON 可显式重试", async (_label, wrap) => {
    const raw = wrap(reply);
    model.chatStream.mockImplementationOnce(async (_model, _messages, onDelta) => { onDelta(raw); return raw; });
    const before = state();
    const events = await (await create(mode, { style, application_id: applicationId })).text();
    expect(events).toContain("event: error");
    expect(events).not.toMatch(/event: (done|delta)/);
    expect(state()).toEqual(before);
    expect(model.chatStream.mock.calls[0]![3]).toMatchObject({ requireJson: "strict" });
    model.chatStream.mockResolvedValueOnce(` \n${reply}\t `);
    const retry = await (await create(mode, { style, application_id: applicationId })).text();
    expect(retry).toContain("event: done");
    expect(retry).toContain(question);
    expect(model.chatStream).toHaveBeenCalledTimes(2);
    const created = db.prepare("SELECT id,series_id FROM interviews WHERE id>2").get() as { id: number; series_id: number | null };
    expect(db.prepare("SELECT question FROM interview_turns WHERE interview_id=?").get(created.id)).toEqual({ question });
    expect(db.prepare("SELECT interview_id,series_id FROM application_preparation_resources").get())
      .toEqual({ interview_id: mode === "single" ? created.id : null, series_id: created.series_id });
    expect(state().interviews).toHaveLength(before.interviews!.length + 1);
  });
});
async function pauseCreate(mode: string, extra: Record<string, unknown> = {}) {
  const entered = Promise.withResolvers<void>(); const completion = Promise.withResolvers<string>();
  model.chatStream.mockImplementationOnce(() => { entered.resolve(); return completion.promise; });
  const response = await create(mode, extra); expect(response.status).toBe(200);
  const text = response.text(); await entered.promise;
  return { text, release: () => completion.resolve(reply) };
}
function mutateSource(writer: DatabaseSync, change: string) {
  if (change === "发布材料") changeSnapshot(writer, firstVersion, "新材料：只参与测试，尚未交付。");
  if (change === "删除所选版本") writer.prepare("DELETE FROM resume_versions WHERE id=?").run(firstVersion);
  if (change === "版本归属") writer.prepare("UPDATE resume_versions SET resume_id=2 WHERE id=?").run(firstVersion);
  if (change === "删除简历") writer.exec("DELETE FROM resumes WHERE id=1");
}
async function benignChange(change: string) {
  if (change === "发布新版本") (await import("../resume-versions")).publishResumeVersion(1, { name: "后来发布" });
  else writerChange(writer => {
    if (change === "当前草稿") writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "未选中的新草稿" }));
    if (change === "其他版本") changeSnapshot(writer, secondVersion, "另一版本的新材料");
    if (change === "标题排版及身份字段") {
      writer.exec("UPDATE resumes SET title='新标题',template='modern',style_overrides='{}' WHERE id=1");
      const row = writer.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(firstVersion)!;
      const snapshot = JSON.parse(row.snapshot as string);
      snapshot.title = "新的存档标题"; snapshot.template = "modern";
      snapshot.modules.push({ key: "basic", type: "basic", label: "基本信息", sort: 0, content: { name: "不传模型的新姓名", phone: "不传模型的新电话" } });
      writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), firstVersion);
    }
  });
}

describe.each(["single", "series"])("%s 创建提交材料复核", mode => {
  it.each(["发布材料", "删除所选版本", "版本归属", "删除简历"].flatMap(change => [false, true].map(linked => ({ change, linked }))))("另一连接改变$change，投递关联$linked，不保存旧首题", async ({ change, linked }) => {
    const pending = await pauseCreate(mode, linked ? { application_id: applicationId } : {});
    try {
      const changed = writerChange(writer => mutateSource(writer, change)); pending.release();
      const events = await pending.text; expect(events).toContain(conflict);
      expect(events).toContain("event: error"); expect(events).not.toMatch(/event: (done|delta)/);
      expect(state()).toEqual(changed); expect(model.chatStream).toHaveBeenCalledOnce();
    } finally { pending.release(); await pending.text; }
  });
  it.each(["JD", "发布版本", "删除"])("投递%s变化保留具体业务提示，不新增场次或资料关联", async change => {
    const pending = await pauseCreate(mode, { application_id: applicationId });
    try {
      const changed = writerChange(writer => {
        if (change === "JD") writer.prepare("UPDATE applications SET jd='新 JD' WHERE id=?").run(applicationId);
        if (change === "发布版本") writer.prepare("UPDATE applications SET resume_version_id=? WHERE id=?").run(secondVersion, applicationId);
        if (change === "删除") writer.prepare("DELETE FROM applications WHERE id=?").run(applicationId);
      });
      pending.release(); const events = await pending.text;
      expect(events).toContain(change === "删除" ? "投递记录不存在或已删除" : change === "JD" ? "投递 JD 已变更" : "投递关联简历版本已变更");
      expect(events).not.toMatch(/event: (done|delta)/); expect(state()).toEqual(changed);
    } finally { pending.release(); await pending.text; }
  });
  it.each(["当前草稿", "发布新版本", "其他版本", "标题排版及身份字段"])("%s变化仍按固定职业材料创建并只关联一次", async change => {
    const pending = await pauseCreate(mode, { application_id: applicationId });
    try {
      await benignChange(change); const before = state(); pending.release();
      const events = await pending.text; expect(events).not.toContain("event: error");
      const match = events.match(/event: done\ndata: ([^\n]+)/); expect(match, events).not.toBeNull();
      const created = JSON.parse(match![1]!); const after = state();
      expect(db.prepare("SELECT resume_id,resume_version_id,series_id FROM interviews WHERE id=?").get(created.id)).toEqual({ resume_id: 1, resume_version_id: firstVersion, series_id: created.series_id });
      expect(after.interviews).toHaveLength(before.interviews!.length + 1);
      expect(after.interview_turns).toHaveLength(before.interview_turns!.length + 1);
      expect(after.interview_series).toHaveLength(before.interview_series!.length + (mode === "series" ? 1 : 0));
      expect(after.application_preparation_resources).toHaveLength(1);
      expect(db.prepare("SELECT interview_id,series_id FROM application_preparation_resources").get()).toEqual({ interview_id: mode === "single" ? created.id : null, series_id: created.series_id });
      for (const table of ["resumes", "resume_modules", "resume_versions", "applications", "notebook_entries", "review_cards", "review_attempts"]) expect(after[table]).toEqual(before[table]);
      const messages = model.chatStream.mock.calls[0]![1] as { content: string }[];
      expect(messages[1]!.content).toContain(wrapUntrustedData("candidate_resume", JSON.stringify([{
        type: "summary", label: "简介", text: "原发布经历：只参与校验，尚未上线。", descriptionItems: ["原发布经历：只参与校验，尚未上线。"],
      }])));
      expect(JSON.stringify(messages)).not.toMatch(/不传模型的新姓名|不传模型的新电话|未选中的新草稿/);
    } finally { pending.release(); await pending.text; }
  });
  it("省略版本时仅在开始选最新，后来发布不偷换材料", async () => {
    const pending = await pauseCreate(mode, { resume_version_id: undefined });
    try {
      await benignChange("发布新版本"); pending.release();
      expect(await pending.text).toContain("event: done");
      expect(db.prepare("SELECT resume_version_id FROM interviews WHERE id>2").get()!.resume_version_id).toBe(secondVersion);
    } finally { pending.release(); await pending.text; }
  });
  it("拒绝旧回复后，显式新请求使用新材料", async () => {
    const pending = await pauseCreate(mode);
    try {
      const changed = writerChange(writer => mutateSource(writer, "发布材料")); pending.release();
      expect(await pending.text).toContain(conflict); expect(state()).toEqual(changed);
      model.chatStream.mockResolvedValueOnce(reply);
      expect(await (await create(mode)).text()).toContain("event: done"); expect(model.chatStream).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(model.chatStream.mock.calls[1]![1])).toContain("新材料：只参与测试，尚未交付。");
    } finally { pending.release(); await pending.text; }
  });
  it("恢复世代变化仍拒绝旧结果，即使材料相同", async () => {
    const pending = await pauseCreate(mode);
    try {
      const changed = writerChange(writer => writer.exec("INSERT INTO runtime_state (id,data_generation) VALUES (1,'restored-generation') ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation"));
      pending.release(); const events = await pending.text;
      expect(events).toContain("数据已恢复，请刷新后重新操作"); expect(events).not.toMatch(/event: (done|delta)/); expect(state()).toEqual(changed);
    } finally { pending.release(); await pending.text; }
  });
  it("关联插入故障整组回滚场次、首题及系列", async () => {
    db.exec("CREATE TRIGGER fail_interview_link BEFORE INSERT ON application_preparation_resources WHEN NEW.interview_id IS NOT NULL OR NEW.series_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic link failure'); END");
    const before = state(); model.chatStream.mockResolvedValueOnce(reply);
    const events = await (await create(mode, { application_id: applicationId })).text();
    expect(events).toContain("event: error"); expect(events).not.toMatch(/event: (done|delta)/); expect(state()).toEqual(before);
  });
});

async function advance() {
  return (await import("@/app/api/interviews/series/[id]/advance/route")).POST(request({ from_interview_id: 1 }), { params: Promise.resolve({ id: "1" }) });
}
async function pauseAdvance() {
  const entered = Promise.withResolvers<void>(); const completion = Promise.withResolvers<string>();
  model.chat.mockImplementationOnce(() => { entered.resolve(); return completion.promise; });
  const response = advance(); await entered.promise;
  return { response, release: () => completion.resolve(reply) };
}
describe("进阶推进的简历提交边界", () => {
  it.each(invalidJsonWrappers)("%s 的模型回复不截取后推进，释放锁后纯 JSON 可重试", async (_label, wrap) => {
    model.chat.mockResolvedValueOnce(wrap(reply));
    const before = state();
    expect((await advance()).status).toBe(502);
    expect(state()).toEqual(before);
    expect(model.chat.mock.calls[0]![2]).toMatchObject({ requireJson: "strict" });
    model.chat.mockResolvedValueOnce(` \n${reply}\t `);
    const retry = await advance();
    expect(retry.status).toBe(201);
    const created = await retry.json();
    expect(db.prepare("SELECT question FROM interview_turns WHERE interview_id=?").get(created.id)).toEqual({ question });
    const saved = state();
    expect(await (await advance()).json()).toEqual(created);
    expect(state()).toEqual(saved);
    expect(model.chat).toHaveBeenCalledTimes(2);
  });
  it.each(["发布材料", "删除所选版本", "版本归属", "删除简历"])("%s变化不保存旧首题，原并发修改保留", async change => {
    const pending = await pauseAdvance();
    try {
      const changed = writerChange(writer => mutateSource(writer, change)); pending.release();
      const response = await pending.response; expect(response.status).toBe(409);
      expect((await response.json()).error).toContain(change === "发布材料" || change === "版本归属" ? advanceConflict : "已变更");
      expect(state()).toEqual(changed); expect(model.chat).toHaveBeenCalledOnce();
    } finally { pending.release(); await pending.response; }
  });
  it.each(["当前草稿", "发布新版本", "其他版本", "标题排版及身份字段"])("%s变化仍使用固定版本推进", async change => {
    const pending = await pauseAdvance();
    try {
      await benignChange(change); const before = state(); pending.release();
      const response = await pending.response; expect(response.status).toBe(201); const created = await response.json();
      expect(db.prepare("SELECT resume_version_id,round_no FROM interviews WHERE id=?").get(created.id)).toEqual({ resume_version_id: firstVersion, round_no: 2 });
      const after = state(); expect(after.interviews).toHaveLength(before.interviews!.length + 1); expect(after.interview_turns).toHaveLength(before.interview_turns!.length + 1);
      for (const table of ["resumes", "resume_modules", "resume_versions", "applications", "interview_series", "notebook_entries", "review_cards", "review_attempts"]) expect(after[table]).toEqual(before[table]);
    } finally { pending.release(); await pending.response; }
  });
  it("旧未绑定版本的系列复核实际草稿，拒绝后释放锁，新请求按新草稿推进", async () => {
    db.exec("UPDATE interview_series SET resume_version_id=NULL WHERE id=1");
    const pending = await pauseAdvance();
    try {
      const changed = writerChange(writer => writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "旧系列的新草稿材料" })));
      pending.release(); const response = await pending.response;
      expect(response.status).toBe(409); expect((await response.json()).error).toBe(advanceConflict); expect(state()).toEqual(changed);
      model.chat.mockResolvedValueOnce(reply);
      expect((await advance()).status).toBe(201); expect(model.chat).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(model.chat.mock.calls[1]![1])).toContain("旧系列的新草稿材料");
    } finally { pending.release(); await pending.response; }
  });
  it("已绑定版本变更后拒绝旧结果，新请求读取新材料且已有下一轮不重复生成", async () => {
    const pending = await pauseAdvance();
    try {
      const changed = writerChange(writer => mutateSource(writer, "发布材料")); pending.release();
      expect((await pending.response).status).toBe(409); expect(state()).toEqual(changed);
      model.chat.mockResolvedValueOnce(reply); const retry = await advance(); expect(retry.status).toBe(201); const created = await retry.json();
      expect(JSON.stringify(model.chat.mock.calls[1]![1])).toContain("新材料：只参与测试，尚未交付。");
      const after = state(); expect(await (await advance()).json()).toEqual(created);
      expect(model.chat).toHaveBeenCalledTimes(2); expect(state()).toEqual(after);
    } finally { pending.release(); await pending.response; }
  });
});
