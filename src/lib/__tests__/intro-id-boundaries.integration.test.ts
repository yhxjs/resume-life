import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ safeChat: vi.fn(), safeChatStream: vi.fn() }));
vi.mock("@/lib/safe-llm", async original => ({
  ...await original<typeof import("@/lib/safe-llm")>(), ...model,
}));

const PREFIX = "resume-life-intro-id-boundaries-";
const sentences = [{ text: "仅参与接口校验，尚未上线。", comment: "保留职责边界。" }];
let directory: string;
let db: DatabaseSync;
let revision: string;

beforeEach(async () => {
  vi.resetModules();
  model.safeChat.mockReset().mockResolvedValue(JSON.stringify({ comments: ["新点评"], versions: [{ kind: "30s", sentences }] }));
  model.safeChatStream.mockReset().mockResolvedValue(JSON.stringify({ versions: ["30s", "2min"].map(kind => ({ kind, sentences })) }));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'原简历','',''),(2,'另一份简历','','')");
  (await import("../resume-versions")).publishResumeVersion(1, { name: "发布材料" });
  db.exec("INSERT INTO intros (id,resume_id,jd,created_at) VALUES (1,1,'接口校验岗位',''),(2,2,'另一份介绍','')");
  for (const id of [1, 2]) for (const kind of ["30s", "2min"]) {
    db.prepare("INSERT INTO intro_versions (intro_id,kind,sentences,updated_at) VALUES (?,?,?,'original')")
      .run(id, kind, JSON.stringify(sentences));
  }
  const row = db.prepare("SELECT id,sentences,updated_at FROM intro_versions WHERE intro_id=1 AND kind='30s'").get() as { id: number; sentences: string; updated_at: string };
  revision = (await import("../intro-versions")).introVersionRevision(row);
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

function stored() {
  return {
    intros: db.prepare("SELECT * FROM intros ORDER BY id").all(),
    versions: db.prepare("SELECT * FROM intro_versions ORDER BY id").all(),
    resumes: db.prepare("SELECT * FROM resumes ORDER BY id").all(),
    snapshots: db.prepare("SELECT * FROM resume_versions ORDER BY id").all(),
    logs: db.prepare("SELECT * FROM llm_call_logs ORDER BY id").all(),
  };
}

function request(method: string, body: unknown) {
  return new Request("http://localhost/api/intros/1", {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

describe.each(["save", "recomment", "regenerate"] as const)("自我介绍 %s 路径 ID", action => {
  it.each([
    ...["0", "-1", "9007199254740992", "9007199254740993", "1e100", "1e0", "0x1", "+1", "01", " 1", "1 ", "1.5", "NaN", "Infinity"].map(id => ({ id, status: 400 })),
    { id: String(Number.MAX_SAFE_INTEGER), status: 404 },
  ])("路径 $id 返回 $status，模型与所有存档均不变", async ({ id, status }) => {
    const before = stored();
    const response = action === "save"
      ? await (await import("@/app/api/intros/[id]/versions/[kind]/route")).PATCH(
        request("PATCH", { sentences, baseRevision: revision }), { params: Promise.resolve({ id, kind: "30s" }) })
      : await (await (action === "recomment" ? import("@/app/api/intros/[id]/recomment/route") : import("@/app/api/intros/[id]/regenerate/route"))).POST(
        request("POST", { kind: "30s", baseRevision: revision }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: status === 400 ? "无效的记录 ID" : action === "save" ? "版本不存在" : "记录不存在" });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(model.safeChat).not.toHaveBeenCalled();
    expect(model.safeChatStream).not.toHaveBeenCalled();
    expect(stored()).toEqual(before);
  });
});

describe("自我介绍创建简历 ID", () => {
  it.each([true, false, [1], [[1]], [], {}, null, "", "1", "1e0", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]
    .map(resume_id => ({ label: JSON.stringify(resume_id) ?? "undefined", resume_id })))("拒绝隐式转换或非正安全整数 $label，不能借用简历 1 的材料", async ({ resume_id }) => {
    const before = stored();
    const { POST } = await import("@/app/api/intros/route");
    const response = await POST(request("POST", { resume_id, jd: "接口校验岗位" }));
    const text = await response.text(); // 消费完整响应，防止遗漏 SSE 中的晚到写入。
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: "请选择简历" });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(model.safeChat).not.toHaveBeenCalled();
    expect(model.safeChatStream).not.toHaveBeenCalled();
    expect(stored()).toEqual(before);
  });

  it("仍按真实数字简历 ID 创建并使用该发布材料", async () => {
    const { POST } = await import("@/app/api/intros/route");
    const response = await POST(request("POST", { resume_id: 1, jd: "接口校验岗位" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("event: done");
    expect(model.safeChatStream).toHaveBeenCalledTimes(1);
    const row = db.prepare("SELECT resume_id,resume_version_id FROM intros WHERE id NOT IN (1,2)").get();
    expect(row).toMatchObject({ resume_id: 1, resume_version_id: expect.any(Number) });
  });
});
