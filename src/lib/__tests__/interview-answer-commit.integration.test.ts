import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chatStream: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
const PREFIX = "resume-life-answer-commit-";
const conflict = "面试资料、当前题目或上下文已变化，请重新读取面试状态后再提交";
const answer = "本人仅负责参数校验，验收结论待确认。";
const result = { depth: 7, structure: 7, authenticity: 8, completeness: 7, comment: "保留个人职责与未确认状态。", next_kind: "question", next_question: "遇到字段不兼容时你会如何定位？" };
const reply = JSON.stringify(result);
let directory: string;
let db: DatabaseSync;
let firstVersion: number;
let secondVersion: number;

beforeEach(async () => {
  vi.resetModules(); model.chatStream.mockReset().mockResolvedValue(reply);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)); vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'所选材料','',''),(2,'其他材料','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'summary','summary','简介',?,'')").run(JSON.stringify({ text: "原发布材料：参与校验，尚未上线。" }));
  const { publishResumeVersion } = await import("../resume-versions");
  firstVersion = publishResumeVersion(1, { name: "固定材料" }).id; secondVersion = publishResumeVersion(1, { name: "另一发布版" }).id;
  db.prepare("INSERT INTO interview_series (id,resume_id,resume_version_id,jd,rounds,created_at) VALUES (1,1,?,'接口校验',3,'')").run(firstVersion);
  db.prepare(`INSERT INTO interviews (id,resume_id,resume_version_id,jd,rounds,style,series_id,round_no,status,report,created_at)
    VALUES (1,1,?,'接口校验',3,'deep',1,1,'finished',?,'')`).run(firstVersion, JSON.stringify({
      depth: 5, structure: 6, authenticity: 6, completeness: 5, jd_match: 6, overall: 5.6, strengths: "职责清楚", weaknesses: "验收待确认", suggestions: "核对验证记录",
    }));
  db.prepare(`INSERT INTO interviews (id,resume_id,resume_version_id,jd,rounds,style,series_id,round_no,created_at)
    VALUES (2,1,?,'接口校验',3,'manager',1,2,'')`).run(firstVersion);
  db.exec(`INSERT INTO interviews (id,resume_id,jd,rounds,created_at) VALUES (3,2,'其他场次',3,'');
    INSERT INTO interview_turns (id,interview_id,idx,question,answer,comment,reference,scores,answered_at)
      VALUES (1,1,1,'前轮原题','前轮原答','前轮点评','','','已答'),
        (2,2,1,'本轮历史原题','本轮历史原答','不应传入的旧点评','不应传入的旧参考','{}','已答'),
        (3,2,2,'请说明你实际负责的验证步骤。','','','','',''),(4,3,1,'其他场次原题','其他原答','','','','已答');
    INSERT INTO notebook_entries (id,source,source_id,question,answer,comment,reference,created_at,updated_at)
      VALUES (1,'interview',3,'请说明你实际负责的验证步骤。','','','','',''),
        (2,'interview',2,'独立收藏原题','独立收藏原答','独立收藏点评','独立收藏参考','','');
    INSERT INTO review_cards (id,notebook_id,next_review_date,created_at) VALUES (1,1,'2026-10-29',''),(2,2,'2026-10-29','');
    INSERT INTO review_attempts (card_id,request_id,answer,grade,reviewed_at,review_date,interval_days,next_review_date)
      VALUES (1,'853372fb-38fa-4f69-a211-75f2c9f1bfa7','复习原答','good','2026-10-28T00:00:00Z','2026-10-28',1,'2026-10-29');`);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});
function state() {
  return Object.fromEntries(["resumes", "resume_modules", "resume_versions", "interview_series", "interviews", "interview_turns", "notebook_entries", "review_cards", "review_attempts", "runtime_state"]
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
async function submit(signal?: AbortSignal) {
  return (await import("@/app/api/interviews/[id]/answer/route")).POST(new Request("http://localhost/api/interviews/2/answer", {
    method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turn_id: 3, answer }),
  }), { params: Promise.resolve({ id: "2" }) });
}
async function pause(signal?: AbortSignal) {
  const entered = Promise.withResolvers<void>(); const completion = Promise.withResolvers<string>();
  model.chatStream.mockImplementationOnce(() => { entered.resolve(); return completion.promise; });
  const response = await submit(signal); expect(response.status).toBe(200); const text = response.text(); await entered.promise;
  return { text, release: () => completion.resolve(reply) };
}
const changes: { label: string; mutate: (writer: DatabaseSync) => void }[] = [
  { label: "JD", mutate: writer => writer.exec("UPDATE interviews SET jd='新 JD' WHERE id=2") },
  { label: "考官风格", mutate: writer => writer.exec("UPDATE interviews SET style='mining' WHERE id=2") },
  { label: "题数", mutate: writer => writer.exec("UPDATE interviews SET rounds=2 WHERE id=2") },
  { label: "绑定版", mutate: writer => writer.prepare("UPDATE interviews SET resume_version_id=? WHERE id=2").run(secondVersion) },
  { label: "参考简历", mutate: writer => writer.exec("UPDATE interviews SET resume_id=2 WHERE id=2") },
  { label: "场次状态", mutate: writer => writer.exec("UPDATE interviews SET status='finished' WHERE id=2") },
  { label: "场次删除", mutate: writer => writer.exec("DELETE FROM interviews WHERE id=2") },
  { label: "当前题干", mutate: writer => writer.exec("UPDATE interview_turns SET question='更正后的当前题干' WHERE id=3") },
  { label: "当前题号", mutate: writer => writer.exec("UPDATE interview_turns SET idx=3 WHERE id=3") },
  { label: "当前题已答", mutate: writer => writer.exec("UPDATE interview_turns SET answer='另一进程原答',answered_at='已答' WHERE id=3") },
  { label: "当前题删除", mutate: writer => writer.exec("DELETE FROM interview_turns WHERE id=3") },
  { label: "已出现下一题", mutate: writer => writer.exec("INSERT INTO interview_turns (interview_id,idx,question) VALUES (2,3,'其他进程的下一题')") },
  { label: "历史原题", mutate: writer => writer.exec("UPDATE interview_turns SET question='更正后的历史原题' WHERE id=2") },
  { label: "历史原答", mutate: writer => writer.exec("UPDATE interview_turns SET answer='更正后的历史原答' WHERE id=2") },
  { label: "历史题号", mutate: writer => writer.exec("UPDATE interview_turns SET idx=0 WHERE id=2") },
  { label: "历史题型", mutate: writer => writer.exec("UPDATE interview_turns SET kind='followup' WHERE id=2") },
  { label: "历史题删除", mutate: writer => writer.exec("DELETE FROM interview_turns WHERE id=2") },
  { label: "历史题同文新 ID", mutate: writer => writer.exec("UPDATE interview_turns SET id=12 WHERE id=2") },
  { label: "新增已答历史", mutate: writer => writer.exec("INSERT INTO interview_turns (interview_id,idx,question,answer,answered_at) VALUES (2,0,'新增历史原题','新增历史原答','已答')") },
  { label: "所选发布材料", mutate: writer => changeSnapshot(writer, firstVersion, "新材料：参与测试，未交付。") },
  { label: "所选版本归属", mutate: writer => writer.prepare("UPDATE resume_versions SET resume_id=2 WHERE id=?").run(firstVersion) },
  { label: "所选版本删除", mutate: writer => writer.prepare("DELETE FROM resume_versions WHERE id=?").run(firstVersion) },
  { label: "简历删除", mutate: writer => writer.exec("DELETE FROM resumes WHERE id=1") },
];
describe.each(["single", "series"])("%s 作答提交快照", mode => {
  beforeEach(() => { if (mode === "single") db.exec("UPDATE interviews SET series_id=NULL,round_no=0 WHERE id=2"); });
  it.each(changes)("另一连接改变$label，旧评分与续题均不写入", async ({ mutate }) => {
    const pending = await pause();
    try {
      const changed = writerChange(mutate); pending.release(); const events = await pending.text;
      expect(events).toContain(conflict); expect(events).toContain("event: error"); expect(events).not.toMatch(/event: (delta|done)/);
      expect(state()).toEqual(changed); expect(model.chatStream).toHaveBeenCalledOnce();
    } finally { pending.release(); await pending.text; }
  });
});

it.each([
  { label: "前轮反馈", mutate: (writer: DatabaseSync) => writer.prepare("UPDATE interviews SET report=? WHERE id=1").run(JSON.stringify({ depth: 5, structure: 6, authenticity: 6, completeness: 5, jd_match: 6, strengths: "新反馈", weaknesses: "验收待确认", suggestions: "核对验证记录" })) },
  { label: "前轮原题", mutate: (writer: DatabaseSync) => writer.exec("UPDATE interview_turns SET question='更正前轮原题' WHERE id=1") },
  { label: "前轮题型", mutate: (writer: DatabaseSync) => writer.exec("UPDATE interview_turns SET kind='followup' WHERE id=1") },
  { label: "前轮题号", mutate: (writer: DatabaseSync) => writer.exec("UPDATE interview_turns SET idx=2 WHERE id=1") },
  { label: "当前所属轮次", mutate: (writer: DatabaseSync) => writer.exec("UPDATE interviews SET round_no=3 WHERE id=2") },
])("系列等待时改变$label，拒绝旧评分与下一题", async ({ mutate }) => {
  const pending = await pause();
  try {
    const changed = writerChange(mutate); pending.release(); const events = await pending.text;
    expect(events).toContain(conflict); expect(events).not.toMatch(/event: (delta|done)/); expect(state()).toEqual(changed);
  } finally { pending.release(); await pending.text; }
});

it.each(["草稿", "新发布版", "其他版本", "标题排版身份", "旧点评评分参考", "当前未提交原稿", "前轮未提供原答", "其他场次"])("%s变化不影响本次实际依据，继续保存且收藏复习保留", async change => {
  const pending = await pause();
  try {
    if (change === "新发布版") (await import("../resume-versions")).publishResumeVersion(1, { name: "后来发布" });
    else writerChange(writer => {
      if (change === "草稿") writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "未选中的草稿" }));
      if (change === "其他版本") changeSnapshot(writer, secondVersion, "其他版本的新材料");
      if (change === "标题排版身份") {
        writer.exec("UPDATE resumes SET title='新标题',template='modern' WHERE id=1");
        const snapshot = JSON.parse(writer.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(firstVersion)!.snapshot as string);
        snapshot.title = "新的快照标题"; snapshot.modules.push({ key: "basic", type: "basic", label: "基本信息", sort: 0, content: { name: "不传模型的身份" } });
        writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), firstVersion);
      }
      if (change === "旧点评评分参考") writer.exec("UPDATE interview_turns SET comment='新的旧点评',scores='新旧评分',reference='新旧参考',retries='[]' WHERE id=2");
      if (change === "当前未提交原稿") writer.exec("UPDATE interview_turns SET answer='尚未提交的其他草稿' WHERE id=3");
      if (change === "前轮未提供原答") writer.exec("UPDATE interview_turns SET answer='未提供给当前模型的前轮新原答' WHERE id=1");
      if (change === "其他场次") writer.exec("UPDATE interview_turns SET question='其他场次的新原题' WHERE id=4");
    });
    const before = state(); pending.release(); const events = await pending.text;
    expect(events).toContain("event: done"); expect(events).not.toContain("event: error");
    expect(db.prepare("SELECT answer,comment FROM interview_turns WHERE id=3").get()).toEqual({ answer, comment: result.comment });
    expect(db.prepare("SELECT question FROM interview_turns WHERE interview_id=2 AND idx=3").get()).toEqual({ question: result.next_question });
    expect(db.prepare("SELECT answer,comment FROM notebook_entries WHERE id=1").get()).toEqual({ answer, comment: result.comment });
    const after = state();
    expect(db.prepare("SELECT * FROM notebook_entries WHERE id=2").all()).toEqual((before.notebook_entries as { id: number }[]).filter(row => row.id === 2));
    for (const table of ["resumes", "resume_modules", "resume_versions", "interviews", "interview_series", "review_cards", "review_attempts"]) expect(after[table]).toEqual(before[table]);
    expect(db.prepare("SELECT * FROM interview_turns WHERE id IN (1,2,4) ORDER BY id").all()).toEqual((before.interview_turns as { id: number }[]).filter(row => row.id !== 3));
  } finally { pending.release(); await pending.text; }
});

it("拒绝旧上下文后释放命令锁，显式重试读取新原答与新材料", async () => {
  const pending = await pause();
  try {
    const changed = writerChange(writer => { writer.exec("UPDATE interview_turns SET answer='更正后的本轮原答：我仅参与测试。' WHERE id=2"); changeSnapshot(writer, firstVersion, "更正后的职业材料：未交付。"); });
    pending.release(); expect(await pending.text).toContain(conflict); expect(state()).toEqual(changed);
    const retried = await submit(); expect(await retried.text()).toContain("event: done"); expect(model.chatStream).toHaveBeenCalledTimes(2);
    const messages = JSON.stringify(model.chatStream.mock.calls[1]![1]);
    expect(messages).toContain("更正后的本轮原答：我仅参与测试。"); expect(messages).toContain("更正后的职业材料：未交付。");
  } finally { pending.release(); await pending.text; }
});
it("旧未绑定版本的场次在草稿变化时拒绝旧评分", async () => {
  db.exec("UPDATE interviews SET resume_version_id=NULL WHERE id=2"); const pending = await pause();
  try {
    const changed = writerChange(writer => writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "旧场次的新草稿材料" })));
    pending.release(); expect(await pending.text).toContain(conflict); expect(state()).toEqual(changed);
  } finally { pending.release(); await pending.text; }
});
it("已有缺失材料的历史场次继续沿用原占位，不自动换用当前草稿", async () => {
  db.prepare("UPDATE resume_versions SET resume_id=2 WHERE id=?").run(firstVersion);
  const response = await submit(); expect(await response.text()).toContain("event: done");
  expect(JSON.stringify(model.chatStream.mock.calls[0]![1])).toContain("（简历已删除）");
});
it.each(["取消", "恢复世代", "收藏补全故障"])("%s时整组不保存评分、续题或收藏补全", async reason => {
  if (reason === "收藏补全故障") db.exec("CREATE TRIGGER fail_answer_snapshot BEFORE UPDATE ON notebook_entries WHEN OLD.id=1 BEGIN SELECT RAISE(ABORT,'synthetic snapshot failure'); END");
  const controller = new AbortController(); const pending = await pause(controller.signal);
  try {
    if (reason === "取消") controller.abort();
    if (reason === "恢复世代") writerChange(writer => writer.exec("INSERT INTO runtime_state (id,data_generation) VALUES (1,'restored') ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation"));
    const before = state(); pending.release(); const events = await pending.text;
    expect(events).not.toMatch(/event: (delta|done)/); expect(state()).toEqual(before);
    if (reason === "恢复世代") expect(events).toContain("数据已恢复，请刷新后重新操作");
    if (reason === "收藏补全故障") expect(events).toContain("服务端处理失败");
  } finally { pending.release(); await pending.text; }
});
