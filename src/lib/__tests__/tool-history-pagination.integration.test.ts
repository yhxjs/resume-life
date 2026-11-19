import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-tool-history-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-tool-history-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const histories = [
  {
    name: "自我介绍",
    url: "/api/intros",
    route: () => import("@/app/api/intros/route"),
    seed: (db: DatabaseSync) => {
      const resumeId = Number(db.prepare("INSERT INTO resumes (title, created_at, updated_at) VALUES ('简历', '', '')").run().lastInsertRowid);
      const insert = db.prepare("INSERT INTO intros (resume_id, jd, created_at) VALUES (?, ?, '')");
      for (let id = 1; id <= 52; id += 1) insert.run(resumeId, `岗位 ${id}`);
    },
  },
  {
    name: "薪酬谈判",
    url: "/api/tools/salary-negotiations",
    route: () => import("@/app/api/tools/salary-negotiations/route"),
    seed: (db: DatabaseSync) => {
      const insert = db.prepare("INSERT INTO salary_negotiations (target_company_tier, target_role, expected_salary, created_at) VALUES ('top_tech', ?, '30k', '')");
      for (let id = 1; id <= 52; id += 1) insert.run(`岗位 ${id}`);
    },
  },
  {
    name: "黑话解码",
    url: "/api/tools/jargon-decodings",
    route: () => import("@/app/api/tools/jargon-decodings/route"),
    seed: (db: DatabaseSync) => {
      const insert = db.prepare("INSERT INTO jargon_decodings (source_text, created_at) VALUES (?, '')");
      for (let id = 1; id <= 52; id += 1) insert.run(`黑话 ${id}`);
    },
  },
  {
    name: "空窗期对策",
    url: "/api/tools/career-gap-remedies",
    route: () => import("@/app/api/tools/career-gap-remedies/route"),
    seed: (db: DatabaseSync) => {
      const insert = db.prepare("INSERT INTO resignation_gap_remedies (raw_story, created_at) VALUES (?, '')");
      for (let id = 1; id <= 52; id += 1) insert.run(`经历 ${id}`);
    },
  },
  {
    name: "JD 画像",
    url: "/api/tools/jd-portraits",
    route: () => import("@/app/api/tools/jd-portraits/route"),
    seed: (db: DatabaseSync) => {
      const insert = db.prepare("INSERT INTO jd_portraits (jd, created_at) VALUES (?, '')");
      for (let id = 1; id <= 52; id += 1) insert.run(`JD ${id}`);
    },
  },
] as const;

describe.each(histories)("$name 历史分页", ({ url, route, seed }) => {
  it("默认返回分页对象，通过游标找回第 51 条及更早记录", async () => {
    seed(db);
    const { GET } = await route();
    const first = await GET(new Request(`http://localhost${url}`));
    expect(first.status).toBe(200);
    const firstPage = await first.json() as { items: { id: number }[]; nextCursor: string | null; total: number };
    expect(firstPage.items.map((row) => row.id)).toEqual(Array.from({ length: 50 }, (_, i) => 52 - i));
    expect(firstPage.nextCursor).toBe("3");
    expect(firstPage.total).toBe(52);

    const second = await GET(new Request(`http://localhost${url}?limit=50&cursor=${firstPage.nextCursor}`));
    expect(second.status).toBe(200);
    const secondPage = await second.json() as { items: { id: number }[]; nextCursor: string | null; total: number };
    expect(secondPage.items.map((row) => row.id)).toEqual([2, 1]);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.total).toBe(52);
  });

  it("拒绝无效分页参数", async () => {
    const { GET } = await route();
    for (const query of ["limit=0", "limit=101", "cursor=abc"]) {
      const response = await GET(new Request(`http://localhost${url}?${query}`));
      expect(response.status, query).toBe(400);
    }
  });
});

it("自我介绍列表完整回读发布快照及无绑定旧记录，读取不改写业务数据", async () => {
  const { readIntroListPage } = await import("../intro-history");
  const { publishResumeVersion } = await import("../resume-versions");
  const resumeId = Number(db.prepare("INSERT INTO resumes (title, created_at, updated_at) VALUES ('发布标题', '', '')").run().lastInsertRowid);
  const version = publishResumeVersion(resumeId, { name: "旧发布版 <T> &amp;" });
  db.prepare("UPDATE resumes SET title = '后来的草稿标题' WHERE id = ?").run(resumeId);
  const original = "  长历史 JD <T> &amp;\n内部  空格  ".repeat(4000);
  const insert = db.prepare("INSERT INTO intros (resume_id, resume_version_id, jd, created_at) VALUES (?, ?, ?, ?)");
  for (let index = 0; index < 52; index++) insert.run(resumeId, index % 2 ? version.id : null, original, "旧日期字面量");
  const snapshot = () => ({
    intros: db.prepare("SELECT * FROM intros ORDER BY id").all(),
    versions: db.prepare("SELECT * FROM resume_versions ORDER BY id").all(),
    resumes: db.prepare("SELECT * FROM resumes ORDER BY id").all(),
    changes: db.prepare("SELECT total_changes() AS total").get(),
  });
  const before = snapshot();
  const { GET } = await import("@/app/api/intros/route");
  const response = await GET(new Request("http://localhost/api/intros"));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  const first = readIntroListPage(await response.json());
  expect(first.items).toHaveLength(50); expect(first.total).toBe(52);
  expect(first.items[0]).toMatchObject({ resume_title: "发布标题", resume_version_id: version.id, resume_version: 1, resume_version_name: version.name, jd: original, created_at: "旧日期字面量" });
  expect(first.items[1]).toMatchObject({ resume_title: "后来的草稿标题", resume_version_id: null, resume_version: null, resume_version_name: null });
  const last = await GET(new Request(`http://localhost/api/intros?cursor=${first.nextCursor}`));
  const second = readIntroListPage(await last.json(), { cursor: first.nextCursor! });
  expect(second.items.map(item => item.id)).toEqual([2, 1]); expect(second.nextCursor).toBeNull(); expect(second.total).toBe(52);
  expect(snapshot()).toEqual(before);
});
