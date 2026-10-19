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
