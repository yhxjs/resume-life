import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wrapUntrustedData } from "../prompt-safety";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));

const PREFIX = "resume-life-intro-context-";
const original = [{ text: "我参与接口校验与联调，尚未上线。", comment: "原点评" }];
const generated = [{ text: "我的职责是接口校验及联调，尚未上线。", comment: "保留职责和状态。" }];
let directory: string;
let db: DatabaseSync;
let firstVersion: number;
let secondVersion: number;

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'合成简历','',''),(2,'其他简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'summary','summary','简介',?,'')")
    .run(JSON.stringify({ text: "原经历：参与接口校验，尚未上线。" }));
  const { publishResumeVersion } = await import("../resume-versions");
  firstVersion = publishResumeVersion(1, { name: "首个版本" }).id;
  secondVersion = publishResumeVersion(1, { name: "另一个版本" }).id;
  db.prepare("INSERT INTO intros (id,resume_id,resume_version_id,jd,created_at) VALUES (1,1,?,'接口校验岗位','')").run(firstVersion);
  db.exec("INSERT INTO intros (id,resume_id,jd,created_at) VALUES (2,2,'其他介绍的岗位','')");
  for (const kind of ["30s", "2min"]) {
    db.prepare("INSERT INTO intro_versions (intro_id,kind,sentences,updated_at) VALUES (1,?,?,'original')").run(kind, JSON.stringify(original));
  }
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
    intros: db.prepare("SELECT * FROM intros ORDER BY id").all(),
    versions: db.prepare("SELECT * FROM intro_versions ORDER BY id").all(),
    resumes: db.prepare("SELECT * FROM resumes ORDER BY id").all(),
    modules: db.prepare("SELECT * FROM resume_modules ORDER BY id").all(),
    snapshots: db.prepare("SELECT * FROM resume_versions ORDER BY id").all(),
  };
}

function reply(action: string) {
  return JSON.stringify(action === "regenerate" ? { versions: [{ kind: "30s", sentences: generated }] } : { comments: ["更新后的点评"] });
}

async function generate(action: string) {
  const handler = action === "regenerate"
    ? (await import("@/app/api/intros/[id]/regenerate/route")).POST
    : (await import("@/app/api/intros/[id]/recomment/route")).POST;
  return handler(new Request(`http://localhost/api/intros/1/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "30s" }),
  }), { params: Promise.resolve({ id: "1" }) });
}

function changeDuringReply(action: string, mutate: (writer: DatabaseSync) => void) {
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
    return reply(action);
  });
  return () => afterChange;
}

describe.each(["regenerate", "recomment"])("自我介绍 %s 的生成依据一致性", (action) => {
  it("等待模型时 JD 变化，拒绝过期结果且可按新岗位重试", async () => {
    const afterChange = changeDuringReply(action, (writer) => writer.exec("UPDATE intros SET jd='新岗位：兼容性验证 <TypeScript>' WHERE id=1"));
    const response = await generate(action);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("更新");
    expect(state()).toEqual(afterChange());

    model.chat.mockResolvedValueOnce(reply(action));
    expect((await generate(action)).status).toBe(200);
    const messages = model.chat.mock.calls[1]![1] as { content: string }[];
    expect(messages[1]!.content).toContain(wrapUntrustedData("job_description", "新岗位：兼容性验证 <TypeScript>"));
    expect(JSON.parse(db.prepare("SELECT sentences FROM intro_versions WHERE intro_id=1 AND kind='2min'").get()!.sentences as string)).toEqual(original);
  });

  it("其他介绍和未请求版本的变化不阻止本次保存", async () => {
    const otherSentences = JSON.stringify([{ text: "另一个版本的新句子", comment: "" }]);
    changeDuringReply(action, (writer) => {
      writer.exec("UPDATE intros SET jd='其他岗位已更新' WHERE id=2");
      writer.prepare("UPDATE intro_versions SET sentences=? WHERE intro_id=1 AND kind='2min'").run(otherSentences);
    });
    expect((await generate(action)).status).toBe(200);
    expect(db.prepare("SELECT sentences FROM intro_versions WHERE intro_id=1 AND kind='2min'").get()!.sentences).toBe(otherSentences);
    expect(db.prepare("SELECT jd FROM intros WHERE id=2").get()!.jd).toBe("其他岗位已更新");
  });
});

describe("自我介绍重生成的简历依据", () => {
  it.each([false, true])("旧记录职业模块损坏时拒绝空回退，其他职业材料存在 %s", async (hasOtherMaterial) => {
    db.exec("UPDATE intros SET resume_version_id=NULL WHERE id=1");
    db.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run("{broken-source");
    if (hasOtherMaterial) db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'skills','skills','技能',?,'')")
      .run(JSON.stringify({ items: ["了解 TypeScript，尚未独立使用。"] }));
    const before = state();
    model.chat.mockResolvedValue(reply("regenerate"));
    const response = await generate("regenerate");
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("材料损坏");
    expect(model.chat).not.toHaveBeenCalled();
    expect(state()).toEqual(before);
    db.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1 AND module_key='summary'")
      .run(JSON.stringify({ text: "修复后只参与校验，尚未上线。" }));
    expect((await generate("regenerate")).status).toBe(200);
    expect(model.chat).toHaveBeenCalledTimes(1);
    expect(model.chat.mock.calls[0]![1][1].content).toContain("修复后只参与校验，尚未上线。");
  });

  it("等待期间原本为空的职业模块损坏，即使投影仍为空也拒绝覆盖", async () => {
    db.exec("UPDATE intros SET resume_version_id=NULL WHERE id=1");
    db.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "" }));
    const afterChange = changeDuringReply("regenerate", writer => writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run("{broken-source"));
    expect((await generate("regenerate")).status).toBe(409);
    expect(state()).toEqual(afterChange());
  });

  it.each(["{broken-snapshot", "null"])("所选发布材料无法读取时返回明确错误：%s", async (snapshot) => {
    db.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(snapshot, firstVersion);
    const before = state();
    model.chat.mockResolvedValue(reply("regenerate"));
    expect((await generate("regenerate")).status).toBe(422);
    expect(model.chat).not.toHaveBeenCalled();
    expect(state()).toEqual(before);
  });

  it.each(["{broken-snapshot", "null"])("等待期间发布材料损坏返回冲突并保留原介绍：%s", async (snapshot) => {
    const afterChange = changeDuringReply("regenerate", writer => writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(snapshot, firstVersion));
    expect((await generate("regenerate")).status).toBe(409);
    expect(state()).toEqual(afterChange());
  });

  it("未使用的基本身份和排版损坏，不阻断旧记录的职业材料重生成", async () => {
    db.exec("UPDATE intros SET resume_version_id=NULL WHERE id=1");
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'basic','basic','基本信息',?,'')").run("{broken-identity");
    db.exec("UPDATE resumes SET style_overrides='{broken-style' WHERE id=1");
    model.chat.mockResolvedValue(reply("regenerate"));
    expect((await generate("regenerate")).status).toBe(200);
    const messages = model.chat.mock.calls[0]![1] as { content: string }[];
    expect(messages[1]!.content).toContain("原经历");
    expect(messages[1]!.content).not.toContain("broken-identity");
  });

  it.each(["修改", "删除"])("旧记录使用当前草稿，等待期间%s经历时拒绝旧结果", async (change) => {
    db.exec("UPDATE intros SET resume_version_id=NULL WHERE id=1");
    const afterChange = changeDuringReply("regenerate", (writer) => {
      if (change === "删除") writer.exec("DELETE FROM resume_modules WHERE resume_id=1");
      else writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "新经历：只参与验证，未上线。" }));
    });
    expect((await generate("regenerate")).status).toBe(409);
    expect(state()).toEqual(afterChange());
    model.chat.mockResolvedValueOnce(reply("regenerate"));
    expect((await generate("regenerate")).status).toBe(200);
    const messages = model.chat.mock.calls[1]![1] as { content: string }[];
    expect(messages[1]!.content).not.toContain("原经历");
    if (change === "修改") expect(messages[1]!.content).toContain("新经历：只参与验证，未上线。");
  });

  it.each(["切换简历", "切换版本", "版本内容变化", "删除绑定版本"])("等待期间%s时不覆盖介绍与点评", async (change) => {
    const afterChange = changeDuringReply("regenerate", (writer) => {
      if (change === "切换简历") writer.exec("UPDATE intros SET resume_id=2, resume_version_id=NULL WHERE id=1");
      if (change === "切换版本") writer.prepare("UPDATE intros SET resume_version_id=? WHERE id=1").run(secondVersion);
      if (change === "版本内容变化") {
        const row = writer.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(firstVersion)!;
        const snapshot = JSON.parse(row.snapshot as string);
        snapshot.modules[0].content.text = "发布材料已修改";
        writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), firstVersion);
      }
      if (change === "删除绑定版本") writer.prepare("DELETE FROM resume_versions WHERE id=?").run(firstVersion);
    });
    expect((await generate("regenerate")).status).toBe(409);
    expect(state()).toEqual(afterChange());
  });

  it("绑定发布版本时，编辑当前草稿不影响所选版本的生成", async () => {
    changeDuringReply("regenerate", (writer) => writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "后来编辑的草稿，不是本次材料。" })));
    expect((await generate("regenerate")).status).toBe(200);
    const messages = model.chat.mock.calls[0]![1] as { content: string }[];
    expect(messages[1]!.content).toContain("原经历");
    expect(messages[1]!.content).not.toContain("后来编辑的草稿");
  });

  it("有效发布版不受当前草稿职业模块损坏影响", async () => {
    db.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run("{broken-draft");
    model.chat.mockResolvedValue(reply("regenerate"));
    expect((await generate("regenerate")).status).toBe(200);
    const messages = model.chat.mock.calls[0]![1] as { content: string }[];
    expect(messages[1]!.content).toContain("原经历");
    expect(messages[1]!.content).not.toContain("broken-draft");
    expect(db.prepare("SELECT content FROM resume_modules WHERE resume_id=1").get()!.content).toBe("{broken-draft");
  });

  it("旧记录只修改未传入模型的标题与排版时不误报材料冲突", async () => {
    db.exec("UPDATE intros SET resume_version_id=NULL WHERE id=1");
    changeDuringReply("regenerate", (writer) => writer.exec("UPDATE resumes SET title='新标题',template='modern',style_overrides='{}',updated_at='later' WHERE id=1"));
    expect((await generate("regenerate")).status).toBe(200);
    expect(db.prepare("SELECT title FROM resumes WHERE id=1").get()!.title).toBe("新标题");
  });
});

it("重新点评未使用简历，关联与简历变化不阻止基于原句和 JD 的点评", async () => {
  changeDuringReply("recomment", (writer) => {
    writer.exec("UPDATE intros SET resume_id=2,resume_version_id=NULL WHERE id=1");
    writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "没有用于本次点评的新内容" }));
  });
  expect((await generate("recomment")).status).toBe(200);
  expect(JSON.parse(db.prepare("SELECT sentences FROM intro_versions WHERE intro_id=1 AND kind='30s'").get()!.sentences as string))
    .toEqual([{ text: original[0]!.text, comment: "更新后的点评" }]);
});

it("重新点评仅依赖原句与 JD，简历职业模块损坏仍保留原句完成点评", async () => {
  db.exec("UPDATE intros SET resume_version_id=NULL WHERE id=1");
  db.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run("{broken-source");
  model.chat.mockResolvedValue(reply("recomment"));
  expect((await generate("recomment")).status).toBe(200);
  expect(JSON.parse(db.prepare("SELECT sentences FROM intro_versions WHERE intro_id=1 AND kind='30s'").get()!.sentences as string))
    .toEqual([{ text: original[0]!.text, comment: "更新后的点评" }]);
});
