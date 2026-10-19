import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "resume-life-restore-revisions-";
let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.prepare("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'简历','','')").run();
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'summary','summary','简介',?,'')")
    .run(JSON.stringify({ text: "原内容" }));
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

const context = { params: Promise.resolve({ id: "1" }) };
const patch = (body: unknown) => new Request("http://localhost/api/resumes/1", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

async function read() {
  const { GET } = await import("@/app/api/resumes/[id]/route");
  return (await GET(new Request("http://localhost/api/resumes/1"), context)).json();
}

async function restore() {
  const { exportAllData, restoreAllData } = await import("./backup-fixture");
  const payload = exportAllData();
  restoreAllData({
    stats: payload.meta.stats,
    sequences: payload.meta.sequences,
    files: [],
    readTableBatch(table: string, afterRowId = 0, limit = 200) {
      return (payload.data[table] ?? []).map((data, index) => ({ cursor: index + 1, data }))
        .filter((row) => row.cursor > afterRowId).slice(0, limit);
    },
    readFileBytes() { throw new Error("No files"); },
  }, false);
}

describe("简历客户端令牌跨备份恢复", () => {
  it.each(["title", "module"])("恢复同一基线后旧 %s 令牌拒绝写入，新令牌正常", async (field) => {
    const { PATCH } = await import("@/app/api/resumes/[id]/route");
    const initial = await read();
    await restore();
    const body = (state: typeof initial) => field === "title"
      ? { title: "新标题", titleRevision: state.resume.titleRevision }
      : { modules: { summary: { text: "新内容" } }, moduleRevisions: { summary: state.modules[0].revision } };
    expect((await PATCH(patch(body(initial)), context)).status).toBe(409);
    expect(db.prepare("SELECT title FROM resumes WHERE id=1").get()).toEqual({ title: "简历" });
    expect(db.prepare("SELECT content FROM resume_modules WHERE resume_id=1").get()).toEqual({ content: '{"text":"原内容"}' });
    const fresh = await read();
    expect(fresh.resume.draftRevision).not.toBe(initial.resume.draftRevision);
    expect((await PATCH(patch(body(fresh)), context)).status).toBe(200);
  });

  it.each([
    { template: "modern" }, { styleOverrides: { baseSize: 14 } },
    { addModule: { type: "custom", label: "补充" } },
    { renameModule: { key: "summary", label: "改名" } },
    { removeModule: "summary" }, { moduleOrder: ["summary"] },
  ])("结构与样式写入 %j 也必须使用当前世代", async (operation) => {
    const { PATCH } = await import("@/app/api/resumes/[id]/route");
    const initial = await read();
    await restore();
    const restored = await read();
    expect((await PATCH(patch({ ...operation, dataGeneration: initial.resume.dataGeneration }), context)).status).toBe(409);
    expect(await read()).toEqual(restored);
    expect((await PATCH(patch(operation), context)).status).toBe(409);
    expect((await PATCH(patch({ ...operation, dataGeneration: restored.resume.dataGeneration,
      styleRevision: restored.resume.styleRevision }), context)).status).toBe(200);
  });

  it.each(["title", "module"])("显式旧世代不能借助新的 %s 令牌写入", async (field) => {
    const { PATCH } = await import("@/app/api/resumes/[id]/route");
    const initial = await read();
    await restore();
    const fresh = await read();
    const body = field === "title"
      ? { title: "新标题", titleRevision: fresh.resume.titleRevision }
      : { modules: { summary: { text: "新内容" } }, moduleRevisions: { summary: fresh.modules[0].revision } };
    expect((await PATCH(patch({ ...body, dataGeneration: initial.resume.dataGeneration }), context)).status).toBe(409);
    expect(await read()).toEqual(fresh);
    expect((await PATCH(patch({ ...body, dataGeneration: fresh.resume.dataGeneration }), context)).status).toBe(200);
  });

  it("不同简历和模块的相同内容不能共用令牌", async () => {
    db.prepare("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (2,'简历','','')").run();
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (2,'summary','summary','简介',?,'')")
      .run(JSON.stringify({ text: "原内容" }));
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'other','summary','其他',?,'')")
      .run(JSON.stringify({ text: "原内容" }));
    const { loadResume } = await import("../resumes");
    const first = loadResume(1)!;
    const second = loadResume(2)!;
    expect(first.resume.titleRevision).not.toBe(second.resume.titleRevision);
    expect(first.modules[0]!.revision).not.toBe(second.modules[0]!.revision);
    expect(first.modules[0]!.revision).not.toBe(first.modules[1]!.revision);
  });

  it("恢复后消失的模块不能被当作保存成功并丢弃草稿、升级世代", async () => {
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'obsolete','summary','旧模块',?,'')")
      .run(JSON.stringify({ text: "旧模块内容" }));
    const initial = await read();
    const { PATCH } = await import("@/app/api/resumes/[id]/route");
    const { ResumeSaveQueue } = await import("../resume-save-queue");
    const { HttpError } = await import("../fetcher");
    let stored = "";
    const request = vi.fn(async (body: Record<string, unknown>) => {
      const response = await PATCH(patch(body), context);
      const result = await response.json();
      if (!response.ok) throw new HttpError(result.error, response.status);
      return result;
    });
    const queue = new ResumeSaveQueue(request, { read: () => "", write: (value) => { stored = value; } });
    await queue.load(async () => initial);
    db.prepare("DELETE FROM resume_modules WHERE module_key='obsolete'").run();
    await restore();
    queue.edit({ modules: { obsolete: { text: "仍需保留的旧草稿" } } });
    try {
      await expect(queue.mutate({ template: "modern" })).rejects.toMatchObject({ status: 409 });
      expect(request).toHaveBeenCalledTimes(1);
      const firstCall = request.mock.calls[0];
      if (!firstCall) throw new Error("保存请求没有记录调用参数");
      expect(firstCall[0].dataGeneration).toBe(initial.resume.dataGeneration);
      expect(stored).toContain("仍需保留的旧草稿");
      expect(db.prepare("SELECT template FROM resumes WHERE id=1").get()).toEqual({ template: "classic" });
      const revision = initial.modules.find((module: { key: string }) => module.key === "obsolete").revision;
      expect((await PATCH(patch({ modules: { obsolete: { text: "旧草稿" } }, moduleRevisions: { obsolete: revision } }), context)).status).toBe(409);
    } finally {
      queue.disposeAutoWork();
    }
  });
});
