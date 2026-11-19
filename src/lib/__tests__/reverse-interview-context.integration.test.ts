import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wrapUntrustedData } from "../prompt-safety";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));

const PREFIX = "resume-life-reverse-context-";
const reply = JSON.stringify({
  answer: "实际安排尚不明确，建议向招聘方确认。",
  evaluation: { score: 8, insight: "关注协作边界", feedback: "问题具体", suggestions: "保留当前问题。" },
});
let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset().mockResolvedValue(reply);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec(`INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'合成简历','',''),(2,'其他简历','','');
    INSERT INTO interviews (id,resume_id,jd,created_at) VALUES (1,1,'原岗位 <TypeScript>',''),(2,2,'其他岗位','');
    INSERT INTO interview_turns (id,interview_id,idx,kind,question,answer,answered_at)
      VALUES (1,1,4,'question','你负责哪些验证？','只做接口校验与联调，未上线。','已答'),
        (2,1,5,'followup','尚未提交的题目','草稿',''),
        (3,2,1,'question','其他场题目','其他场原答','已答');`);
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'summary','summary','简介',?,'')")
    .run(JSON.stringify({ text: "原经历：参与接口校验，尚未上线。" }));
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

function state() {
  return {
    interviews: db.prepare("SELECT * FROM interviews ORDER BY id").all(),
    turns: db.prepare("SELECT * FROM interview_turns ORDER BY id").all(),
    resumes: db.prepare("SELECT * FROM resumes ORDER BY id").all(),
    modules: db.prepare("SELECT * FROM resume_modules ORDER BY id").all(),
    versions: db.prepare("SELECT * FROM resume_versions ORDER BY id").all(),
    notebook: db.prepare("SELECT * FROM notebook_entries ORDER BY id").all(),
  };
}

async function generate() {
  const { POST } = await import("@/app/api/interviews/[id]/reverse/route");
  return POST(new Request("http://localhost/api/interviews/1/reverse", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "岗位里如何安排联调和验收？" }),
  }), { params: Promise.resolve({ id: "1" }) });
}

function changeDuringReply(mutate: (writer: DatabaseSync) => void) {
  let afterChange: ReturnType<typeof state>;
  model.chat.mockImplementationOnce(async () => {
    const writer = new DatabaseSync(path.join(directory, "resume-life.db"));
    try {
      writer.exec("PRAGMA foreign_keys = ON");
      mutate(writer);
    } finally {
      writer.close();
    }
    afterChange = state();
    return reply;
  });
  return () => afterChange;
}

describe("反问的生成依据一致性", () => {
  const changes: [string, (writer: DatabaseSync) => void][] = [
    ["岗位", (writer) => writer.exec("UPDATE interviews SET jd='新岗位：兼容性验证 <TypeScript>' WHERE id=1")],
    ["人设", (writer) => writer.exec("UPDATE interviews SET style='stress' WHERE id=1")],
    ["简历绑定", (writer) => writer.exec("UPDATE interviews SET resume_id=2 WHERE id=1")],
    ["简历正文", (writer) => writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "新经历，仍未上线。" }))],
    ["删除简历正文", (writer) => writer.exec("DELETE FROM resume_modules WHERE resume_id=1")],
    ["历史原题", (writer) => writer.exec("UPDATE interview_turns SET question='改后的原题' WHERE id=1")],
    ["历史原答", (writer) => writer.exec("UPDATE interview_turns SET answer='更正：没有做过缓存，只有联调。' WHERE id=1")],
    ["历史题型", (writer) => writer.exec("UPDATE interview_turns SET kind='followup' WHERE id=1")],
    ["历史题号", (writer) => writer.exec("UPDATE interview_turns SET idx=3 WHERE id=1")],
    ["删除已答记录", (writer) => writer.exec("DELETE FROM interview_turns WHERE id=1")],
    ["撤回历史原答", (writer) => writer.exec("UPDATE interview_turns SET answered_at='' WHERE id=1")],
    ["新增已答记录", (writer) => writer.exec("UPDATE interview_turns SET answered_at='刚提交' WHERE id=2")],
  ];

  it.each(changes)("等待模型时%s变化，拒绝旧结果且保留已发生的修改", async (_label, mutate) => {
    const afterChange = changeDuringReply(mutate);
    const response = await generate();
    expect(response.status).toBe(409);
    expect(state()).toEqual(afterChange());
    expect(model.chat).toHaveBeenCalledOnce();
  });

  it("材料冲突后释放锁，重试使用新的完整上下文", async () => {
    changeDuringReply((writer) => {
      writer.exec("UPDATE interviews SET jd='新岗位：兼容性验证 <TypeScript>' WHERE id=1");
      writer.exec("UPDATE interview_turns SET answer='新原答：只做联调，尚未上线。' WHERE id=1");
    });
    expect((await generate()).status).toBe(409);
    expect((await generate()).status).toBe(200);
    const messages = model.chat.mock.calls[1]![1] as { content: string }[];
    const input = messages.slice(1).map((message) => message.content).join("\n");
    expect(input).toContain(wrapUntrustedData("job_description", "新岗位：兼容性验证 <TypeScript>"));
    expect(input).toContain(wrapUntrustedData("candidate_answer", "新原答：只做联调，尚未上线。"));
    expect(model.chat).toHaveBeenCalledTimes(2);
  });

  it("未传入模型的元数据、旧点评和其他记录变化，不误报冲突", async () => {
    changeDuringReply((writer) => {
      writer.exec("UPDATE interviews SET created_at='新时间' WHERE id=1; UPDATE interviews SET jd='其他场新岗位' WHERE id=2");
      writer.exec("UPDATE interview_turns SET comment='新的旧点评',scores='{}',reference='新的旧参考',answered_at='另一个非空时间' WHERE id=1");
      writer.exec("UPDATE interview_turns SET question='新的未答题',answer='新的未提交草稿' WHERE id=2");
      writer.exec("UPDATE interview_turns SET answer='其他场新原答' WHERE id=3");
      writer.exec("UPDATE resumes SET title='新标题',template='modern',updated_at='新时间' WHERE id=1");
    });
    expect((await generate()).status).toBe(200);
  });
});

describe("反问的发布简历版本依据", () => {
  async function bindVersion() {
    const { publishResumeVersion } = await import("../resume-versions");
    const first = publishResumeVersion(1, { name: "第一版" }).id;
    const second = publishResumeVersion(1, { name: "第二版" }).id;
    db.prepare("UPDATE interviews SET resume_version_id=? WHERE id=1").run(first);
    return { first, second };
  }

  it.each(["切换版本", "修改发布正文", "删除绑定版本", "损坏发布材料"])("等待模型时%s，拒绝旧结果", async (change) => {
    const { first, second } = await bindVersion();
    const afterChange = changeDuringReply((writer) => {
      if (change === "切换版本") writer.prepare("UPDATE interviews SET resume_version_id=? WHERE id=1").run(second);
      if (change === "删除绑定版本") writer.prepare("DELETE FROM resume_versions WHERE id=?").run(first);
      if (change === "损坏发布材料") writer.prepare("UPDATE resume_versions SET snapshot='not JSON' WHERE id=?").run(first);
      if (change === "修改发布正文") {
        const row = writer.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(first)!;
        const snapshot = JSON.parse(row.snapshot as string);
        snapshot.modules[0].content.text = "发布材料已更正";
        writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), first);
      }
    });
    expect((await generate()).status).toBe(409);
    expect(state()).toEqual(afterChange());
  });

  it("绑定发布版本时，修改当前草稿或快照字段顺序不会使结果失效", async () => {
    const { first } = await bindVersion();
    changeDuringReply((writer) => {
      writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "后来编辑的草稿，不是本次材料。" }));
      const row = writer.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(first)!;
      const snapshot = JSON.parse(row.snapshot as string);
      writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify(Object.fromEntries(Object.entries(snapshot).reverse())), first);
    });
    expect((await generate()).status).toBe(200);
    const messages = model.chat.mock.calls[0]![1] as { content: string }[];
    const input = messages.slice(1).map((message) => message.content).join("\n");
    expect(input).toContain("原经历：参与接口校验，尚未上线。");
    expect(input).not.toContain("后来编辑的草稿");
  });
});
