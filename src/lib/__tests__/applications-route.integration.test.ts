import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-applications-route-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-applications-route-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const request = (method: string, body?: unknown) =>
  new Request("http://127.0.0.1/api/applications", {
    method,
    headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const idContext = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

async function seed(): Promise<number> {
  const route = await import("@/app/api/applications/route");
  const res = await route.POST(request("POST", { company: "A", role: "B", notes: "原始备注" }));
  return (await res.json()).id as number;
}

/** 造一条可关联的面试：applications.interview_id 有外键，指向不存在的面试会被拒 */
function seedInterview(): void {
  db.exec("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '测试简历', '', '')");
  db.exec("INSERT INTO interviews (id, resume_id, jd, created_at) VALUES (1, 1, 'JD', '')");
}

describe("applications/[id] 的字段白名单与删除", () => {
  it("PATCH 只更新传入字段，未传字段保持原值", async () => {
    const id = await seed();
    const route = await import("@/app/api/applications/[id]/route");
    const res = await route.PATCH(request("PATCH", { stage: "applied" }), idContext(id));
    expect(res.status).toBe(200);
    const { getApplicationById } = await import("@/lib/applications");
    const after = getApplicationById(id);
    expect(after?.stage).toBe("applied");
    expect(after?.notes).toBe("原始备注");
  });

  it("PATCH 接受 null 清空关联字段", async () => {
    const id = await seed();
    seedInterview();
    const route = await import("@/app/api/applications/[id]/route");
    const { getApplicationById } = await import("@/lib/applications");

    // 先写入一个真实值：不这样做的话该列本来就是 NULL，
    // 「清空后还是 NULL」无法区分「清空生效」与「本来就没值」。
    const set = await route.PATCH(request("PATCH", { interview_id: 1 }), idContext(id));
    expect(set.status).toBe(200);
    expect(getApplicationById(id)?.interview_id).toBe(1);

    const cleared = await route.PATCH(request("PATCH", { interview_id: null }), idContext(id));
    expect(cleared.status).toBe(200);
    expect(getApplicationById(id)?.interview_id).toBeNull();
  });

  it("PATCH 未提供 interview_id 时保持原值", async () => {
    const id = await seed();
    seedInterview();
    const route = await import("@/app/api/applications/[id]/route");
    const { getApplicationById } = await import("@/lib/applications");
    await route.PATCH(request("PATCH", { interview_id: 1 }), idContext(id));

    // 只改无关字段，interview_id 必须原样保留
    const res = await route.PATCH(request("PATCH", { stage: "applied" }), idContext(id));
    expect(res.status).toBe(200);
    expect(getApplicationById(id)?.interview_id).toBe(1);
  });

  it("DELETE 移除记录", async () => {
    const id = await seed();
    const route = await import("@/app/api/applications/[id]/route");
    const res = await route.DELETE(request("DELETE"), idContext(id));
    expect(res.status).toBe(200);
    const { getApplicationById } = await import("@/lib/applications");
    expect(getApplicationById(id)).toBeNull();
  });

  it("DELETE 不存在的记录返回 404（与其余 DELETE 端点语义一致）", async () => {
    const route = await import("@/app/api/applications/[id]/route");
    const res = await route.DELETE(request("DELETE"), idContext(999999));
    expect(res.status).toBe(404);
  });

  it("非法 id 返回 400", async () => {
    const route = await import("@/app/api/applications/[id]/route");
    const res = await route.PATCH(request("PATCH", { notes: "x" }), idContext(Number.NaN));
    expect(res.status).toBe(400);
  });
});
