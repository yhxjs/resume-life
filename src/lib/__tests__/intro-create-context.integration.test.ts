import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wrapUntrustedData } from "../prompt-safety";

const model = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), chatStream: model.stream }));

const PREFIX = "resume-life-intro-create-context-";
const conflict = "参考简历或所选发布版本已变化或删除，请核对材料后重新生成";
const sentences = [{ text: "只参与接口校验，尚未上线。", comment: "保留个人职责与状态。" }];
const reply = JSON.stringify({ versions: ["30s", "2min"].map(kind => ({ kind, sentences })) });
let directory: string;
let db: DatabaseSync;
let firstVersion: number;
let secondVersion: number;
let applicationId: number;

beforeEach(async () => {
  vi.resetModules();
  model.stream.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'原参考简历','',''),(2,'其他简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'summary','summary','简介',?,'')")
    .run(JSON.stringify({ text: "原发布经历：参与接口校验，尚未上线。" }));
  const { publishResumeVersion } = await import("../resume-versions");
  firstVersion = publishResumeVersion(1, { name: "所选发布版" }).id;
  secondVersion = publishResumeVersion(1, { name: "另一个发布版" }).id;
  applicationId = (await import("../applications")).createApplication({ company: "甲公司", role: "接口校验", jd: "接口校验岗位", resume_id: 1, resume_version_id: firstVersion }).id;
  db.exec("INSERT INTO intros (id,resume_id,jd,created_at) VALUES (1,2,'其他存档必须保留','')");
  db.prepare("INSERT INTO intro_versions (intro_id,kind,sentences,updated_at) VALUES (1,'30s',?,'old')").run(JSON.stringify(sentences));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

function state() {
  return Object.fromEntries(["intros", "intro_versions", "application_preparation_resources", "applications", "resumes", "resume_modules", "resume_versions", "runtime_state"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

function writerChange(mutate: (writer: DatabaseSync) => void) {
  const writer = new DatabaseSync(path.join(directory, "resume-life.db"));
  try { writer.exec("PRAGMA foreign_keys = ON"); mutate(writer); }
  finally { writer.close(); }
  return state();
}

function changeSnapshot(writer: DatabaseSync, versionId: number, text: string) {
  const row = writer.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(versionId)!;
  const snapshot = JSON.parse(row.snapshot as string);
  snapshot.modules[0].content.text = text;
  writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), versionId);
}

async function create(extra: Record<string, unknown> = {}) {
  return (await import("@/app/api/intros/route")).POST(new Request("http://localhost/api/intros", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resume_id: 1, resume_version_id: firstVersion, jd: "接口校验岗位", ...extra }),
  }));
}

async function pause(extra: Record<string, unknown> = {}) {
  const entered = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<string>();
  model.stream.mockImplementationOnce(() => { entered.resolve(); return completion.promise; });
  const response = await create(extra);
  expect(response.status).toBe(200);
  const text = response.text();
  await entered.promise;
  return { text, release: () => completion.resolve(reply) };
}

async function outputLimit() {
  const { LlmResponseError } = await import("../llm-adapter");
  return new LlmResponseError("SYNTHETIC_PRIVATE_MARKER", "incomplete", "output_limit");
}

const singleReply = (kind: string) => JSON.stringify({ versions: [{ kind, sentences }] });

describe("自我介绍输出上限恢复", () => {
  it("合并生成被截断后按原材料分版生成，两版齐全才一次性存档和关联", async () => {
    const before = state();
    model.stream.mockRejectedValueOnce(await outputLimit());
    for (const kind of ["30s", "2min"]) {
      model.stream.mockImplementationOnce(async () => {
        expect(state()).toEqual(before);
        return singleReply(kind);
      });
    }
    const response = await create({ application_id: applicationId });
    const text = await response.text();
    expect(text).toContain("event: done");
    expect(text).not.toMatch(/event: (error|delta)/);
    expect(model.stream).toHaveBeenCalledTimes(3);
    const calls = model.stream.mock.calls;
    expect(calls[1]![1][1].content).toContain("请只生成「30 秒版」");
    expect(calls[2]![1][1].content).toContain("请只生成「2 分钟版」");
    for (const [, messages, , options] of calls) {
      expect(messages[1].content).toContain(wrapUntrustedData("job_description", "接口校验岗位"));
      expect(messages[1].content).toContain("原发布经历");
      expect(options).toMatchObject({ requireJson: "strict", requestId: calls[0]![3].requestId });
      expect(options.maxTokens).toBeUndefined();
    }
    expect(state().intros).toHaveLength(before.intros!.length + 1);
    expect(state().intro_versions).toHaveLength(before.intro_versions!.length + 2);
    expect(state().application_preparation_resources).toHaveLength(1);
  });

  it.each(["30s", "2min"])("分版 %s 仍触顶时不循环重试、不落半份资料，并提示设置", async kind => {
    const before = state();
    model.stream.mockRejectedValueOnce(await outputLimit());
    if (kind === "2min") model.stream.mockResolvedValueOnce(singleReply("30s"));
    model.stream.mockRejectedValueOnce(await outputLimit());
    const text = await (await create({ application_id: applicationId })).text();
    expect(text).toContain("分版生成仍达到模型输出上限");
    expect(text).toContain("设置");
    expect(text).toContain('"outcome":"not_saved"');
    expect(text).not.toContain("SYNTHETIC_PRIVATE_MARKER");
    expect(text).not.toMatch(/event: (done|delta)/);
    expect(model.stream).toHaveBeenCalledTimes(kind === "30s" ? 2 : 3);
    expect(state()).toEqual(before);
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain('"errorCode":"output_limit"');
  });

  it.each(["content_filter", "refusal", "context_limit", null] as const)("非输出上限的未完成原因 %s 不触发分版重试", async reason => {
    const before = state();
    const { LlmResponseError } = await import("../llm-adapter");
    model.stream.mockRejectedValueOnce(new LlmResponseError("SYNTHETIC_PRIVATE_MARKER", "incomplete", reason));
    const text = await (await create()).text();
    expect(text).toContain('"outcome":"not_saved"');
    expect(text).not.toContain("SYNTHETIC_PRIVATE_MARKER");
    expect(text).not.toContain("分版生成");
    expect(model.stream).toHaveBeenCalledOnce();
    expect(state()).toEqual(before);
  });

  it.each(["wrong-kind", "incomplete-json"])("分版返回 %s 时拒绝整组，也不继续请求长版", async mode => {
    const before = state();
    model.stream.mockRejectedValueOnce(await outputLimit())
      .mockResolvedValueOnce(mode === "wrong-kind" ? singleReply("2min") : '{"versions":');
    const text = await (await create()).text();
    expect(text).toContain("AI 生成结果异常");
    expect(text).toContain('"outcome":"not_saved"');
    expect(model.stream).toHaveBeenCalledTimes(2);
    expect(state()).toEqual(before);
  });

  it("分版期间岗位材料改变时，完整结果仍不能保存到旧岗位上下文", async () => {
    model.stream.mockRejectedValueOnce(await outputLimit()).mockResolvedValueOnce(singleReply("30s"));
    let afterChange: ReturnType<typeof state>;
    model.stream.mockImplementationOnce(async () => {
      afterChange = writerChange(writer => writer.prepare("UPDATE applications SET jd='新岗位要求' WHERE id=?").run(applicationId));
      return singleReply("2min");
    });
    const text = await (await create({ application_id: applicationId })).text();
    expect(text).toContain("投递 JD 已变更");
    expect(text).not.toContain("event: done");
    expect(text).not.toContain("not_saved");
    expect(state()).toEqual(afterChange!);
  });
});

describe("自我介绍创建的材料提交边界", () => {
  it("模型流中断时给出可操作提示并保持未保存状态", async () => {
    const before = state();
    const { LlmResponseError } = await import("../llm-adapter");
    model.stream.mockRejectedValueOnce(new LlmResponseError("SYNTHETIC_PRIVATE_MARKER", "protocol", "interrupted"));
    const text = await (await create()).text();
    expect(text).toContain("模型服务连接中断");
    expect(text).toContain('"outcome":"not_saved"');
    expect(text).not.toContain("SYNTHETIC_PRIVATE_MARKER");
    expect(text).not.toMatch(/event: (done|delta)/);
    expect(model.stream).toHaveBeenCalledOnce();
    expect(state()).toEqual(before);
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain('"errorCode":"interrupted"');
  });

  it("创建使用有效发布版时保留损坏草稿，仍可正常生成两版", async () => {
    db.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run("{broken-draft");
    model.stream.mockResolvedValue(reply);
    expect(await (await create()).text()).toContain("event: done");
    const messages = model.stream.mock.calls[0]![1] as { content: string }[];
    expect(messages[1]!.content).toContain("原发布经历");
    expect(messages[1]!.content).not.toContain("broken-draft");
    expect(db.prepare("SELECT content FROM resume_modules WHERE resume_id=1").get()!.content).toBe("{broken-draft");
    expect(db.prepare("SELECT COUNT(*) AS count FROM intros").get()!.count).toBe(2);
  });

  it.each(["{broken-snapshot", "null"])("创建前所选材料无法读取时明确拒绝，零调用零写入：%s", async (snapshot) => {
    db.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(snapshot, firstVersion);
    const before = state();
    model.stream.mockResolvedValue(reply);
    const response = await create();
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("材料损坏");
    expect(model.stream).not.toHaveBeenCalled();
    expect(state()).toEqual(before);
  });

  it.each(["{broken-snapshot", "null"])("等待期间发布材料无法读取时保留明确材料冲突：%s", async (snapshot) => {
    const pending = await pause();
    try {
      const afterChange = writerChange(writer => writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(snapshot, firstVersion));
      pending.release();
      const text = await pending.text;
      expect(text).toContain(conflict);
      expect(text).not.toContain("event: done");
      expect(state()).toEqual(afterChange);
    } finally { pending.release(); await pending.text; }
  });

  it.each(["发布材料变化", "删除所选版本", "版本归属变化", "删除简历"]
    .flatMap(change => [false, true].map(linked => ({ change, linked }))))("等待模型期间 $change，投递关联 $linked，明确报错且所有并发修改保留", async ({ change, linked }) => {
    const pending = await pause(linked ? { application_id: applicationId } : {});
    try {
      const afterChange = writerChange(writer => {
        if (change === "发布材料变化") changeSnapshot(writer, firstVersion, "已经变化的新发布材料");
        if (change === "删除所选版本") writer.prepare("DELETE FROM resume_versions WHERE id=?").run(firstVersion);
        if (change === "版本归属变化") writer.prepare("UPDATE resume_versions SET resume_id=2 WHERE id=?").run(firstVersion);
        if (change === "删除简历") writer.exec("DELETE FROM resumes WHERE id=1");
      });
      pending.release();
      const text = await pending.text;
      expect(text).toContain("event: error");
      expect(text).toContain(conflict);
      expect(text).not.toContain("event: done");
      expect(state()).toEqual(afterChange);
      expect(model.stream).toHaveBeenCalledTimes(1);
    } finally { pending.release(); await pending.text; }
  });

  it.each(["JD", "发布版本", "删除"])("等待时投递%s变化，保留明确业务错误且不创建或关联介绍", async change => {
    const pending = await pause({ application_id: applicationId });
    try {
      const afterChange = writerChange(writer => {
        if (change === "JD") writer.prepare("UPDATE applications SET jd='新 JD' WHERE id=?").run(applicationId);
        if (change === "发布版本") writer.prepare("UPDATE applications SET resume_version_id=? WHERE id=?").run(secondVersion, applicationId);
        if (change === "删除") writer.prepare("DELETE FROM applications WHERE id=?").run(applicationId);
      });
      pending.release();
      const text = await pending.text;
      expect(text).toContain(change === "删除" ? "投递记录不存在或已删除" : change === "JD" ? "投递 JD 已变更" : "投递关联简历版本已变更");
      expect(text).not.toContain("event: done");
      expect(state()).toEqual(afterChange);
    } finally { pending.release(); await pending.text; }
  });

  it("全局恢复世代保护仍阻止旧创建，即使所选材料完全相同", async () => {
    const pending = await pause();
    try {
      const afterChange = writerChange(writer => writer.exec("INSERT INTO runtime_state (id,data_generation) VALUES (1,'restored-generation') ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation"));
      pending.release();
      const text = await pending.text;
      expect(text).toContain("数据已恢复，请刷新后重新操作");
      expect(text).not.toContain("event: done");
      expect(state()).toEqual(afterChange);
    } finally { pending.release(); await pending.text; }
  });

  it("材料变化后仅显式新请求才创建，使用重新读取的材料而非旧回复", async () => {
    const pending = await pause();
    try {
      const afterChange = writerChange(writer => changeSnapshot(writer, firstVersion, "新材料：只参与测试，尚未交付。"));
      pending.release();
      expect(await pending.text).toContain(conflict);
      expect(state()).toEqual(afterChange);
      model.stream.mockResolvedValueOnce(reply);
      expect(await (await create()).text()).toContain("event: done");
      expect(model.stream).toHaveBeenCalledTimes(2);
      const messages = model.stream.mock.calls[1]![1] as { content: string }[];
      expect(messages[1]!.content).toContain(wrapUntrustedData("candidate_resume", JSON.stringify([{
        type: "summary", label: "简介", text: "新材料：只参与测试，尚未交付。", descriptionItems: ["原发布经历：参与接口校验，尚未上线。"],
      }])));
      expect(db.prepare("SELECT COUNT(*) AS count FROM intros").get()!.count).toBe(2);
    } finally { pending.release(); await pending.text; }
  });

  it.each(["当前草稿", "发布新版本", "其他版本材料", "标题与排版"])("等待时%s变化不影响已选发布材料，创建两版并关联一次", async change => {
    const pending = await pause({ application_id: applicationId });
    try {
      if (change === "发布新版本") (await import("../resume-versions")).publishResumeVersion(1, { name: "新发布版" });
      else writerChange(writer => {
        if (change === "当前草稿") writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "未选中的新草稿" }));
        if (change === "其他版本材料") changeSnapshot(writer, secondVersion, "另一个版本的新材料");
        if (change === "标题与排版") writer.exec("UPDATE resumes SET title='新标题',template='modern',style_overrides='{}' WHERE id=1");
      });
      const before = state();
      pending.release();
      const text = await pending.text;
      expect(text).toContain("event: done");
      expect(text).not.toContain("event: error");
      const after = state();
      expect(after.intros).toHaveLength(before.intros!.length + 1);
      expect(after.intro_versions).toHaveLength(before.intro_versions!.length + 2);
      expect(after.application_preparation_resources).toHaveLength(1);
      expect(after.intros!.find(row => row.id !== 1)).toMatchObject({ resume_version_id: firstVersion, resume_id: 1 });
      expect(after.intros![0]).toEqual(before.intros![0]);
      for (const table of ["applications", "resumes", "resume_modules", "resume_versions"]) expect(after[table]).toEqual(before[table]);
    } finally { pending.release(); await pending.text; }
  });

  it("自动选择最新版本后保持本次选择，不因后来发布而偷偷换版", async () => {
    const pending = await pause({ resume_version_id: undefined });
    try {
      (await import("../resume-versions")).publishResumeVersion(1, { name: "后来发布" });
      pending.release();
      expect(await pending.text).toContain("event: done");
      expect(db.prepare("SELECT resume_version_id FROM intros WHERE id<>1").get()!.resume_version_id).toBe(secondVersion);
    } finally { pending.release(); await pending.text; }
  });

  it("关联写入失败仍整体回滚介绍与两版，保留原有存档", async () => {
    db.exec("CREATE TRIGGER fail_intro_link BEFORE INSERT ON application_preparation_resources WHEN NEW.intro_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic link failure'); END");
    const before = state();
    model.stream.mockResolvedValueOnce(reply);
    const response = await create({ application_id: applicationId });
    expect(await response.text()).toContain("event: error");
    expect(state()).toEqual(before);
  });
});
