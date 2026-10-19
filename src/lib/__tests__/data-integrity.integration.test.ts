import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const llm = vi.hoisted(() => ({ chat: vi.fn(), chatStream: vi.fn() }));
vi.mock("@/lib/llm", () => ({ ...llm, extractJson: JSON.parse, LlmConfigError: class extends Error {} }));
vi.mock("@/lib/resumes", () => ({ loadResumeContext: () => "测试简历" }));

let tempDir: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-integrity-"));
  vi.spyOn(process, "cwd").mockReturnValue(tempDir);
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
});
afterEach(() => {
  db?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-integrity-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(tempDir, { recursive: true, force: true });
});
const context = { params: Promise.resolve({ id: "1" }) };
const request = (body: unknown) => new Request("http://localhost/api/test", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const BACKUP_PASSWORD = "correct horse battery staple";
const answerResult = JSON.stringify({ comment: "点评", next_question: "下一题", next_kind: "question", depth: 7, structure: 7, authenticity: 7, completeness: 7 });
const validNegotiationTurn = JSON.stringify({
  hr_response: "好",
  hr_tactics: "综合拉扯",
  hr_mindset: { looseness: 40, current_attitude: "试探", estimated_package: "30k", tactics_label: "试探", internal_pressure: "正常" },
  mentor_analysis: { user_argument_score: 7, strengths: ["有理"], vulnerabilities: ["待强化"], tactical_tips: "保持锚定", suggested_replies: [{ title: "回应", content: "继续沟通", rationale: "保持空间" }] },
});
const validNegotiationOpening = JSON.stringify({
  initial_offer: "30k", hr_response: "开局", hr_tactics: "初始探底开价",
  hr_mindset: { looseness: 20, current_attitude: "严守", estimated_package: "30k", tactics_label: "锚定", internal_pressure: "正常" },
  mentor_analysis: { user_argument_score: 7, strengths: ["有理"], vulnerabilities: ["待强化"], tactical_tips: "保持锚定", suggested_replies: [{ title: "回应", content: "继续沟通", rationale: "保持空间" }] },
});
const validNegotiationReport = JSON.stringify({ final_package_summary: "30k", persuasion_grade: "B", score: 75, leverage_efficiency: "稳定", turn_critiques: [{ turn_no: 1, gain_or_loss: "neutral", summary: "正常", key_point: "保持" }], real_world_tips: ["核对带宽"], mentor_summary: "完成复盘" });
function seedInterview() {
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'原简历','',''); INSERT INTO interviews (id,resume_id,jd,created_at) VALUES (1,1,'岗位',''); INSERT INTO interview_turns (id,interview_id,idx,question,reference) VALUES (1,1,1,'题目','原参考答案')");
}
function seedNegotiation() {
  db.exec("INSERT INTO salary_negotiations (id,target_company_tier,target_role,expected_salary,created_at) VALUES (1,'startup','工程师','30k',''); INSERT INTO salary_negotiation_turns (negotiation_id,turn_no,hr_response,created_at) VALUES (1,1,'开场','')");
}
function gate() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * 等待第二个并发请求自行结束，用于确认它真的在命令锁上被拒绝。
 * 正确实现下该请求不依赖模型即可返回；若它绕过了锁而进入模型调用，就会一直挂起——
 * 这里用超时把「挂起」变成一条明确的失败信息，而不是让用例静默超时。
 * 注意：超时只用来界定失败，不承担定序；定序由 await 这个 Promise 本身保证。
 */
async function expectRejectedWithoutModel<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}未在 2 秒内返回：并发请求可能绕过了命令锁而进入模型调用`)),
          2_000
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function exportBackupBytes(): Promise<Buffer> {
  const route = await import("@/app/api/backup/export/route") as unknown as {
    POST(request: Request): Promise<Response>;
  };
  const response = await route.POST(new Request("http://localhost/api/backup/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: BACKUP_PASSWORD, confirmation: BACKUP_PASSWORD }),
  }));
  expect(response.status).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

async function encryptedRequest(
  pathname: "validate" | "restore",
  body: BodyInit | Uint8Array,
  options: { password?: string; preserveAiConfig?: string } = {},
): Promise<Request> {
  const { encodeBackupPasswordHeader } = await import("@/lib/backup-container");
  const headers: Record<string, string> = {
    "X-Resume-Life-Backup-Password": encodeBackupPasswordHeader(options.password ?? BACKUP_PASSWORD),
  };
  if (options.preserveAiConfig !== undefined) {
    headers["X-Resume-Life-Preserve-Ai-Config"] = options.preserveAiConfig;
  }
  return new Request(`http://localhost/api/backup/${pathname}`, {
    method: "POST",
    headers,
    body: body as BodyInit,
  });
}

async function validateBackup(bytes: Buffer, password = BACKUP_PASSWORD): Promise<Response> {
  const route = await import("@/app/api/backup/validate/route");
  return route.POST(await encryptedRequest("validate", bytes, { password }));
}

async function restoreBackup(
  bytes: Buffer,
  options: { password?: string; preserveAiConfig?: string } = {},
): Promise<Response> {
  const route = await import("@/app/api/backup/restore/route");
  return route.POST(await encryptedRequest("restore", bytes, options));
}

async function databaseState(): Promise<Record<string, Record<string, unknown>[]>> {
  const { TABLES_CLEAR_ORDER } = await import("@/lib/backup");
  return Object.fromEntries(TABLES_CLEAR_ORDER.map((table) => [
    table,
    db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Record<string, unknown>[],
  ]));
}

const PRE_RESTORE_SNAPSHOT_PREFIX = "resume-life.db.pre-restore-";

/**
 * 生成 count 个「恢复前快照」文件。
 * 返回类型写成非空元组：本文件普遍按下标取快照，而调用处的 count 恒不小于 2。
 */
function createOldSnapshots(count: number): [string, string, ...string[]] {
  const backupDir = path.join(tempDir, "data", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const baseTime = Date.now() - 60_000;
  return Array.from({ length: count }, (_, index) => {
    const snapshotPath = path.join(backupDir, `${PRE_RESTORE_SNAPSHOT_PREFIX}old-${index}`);
    fs.writeFileSync(snapshotPath, `snapshot-${index}`);
    const modifiedAt = new Date(baseTime + index * 1_000);
    fs.utimesSync(snapshotPath, modifiedAt, modifiedAt);
    return snapshotPath;
  }) as [string, string, ...string[]];
}

describe("模板删除事务", () => {
  it("简历回退失败时保留模板和原引用", async () => {
    db.exec(`
      INSERT INTO resume_templates (id, name, style, created_at, updated_at)
      VALUES (1, '事务模板', '{}', '', '');
      INSERT INTO resumes (id, title, template, created_at, updated_at)
      VALUES (1, '引用模板的简历', 'custom:1', '', '');
      CREATE TRIGGER abort_resume_template_reset
      BEFORE UPDATE OF template ON resumes
      WHEN OLD.template = 'custom:1' AND NEW.template = 'classic'
      BEGIN
        SELECT RAISE(ABORT, 'forced template reset failure');
      END;
    `);
    const { DELETE } = await import("@/app/api/templates/[id]/route");

    const response = await DELETE(
      new Request("http://localhost/api/templates/1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "1" }) },
    );

    // 事务内的失败由统一包装收敛成带 requestId 的 500，不再以未捕获异常穿透
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "服务器内部错误，请稍后重试",
      requestId: expect.any(String),
    });

    expect(db.prepare("SELECT id FROM resume_templates WHERE id = 1").get()).toEqual({ id: 1 });
    expect(db.prepare("SELECT template FROM resumes WHERE id = 1").get()).toEqual({ template: "custom:1" });
  });
});

type TestCursorPage = {
  items: { id: number }[];
  nextCursor: string | null;
};

describe("列表接口游标分页", () => {
  it("题库默认每页 50 条、最大支持 100 条且筛选后翻页无重复遗漏", async () => {
    const insert = db.prepare(
      "INSERT INTO bank_entries (direction,kind,question,created_at) VALUES (?,? ,?,?)",
    );
    for (let id = 1; id <= 105; id += 1) {
      insert.run(id % 2 === 1 ? "前端" : "后端", "tech", `筛选题目 ${id}`, `2026-01-${String(id).padStart(3, "0")}`);
    }
    const { GET } = await import("@/app/api/bank/route");

    const firstResponse = await GET(new Request("http://localhost/api/bank"));
    const first = await firstResponse.json() as TestCursorPage;
    expect(firstResponse.status).toBe(200);
    expect(first.items).toHaveLength(50);
    expect(first.items.map((item) => item.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => 105 - index),
    );
    expect(first.nextCursor).toBe("56");

    const second = await (await GET(new Request(`http://localhost/api/bank?cursor=${first.nextCursor}`))).json() as TestCursorPage;
    const third = await (await GET(new Request(`http://localhost/api/bank?cursor=${second.nextCursor}`))).json() as TestCursorPage;
    const allIds = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    expect(allIds).toEqual(Array.from({ length: 105 }, (_, index) => 105 - index));
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(third.nextCursor).toBeNull();

    const maximum = await (await GET(new Request("http://localhost/api/bank?limit=100"))).json() as TestCursorPage;
    expect(maximum.items).toHaveLength(100);
    expect(maximum.nextCursor).toBe("6");

    const filteredIds: number[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ direction: "前端", q: "筛选题目", limit: "7" });
      if (cursor) params.set("cursor", cursor);
      const page = await (await GET(new Request(`http://localhost/api/bank?${params}`))).json() as TestCursorPage;
      filteredIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(filteredIds).toEqual(Array.from({ length: 53 }, (_, index) => 105 - index * 2));
    expect(new Set(filteredIds).size).toBe(filteredIds.length);
  });

  it("练习列表按 id 倒序分页且项目筛选后的所有页连续", async () => {
    db.exec(`
      INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'项目一','',''),(2,'项目二','','');
    `);
    const insert = db.prepare(
      "INSERT INTO drills (source,project_id,created_at) VALUES ('project',?,?)",
    );
    for (let id = 1; id <= 11; id += 1) {
      insert.run(id % 2 === 1 ? 1 : 2, `2026-01-${String(id).padStart(2, "0")}`);
    }
    const { GET } = await import("@/app/api/drills/route");

    const collected: number[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ project_id: "1", limit: "2" });
      if (cursor) params.set("cursor", cursor);
      const response = await GET(new Request(`http://localhost/api/drills?${params}`));
      const page = await response.json() as TestCursorPage;
      expect(response.status).toBe(200);
      collected.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(collected).toEqual([11, 9, 7, 5, 3, 1]);
    expect(new Set(collected).size).toBe(collected.length);
  });

  it("投递列表使用 updated_at 与 id 复合游标并在筛选后稳定翻页", async () => {
    const insert = db.prepare(
      "INSERT INTO applications (company,role,stage,created_at,updated_at) VALUES (?,?,?,?,?)",
    );
    const rows = [
      ["目标公司一", "工程师", "applied", "2026-01-01", "2026-03-03"],
      ["目标公司二", "工程师", "applied", "2026-01-02", "2026-03-03"],
      ["其他公司", "工程师", "interested", "2026-01-03", "2026-03-03"],
      ["目标公司四", "工程师", "applied", "2026-01-04", "2026-02-02"],
      ["目标公司五", "工程师", "applied", "2026-01-05", "2026-02-02"],
      ["目标公司六", "工程师", "applied", "2026-01-06", "2026-01-01"],
    ];
    for (const row of rows) insert.run(...row);
    const { GET } = await import("@/app/api/applications/route");

    const firstResponse = await GET(new Request(
      "http://localhost/api/applications?stage=applied&q=%E7%9B%AE%E6%A0%87&limit=2",
    ));
    const first = await firstResponse.json() as TestCursorPage;
    expect(firstResponse.status).toBe(200);
    expect(first.items.map((item) => item.id)).toEqual([2, 1]);
    expect(first.nextCursor).not.toBeNull();
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"))).toEqual({
      updatedAt: "2026-03-03",
      id: 1,
    });

    const second = await (await GET(new Request(
      `http://localhost/api/applications?stage=applied&q=%E7%9B%AE%E6%A0%87&limit=2&cursor=${first.nextCursor}`,
    ))).json() as TestCursorPage;
    const third = await (await GET(new Request(
      `http://localhost/api/applications?stage=applied&q=%E7%9B%AE%E6%A0%87&limit=2&cursor=${second.nextCursor}`,
    ))).json() as TestCursorPage;
    const allIds = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    expect(allIds).toEqual([2, 1, 5, 4, 6]);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(third.nextCursor).toBeNull();
  });

  it("投递列表深页查询使用 updated_at 与 id 的 SQLite 行值范围谓词", async () => {
    const preparedSql: string[] = [];
    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      preparedSql.push(sql);
      return originalPrepare.call(this, sql);
    });
    const cursor = Buffer.from(
      JSON.stringify({ updatedAt: "2026-09-16", id: 1 }),
      "utf8",
    ).toString("base64url");

    try {
      const { GET } = await import("@/app/api/applications/route");
      const response = await GET(new Request(`http://localhost/api/applications?cursor=${cursor}`));

      expect(response.status).toBe(200);
      const listSql = preparedSql.find((sql) => sql.includes("FROM applications a"));
      expect(listSql).toBeDefined();
      expect(listSql?.replace(/\s+/g, " ")).toContain("AND (a.updated_at, a.id) < (?, ?)");
      expect(listSql).not.toMatch(/a\.updated_at\s*<\s*\?\s+OR/i);
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it.each([
    ["bank", () => import("@/app/api/bank/route")],
    ["drills", () => import("@/app/api/drills/route")],
    ["applications", () => import("@/app/api/applications/route")],
  ] as const)("%s 拒绝空值、非整数、越界 limit 与非法 cursor", async (pathname, loadRoute) => {
    const { GET } = await loadRoute();
    for (const query of ["limit=", "limit=%20", "limit=abc", "limit=1.5", "limit=0", "limit=-1", "limit=101", "cursor="]) {
      const response = await GET(new Request(`http://localhost/api/${pathname}?${query}`));
      expect(response.status, query).toBe(400);
    }

    const invalidCursor = pathname === "applications"
      ? Buffer.from(JSON.stringify({ updatedAt: "", id: 1 })).toString("base64url")
      : "not-an-id";
    const response = await GET(new Request(`http://localhost/api/${pathname}?cursor=${invalidCursor}`));
    expect(response.status).toBe(400);
  });

  it.each([
    ["updatedAt 类型错误", { updatedAt: 123, id: 1 }],
    ["updatedAt 为空白", { updatedAt: "   ", id: 1 }],
    ["updatedAt 不是日期", { updatedAt: "not-a-date", id: 1 }],
    ["updatedAt 日期格式畸形", { updatedAt: "2026-9-16", id: 1 }],
    ["updatedAt 日历日期无效", { updatedAt: "2026-02-30", id: 1 }],
    ["id 类型错误", { updatedAt: "2026-09-16", id: "1" }],
    ["id 为零", { updatedAt: "2026-09-16", id: 0 }],
  ])("applications 拒绝%s的复合 cursor", async (_name, value) => {
    const { GET } = await import("@/app/api/applications/route");
    const cursor = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const response = await GET(new Request(`http://localhost/api/applications?cursor=${cursor}`));
    expect(response.status).toBe(400);
  });

  it("applications 拒绝非 canonical base64url cursor", async () => {
    const { GET } = await import("@/app/api/applications/route");
    const canonical = Buffer.from(
      JSON.stringify({ updatedAt: "2026-09-16", id: 1 }),
      "utf8",
    ).toString("base64url");
    const response = await GET(new Request(`http://localhost/api/applications?cursor=${canonical}=`));
    expect(response.status).toBe(400);
  });

  it("applications 拒绝 JSON 额外字段中的非法 UTF-8 字节", async () => {
    const { GET } = await import("@/app/api/applications/route");
    const cursor = Buffer.concat([
      Buffer.from('{"updatedAt":"2026-09-16","id":1,"extra":"', "utf8"),
      Buffer.from([0xff]),
      Buffer.from('"}', "utf8"),
    ]).toString("base64url");

    const response = await GET(new Request(`http://localhost/api/applications?cursor=${cursor}`));

    expect(response.status).toBe(400);
  });

  it.each(["2026-09-16", "2026-09-16T02:00:37.123Z"])(
    "applications 接受合法 updatedAt cursor：%s",
    async (updatedAt) => {
      const { GET } = await import("@/app/api/applications/route");
      const cursor = Buffer.from(JSON.stringify({ updatedAt, id: 1 }), "utf8").toString("base64url");
      const response = await GET(new Request(`http://localhost/api/applications?cursor=${cursor}`));
      expect(response.status).toBe(200);
    },
  );
});

describe("备份完整性与恢复安全", () => {
  it("导出快照双上限固定常量", async () => {
    const backup = await import("@/lib/backup");

    expect(backup.MAX_PRE_RESTORE_SNAPSHOTS).toBe(5);
    expect(backup.MIN_SNAPSHOT_BUDGET_BYTES).toBe(256 * 1024 * 1024);
    expect(backup.SNAPSHOT_DATABASE_MULTIPLIER).toBe(3);
  });

  it("backups 为外部 junction 或 symlink 时在提交前拒绝恢复且不写删外部文件", async ({ skip }) => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    db.exec("UPDATE resumes SET title='恢复前保留值'");
    const backupDir = path.join(tempDir, "data", "backups");
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-backup-external-"));
    const sentinel = path.join(externalDir, "sentinel.txt");
    fs.writeFileSync(sentinel, "keep");
    let linkCreated = false;

    try {
      try {
        fs.symlinkSync(externalDir, backupDir, process.platform === "win32" ? "junction" : "dir");
        linkCreated = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (["EACCES", "EINVAL", "ENOSYS", "EPERM"].includes(code ?? "")) {
          skip(`当前平台不支持测试所需的目录链接：${code ?? "unknown"}`);
        }
        throw error;
      }

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      let response: Response;
      try {
        response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
      } finally {
        consoleSpy.mockRestore();
      }

      expect(response.status).toBe(500);
      expect(db.prepare("SELECT title FROM resumes").get()).toEqual({ title: "恢复前保留值" });
      expect(fs.readdirSync(externalDir).sort()).toEqual(["sentinel.txt"]);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
    } finally {
      if (linkCreated && fs.lstatSync(backupDir).isSymbolicLink()) fs.unlinkSync(backupDir);
      const resolvedExternalDir = path.resolve(externalDir);
      if (path.dirname(resolvedExternalDir) !== path.resolve(os.tmpdir()) ||
          !path.basename(resolvedExternalDir).startsWith("resume-life-backup-external-")) {
        throw new Error("Unsafe external backup cleanup path");
      }
      fs.rmSync(resolvedExternalDir, { recursive: true, force: true });
    }
  });

  it("VACUUM INTO 紧前备份目录身份变化时拒绝恢复", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    db.exec("UPDATE resumes SET title='恢复前保留值'");
    const backupDir = path.join(tempDir, "data", "backups");
    const originalLstatSync = fs.lstatSync;
    let directoryChecks = 0;
    const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((...args: unknown[]) => {
      const target = args[0] as fs.PathLike;
      const stats = Reflect.apply(originalLstatSync, fs, args);
      if (path.resolve(String(target)) !== path.resolve(backupDir)) return stats;
      directoryChecks += 1;
      if (directoryChecks !== 2) return stats;
      return Object.assign(stats, { ino: stats.ino + BigInt(1) });
    }) as typeof fs.lstatSync);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;

    try {
      response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
    } finally {
      lstatSpy.mockRestore();
      consoleSpy.mockRestore();
    }

    expect(response.status).toBe(500);
    expect(directoryChecks).toBe(2);
    expect(db.prepare("SELECT title FROM resumes").get()).toEqual({ title: "恢复前保留值" });
    expect(fs.readdirSync(backupDir)).toHaveLength(0);
  });

  it("成功恢复后按 mtime 从最旧项轮转至最多 5 份且不删除非匹配项", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const oldSnapshots = createOldSnapshots(6);
    const backupDir = path.dirname(oldSnapshots[0]);
    const unrelatedFile = path.join(backupDir, "unrelated.db");
    const matchingDirectory = path.join(backupDir, `${PRE_RESTORE_SNAPSHOT_PREFIX}directory`);
    fs.writeFileSync(unrelatedFile, "keep");
    fs.mkdirSync(matchingDirectory);

    const response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
    const result = await response.json() as { snapshotCreated: string };
    const matchingFiles = fs.readdirSync(backupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(PRE_RESTORE_SNAPSHOT_PREFIX));

    expect(response.status).toBe(200);
    expect(matchingFiles).toHaveLength(5);
    expect(fs.existsSync(result.snapshotCreated)).toBe(true);
    expect(fs.existsSync(oldSnapshots[0])).toBe(false);
    expect(fs.existsSync(oldSnapshots[1])).toBe(false);
    expect(oldSnapshots.slice(2).every((snapshotPath) => fs.existsSync(snapshotPath))).toBe(true);
    expect(fs.existsSync(unrelatedFile)).toBe(true);
    expect(fs.statSync(matchingDirectory).isDirectory()).toBe(true);
  });

  it("快照总字节预算取当前数据库三倍与 256 MiB 的较大值", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const oldSnapshots = createOldSnapshots(3);
    const backupDir = path.dirname(oldSnapshots[0]);
    const databasePath = path.join(tempDir, "data", "resume-life.db");
    const mebibyte = 1024 * 1024;
    const oldMetadata = new Map(oldSnapshots.map((snapshotPath, index) => [
      path.resolve(snapshotPath),
      { size: BigInt([30, 90, 90][index]! * mebibyte), mtimeNs: BigInt(index + 1) },
    ]));
    const originalLstatSync = fs.lstatSync;
    const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((...args: unknown[]) => {
      const target = args[0] as fs.PathLike;
      const stats = Reflect.apply(originalLstatSync, fs, args);
      const resolved = path.resolve(String(target));
      if (resolved === path.resolve(databasePath)) {
        return Object.assign(stats, { size: BigInt(100 * mebibyte) });
      }
      if (path.dirname(resolved) === path.resolve(backupDir) && path.basename(resolved).startsWith(PRE_RESTORE_SNAPSHOT_PREFIX)) {
        return Object.assign(stats, oldMetadata.get(resolved) ?? { size: BigInt(100 * mebibyte), mtimeNs: BigInt(4) });
      }
      return stats;
    }) as typeof fs.lstatSync);

    try {
      const response = await restoreBackup(encrypted, { preserveAiConfig: "false" });

      expect(response.status).toBe(200);
      expect(fs.existsSync(oldSnapshots[0])).toBe(false);
      expect(fs.existsSync(oldSnapshots[1])).toBe(true);
      expect(fs.existsSync(oldSnapshots[2]!)).toBe(true);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("当前数据库很小时使用 256 MiB 最低快照预算", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const oldSnapshots = createOldSnapshots(2);
    const backupDir = path.dirname(oldSnapshots[0]);
    const databasePath = path.join(tempDir, "data", "resume-life.db");
    const mebibyte = 1024 * 1024;
    const oldSnapshotSet = new Set(oldSnapshots.map((snapshotPath) => path.resolve(snapshotPath)));
    const originalLstatSync = fs.lstatSync;
    const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((...args: unknown[]) => {
      const target = args[0] as fs.PathLike;
      const stats = Reflect.apply(originalLstatSync, fs, args);
      const resolved = path.resolve(String(target));
      if (resolved === path.resolve(databasePath)) {
        return Object.assign(stats, { size: BigInt(1) });
      }
      if (path.dirname(resolved) === path.resolve(backupDir) && path.basename(resolved).startsWith(PRE_RESTORE_SNAPSHOT_PREFIX)) {
        return Object.assign(stats, oldSnapshotSet.has(resolved)
          ? { size: BigInt(100 * mebibyte), mtimeNs: BigInt(oldSnapshots.indexOf(resolved) + 1) }
          : { size: BigInt(20 * mebibyte), mtimeNs: BigInt(3) });
      }
      return stats;
    }) as typeof fs.lstatSync);

    try {
      const response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
      const result = await response.json() as { snapshotCreated: string };

      expect(response.status).toBe(200);
      expect(oldSnapshots.every((snapshotPath) => fs.existsSync(snapshotPath))).toBe(true);
      expect(fs.existsSync(result.snapshotCreated)).toBe(true);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("本次快照即使自身超过预算且 mtime 最旧也绝不删除", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const oldSnapshots = createOldSnapshots(2);
    const backupDir = path.dirname(oldSnapshots[0]);
    const databasePath = path.join(tempDir, "data", "resume-life.db");
    const mebibyte = 1024 * 1024;
    const oldSnapshotSet = new Set(oldSnapshots.map((snapshotPath) => path.resolve(snapshotPath)));
    const originalLstatSync = fs.lstatSync;
    const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((...args: unknown[]) => {
      const target = args[0] as fs.PathLike;
      const stats = Reflect.apply(originalLstatSync, fs, args);
      const resolved = path.resolve(String(target));
      if (resolved === path.resolve(databasePath)) {
        return Object.assign(stats, { size: BigInt(1) });
      }
      if (path.dirname(resolved) === path.resolve(backupDir) && path.basename(resolved).startsWith(PRE_RESTORE_SNAPSHOT_PREFIX)) {
        return Object.assign(stats, oldSnapshotSet.has(resolved)
          ? { size: BigInt(10 * mebibyte), mtimeNs: BigInt(oldSnapshots.indexOf(resolved) + 1) }
          : { size: BigInt(300 * mebibyte), mtimeNs: BigInt(0) });
      }
      return stats;
    }) as typeof fs.lstatSync);

    try {
      const response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
      const result = await response.json() as { snapshotCreated: string };
      const matchingFiles = fs.readdirSync(backupDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.startsWith(PRE_RESTORE_SNAPSHOT_PREFIX));

      expect(response.status).toBe(200);
      expect(path.resolve(result.snapshotCreated)).not.toBe([...oldSnapshotSet][0]);
      expect(fs.existsSync(result.snapshotCreated)).toBe(true);
      expect(matchingFiles).toHaveLength(1);
      expect(oldSnapshots.every((snapshotPath) => !fs.existsSync(snapshotPath))).toBe(true);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("快照轮转发生在正式恢复 COMMIT 与 foreign_keys 恢复处理之后", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const backupDir = path.join(tempDir, "data", "backups");
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");
    const readdirSpy = vi.spyOn(fs, "readdirSync");

    try {
      const response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
      const commitIndex = execSpy.mock.calls.findIndex(([sql]) => sql === "COMMIT");
      const foreignKeysIndex = execSpy.mock.calls.findIndex(([sql]) => sql === "PRAGMA foreign_keys = ON");
      const rotationIndex = readdirSpy.mock.calls.findIndex(([target]) => path.resolve(String(target)) === path.resolve(backupDir));

      expect(response.status).toBe(200);
      expect(commitIndex).toBeGreaterThanOrEqual(0);
      expect(foreignKeysIndex).toBeGreaterThan(commitIndex);
      expect(rotationIndex).toBeGreaterThanOrEqual(0);
      expect(execSpy.mock.invocationCallOrder[foreignKeysIndex])
        .toBeLessThan(readdirSpy.mock.invocationCallOrder[rotationIndex]!);
    } finally {
      execSpy.mockRestore();
      readdirSpy.mockRestore();
    }
  });

  it("正式恢复失败时只清理本次快照，不轮转旧快照", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const oldSnapshots = createOldSnapshots(6);
    const backupDir = path.dirname(oldSnapshots[0]);
    const writeError = new Error("injected destination write failure");
    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (this !== db || !sql.startsWith('INSERT INTO "resumes"')) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === "run") return () => { throw writeError; };
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const readdirSpy = vi.spyOn(fs, "readdirSync");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
        expect(response.status).toBe(500);
      }
      const rotationCalls = readdirSpy.mock.calls.filter(([target]) => path.resolve(String(target)) === path.resolve(backupDir));

      expect(rotationCalls).toHaveLength(0);
      expect(oldSnapshots.every((snapshotPath) => fs.existsSync(snapshotPath))).toBe(true);
    } finally {
      prepareSpy.mockRestore();
      readdirSpy.mockRestore();
      consoleSpy.mockRestore();
    }
    expect(fs.readdirSync(backupDir).filter((name) => name.startsWith(PRE_RESTORE_SNAPSHOT_PREFIX)))
      .toHaveLength(oldSnapshots.length);
  }, 15_000);

  it("候选 lstat 失败仍计入数量并继续清理其他安全旧快照", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const oldSnapshots = createOldSnapshots(6);
    const backupDir = path.dirname(oldSnapshots[0]);
    const metadataError = new Error(`candidate metadata failed ${BACKUP_PASSWORD} sk-backup-sentinel`);
    metadataError.name = `candidate-name-${BACKUP_PASSWORD}-sk-backup-sentinel`;
    const originalLstatSync = fs.lstatSync;
    let metadataFailed = false;
    const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((...args: unknown[]) => {
      const target = args[0] as fs.PathLike;
      if (!metadataFailed && path.resolve(String(target)) === path.resolve(oldSnapshots[0])) {
        metadataFailed = true;
        throw metadataError;
      }
      return Reflect.apply(originalLstatSync, fs, args);
    }) as typeof fs.lstatSync);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    let logOutput = "";

    try {
      response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
      logOutput = JSON.stringify(consoleSpy.mock.calls);
    } finally {
      lstatSpy.mockRestore();
      consoleSpy.mockRestore();
    }

    const matchingFiles = fs.readdirSync(backupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(PRE_RESTORE_SNAPSHOT_PREFIX));
    expect(response.status).toBe(200);
    expect(fs.existsSync(oldSnapshots[0])).toBe(true);
    expect(oldSnapshots.slice(1).some((snapshotPath) => !fs.existsSync(snapshotPath))).toBe(true);
    expect(matchingFiles.length).toBeLessThanOrEqual(5);
    expect(logOutput).toContain('\\"operation\\":\\"inspectPreRestoreSnapshot\\\"');
    expect(logOutput).toContain('\\"resource\\":\\"pre-restore-snapshot\\"');
    expect(logOutput).toContain('\\"errorType\\":\\"Error\\"');
    expect(logOutput).not.toContain(BACKUP_PASSWORD);
    expect(logOutput).not.toContain("sk-backup-sentinel");
    expect(logOutput).not.toContain(metadataError.name);
  });

  it("候选在检查后被替换时不删除同路径替换物", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const oldSnapshots = createOldSnapshots(6);
    const backupDir = path.dirname(oldSnapshots[0]);
    const replacementContent = "replacement-must-survive";
    const replacementSource = path.join(backupDir, "replacement-source.tmp");
    const originalLstatSync = fs.lstatSync;
    let candidateChecks = 0;
    const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((...args: unknown[]) => {
      const target = args[0] as fs.PathLike;
      if (path.resolve(String(target)) === path.resolve(oldSnapshots[0])) {
        candidateChecks += 1;
        if (candidateChecks === 2) {
          fs.writeFileSync(replacementSource, replacementContent);
          fs.unlinkSync(oldSnapshots[0]);
          fs.renameSync(replacementSource, oldSnapshots[0]);
        }
      }
      return Reflect.apply(originalLstatSync, fs, args);
    }) as typeof fs.lstatSync);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;

    try {
      response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
    } finally {
      lstatSpy.mockRestore();
      consoleSpy.mockRestore();
    }

    expect(response.status).toBe(200);
    expect(candidateChecks).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(oldSnapshots[0])).toBe(true);
    expect(fs.readFileSync(oldSnapshots[0], "utf8")).toBe(replacementContent);
  });

  it("候选最终检查后与本次快照交换时保留本次快照身份", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const oldSnapshots = createOldSnapshots(6);
    const backupDir = path.dirname(oldSnapshots[0]);
    const oldSnapshotPaths = new Set(oldSnapshots.map((snapshotPath) => path.resolve(snapshotPath)));
    const originalLstatSync = fs.lstatSync;
    const originalRenameSync = fs.renameSync;
    const originalUnlinkSync = fs.unlinkSync;
    let currentSnapshotIdentity: { dev: bigint; ino: bigint } | undefined;
    let swapTriggered = false;

    function swapCandidateWithCurrentSnapshot() {
      const currentSnapshotPath = fs.readdirSync(backupDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.startsWith(PRE_RESTORE_SNAPSHOT_PREFIX))
        .map((entry) => path.join(backupDir, entry.name))
        .find((snapshotPath) => !oldSnapshotPaths.has(path.resolve(snapshotPath)));
      if (!currentSnapshotPath) throw new Error("Current snapshot not found");

      const currentStats = originalLstatSync(currentSnapshotPath, { bigint: true });
      currentSnapshotIdentity = { dev: currentStats.dev, ino: currentStats.ino };
      const swapPath = path.join(backupDir, "snapshot-race-swap.tmp");
      originalRenameSync(oldSnapshots[0], swapPath);
      originalRenameSync(currentSnapshotPath, oldSnapshots[0]);
      originalRenameSync(swapPath, currentSnapshotPath);
      swapTriggered = true;
    }

    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      if (!swapTriggered && path.resolve(String(oldPath)) === path.resolve(oldSnapshots[0])) {
        swapCandidateWithCurrentSnapshot();
      }
      originalRenameSync(oldPath, newPath);
    });
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (!swapTriggered && path.resolve(String(target)) === path.resolve(oldSnapshots[0])) {
        swapCandidateWithCurrentSnapshot();
      }
      originalUnlinkSync(target);
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;

    try {
      response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
    } finally {
      renameSpy.mockRestore();
      unlinkSpy.mockRestore();
      consoleSpy.mockRestore();
    }

    const preservedSnapshotPaths = fs.readdirSync(backupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(backupDir, entry.name))
      .filter((snapshotPath) => {
        const stats = fs.lstatSync(snapshotPath, { bigint: true });
        return stats.dev === currentSnapshotIdentity?.dev && stats.ino === currentSnapshotIdentity.ino;
      });
    expect(response.status).toBe(200);
    expect(swapTriggered).toBe(true);
    expect(preservedSnapshotPaths).toHaveLength(1);
  });

  it("删除前 backups 目录身份变化时停止轮转", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const oldSnapshots = createOldSnapshots(6);
    const backupDir = path.dirname(oldSnapshots[0]);
    const originalLstatSync = fs.lstatSync;
    let directoryChecks = 0;
    const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((...args: unknown[]) => {
      const target = args[0] as fs.PathLike;
      const stats = Reflect.apply(originalLstatSync, fs, args);
      if (path.resolve(String(target)) !== path.resolve(backupDir)) return stats;
      directoryChecks += 1;
      if (directoryChecks !== 3) return stats;
      return Object.assign(stats, {
        ino: typeof stats.ino === "bigint" ? stats.ino + BigInt(1) : stats.ino + 1,
      });
    }) as typeof fs.lstatSync);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    let logOutput = "";

    try {
      response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
      logOutput = JSON.stringify(consoleSpy.mock.calls);
    } finally {
      lstatSpy.mockRestore();
      consoleSpy.mockRestore();
    }

    expect(response.status).toBe(200);
    expect(directoryChecks).toBeGreaterThanOrEqual(3);
    expect(oldSnapshots.every((snapshotPath) => fs.existsSync(snapshotPath))).toBe(true);
    expect(logOutput).toContain('\\"operation\\":\\"verifyBackupDirectory\\\"');
    expect(logOutput).toContain('\\"resource\\":\\"pre-restore-snapshot\\"');
    expect(logOutput).toContain('\\"errorType\\":\\"Error\\"');
  });

  it("候选 size 异常时停止轮转且只记录脱敏诊断", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const oldSnapshots = createOldSnapshots(2);
    const unsafeSize = Number.MAX_SAFE_INTEGER + 1;
    const originalLstatSync = fs.lstatSync;
    const originalStatSync = fs.statSync;
    const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((...args: unknown[]) => {
      const target = args[0] as fs.PathLike;
      const stats = Reflect.apply(originalLstatSync, fs, args);
      if (path.resolve(String(target)) !== path.resolve(oldSnapshots[0])) return stats;
      return Object.assign(stats, { size: unsafeSize });
    }) as typeof fs.lstatSync);
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((...args: unknown[]) => {
      const target = args[0] as fs.PathLike;
      const stats = Reflect.apply(originalStatSync, fs, args);
      if (path.resolve(String(target)) !== path.resolve(oldSnapshots[0])) return stats;
      return Object.assign(stats, { size: unsafeSize });
    }) as typeof fs.statSync);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    let logOutput = "";

    try {
      response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
      logOutput = JSON.stringify(consoleSpy.mock.calls);
    } finally {
      lstatSpy.mockRestore();
      statSpy.mockRestore();
      consoleSpy.mockRestore();
    }

    expect(response.status).toBe(200);
    expect(oldSnapshots.every((snapshotPath) => fs.existsSync(snapshotPath))).toBe(true);
    expect(logOutput).toContain('\\"operation\\":\\"inspectPreRestoreSnapshot\\\"');
    expect(logOutput).toContain('\\"resource\\":\\"pre-restore-snapshot\\"');
    expect(logOutput).toContain('\\"errorType\\":\\"Error\\"');
    expect(logOutput).not.toContain(oldSnapshots[0]);
    expect(logOutput).not.toContain(String(unsafeSize));
  });

  it("旧快照删除失败不影响恢复并继续轮转且诊断不泄漏 Error 名称或消息", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    db.exec("UPDATE resumes SET title='恢复前新值'");
    const oldSnapshots = createOldSnapshots(6);
    const backupDir = path.dirname(oldSnapshots[0]);
    const cleanupError = new Error(`snapshot cleanup failed ${BACKUP_PASSWORD} sk-backup-sentinel`);
    cleanupError.name = `snapshot-name-${BACKUP_PASSWORD}-sk-backup-sentinel`;
    const failedSnapshotStats = fs.lstatSync(oldSnapshots[0], { bigint: true });
    const originalLstatSync = fs.lstatSync;
    const originalUnlinkSync = fs.unlinkSync;
    let removalFailed = false;
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (!removalFailed) {
        const targetStats = originalLstatSync(target, { bigint: true });
        if (targetStats.dev === failedSnapshotStats.dev && targetStats.ino === failedSnapshotStats.ino) {
          removalFailed = true;
          throw cleanupError;
        }
      }
      originalUnlinkSync(target);
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    let result: { snapshotCreated: string };
    let logOutput = "";

    try {
      response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
      result = await response.json() as { snapshotCreated: string };
      logOutput = JSON.stringify(consoleSpy.mock.calls);
    } finally {
      unlinkSpy.mockRestore();
      consoleSpy.mockRestore();
    }

    const matchingFiles = fs.readdirSync(backupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(PRE_RESTORE_SNAPSHOT_PREFIX));
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT title FROM resumes").get()).toEqual({ title: "原简历" });
    expect(fs.existsSync(result.snapshotCreated)).toBe(true);
    expect(fs.existsSync(oldSnapshots[0])).toBe(false);
    expect(fs.existsSync(oldSnapshots[1])).toBe(false);
    expect(fs.existsSync(oldSnapshots[2]!)).toBe(false);
    expect(oldSnapshots.slice(3).every((snapshotPath) => fs.existsSync(snapshotPath))).toBe(true);
    expect(matchingFiles).toHaveLength(5);
    expect(logOutput).toContain('\\"operation\\":\\"removePreRestoreSnapshot\\\"');
    expect(logOutput).toContain('\\"resource\\":\\"pre-restore-snapshot\\"');
    expect(logOutput).toContain('\\"errorType\\":\\"Error\\"');
    expect(logOutput).not.toContain(BACKUP_PASSWORD);
    expect(logOutput).not.toContain("sk-backup-sentinel");
    expect(logOutput).not.toContain(cleanupError.name);
  });

  it("隔离旧快照持续删除失败时保留配套头像且不突破 5 份", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const oldSnapshots = createOldSnapshots(6);
    const backupDir = path.dirname(oldSnapshots[0]);
    const avatarName = "private-avatar.png";
    fs.mkdirSync(`${oldSnapshots[0]}.uploads`);
    fs.writeFileSync(path.join(`${oldSnapshots[0]}.uploads`, avatarName), "original-avatar");
    const cleanupError = new Error(`persistent cleanup failure ${BACKUP_PASSWORD} sk-backup-sentinel`);
    cleanupError.name = `persistent-cleanup-${BACKUP_PASSWORD}-sk-backup-sentinel`;
    const failedSnapshotStats = fs.lstatSync(oldSnapshots[0], { bigint: true });
    const originalLstatSync = fs.lstatSync;
    const originalUnlinkSync = fs.unlinkSync;
    let failedUnlinkCalls = 0;
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      const targetStats = originalLstatSync(target, { bigint: true });
      if (targetStats.dev === failedSnapshotStats.dev && targetStats.ino === failedSnapshotStats.ino) {
        failedUnlinkCalls += 1;
        throw cleanupError;
      }
      originalUnlinkSync(target);
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    let logOutput = "";

    try {
      response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
      const result = await response.clone().json() as { snapshotCreated: string };
      const { rotatePreRestoreSnapshots } = await import("@/lib/backup-snapshot");
      rotatePreRestoreSnapshots(db, result.snapshotCreated);
      logOutput = JSON.stringify(consoleSpy.mock.calls);
    } finally {
      unlinkSpy.mockRestore();
      consoleSpy.mockRestore();
    }

    const matchingSnapshotPaths = fs.readdirSync(backupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(PRE_RESTORE_SNAPSHOT_PREFIX))
      .map((entry) => path.join(backupDir, entry.name));
    const failedIdentityPaths = matchingSnapshotPaths.filter((snapshotPath) => {
      const stats = fs.lstatSync(snapshotPath, { bigint: true });
      return stats.dev === failedSnapshotStats.dev && stats.ino === failedSnapshotStats.ino;
    });

    expect(response.status).toBe(200);
    expect(matchingSnapshotPaths).toHaveLength(5);
    expect(failedIdentityPaths).toHaveLength(1);
    expect(path.basename(failedIdentityPaths[0]!)).toContain("quarantine-");
    expect(fs.existsSync(oldSnapshots[0])).toBe(false);
    expect(fs.readFileSync(path.join(`${failedIdentityPaths[0]}.uploads`, avatarName), "utf8"))
      .toBe("original-avatar");
    expect(failedUnlinkCalls).toBe(1);
    expect(logOutput).toContain('\\"operation\\":\\"removePreRestoreSnapshot\\\"');
    expect(logOutput).not.toContain(BACKUP_PASSWORD);
    expect(logOutput).not.toContain("sk-backup-sentinel");
    expect(logOutput).not.toContain(cleanupError.name);
  });

  it("显式数据目录覆盖使用隔离路径", async () => {
    db.close();
    vi.resetModules();
    const explicitDir = path.join(tempDir, "isolated");
    vi.stubEnv("RESUME_LIFE_DATA_DIR", explicitDir);
    db = (await import("@/lib/db")).getDb();
    const main = (db.prepare("PRAGMA database_list").all() as { name: string; file: string }[]).find((row) => row.name === "main");
    expect(path.resolve(main!.file)).toBe(path.join(explicitDir, "resume-life.db"));
  });
  it("validate 与 restore 使用两次独立上传完成加密备份往返并生成 WAL 一致快照", async () => {
    seedInterview();
    db.exec("INSERT INTO settings (id,api_key,updated_at) VALUES (1,'sk-backup-sentinel','')");
    const encrypted = await exportBackupBytes();
    db.exec("UPDATE resumes SET title='恢复前新值'");

    const validation = await validateBackup(encrypted);
    expect(validation.status).toBe(200);
    expect(validation.headers.get("Cache-Control")).toContain("no-store");
    expect(await validation.json()).toMatchObject({
      ok: true,
      manifest: { dbVersion: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version },
      stats: { resumes: 1, interview_turns: 1 },
    });
    expect(db.prepare("SELECT title FROM resumes").get()).toEqual({ title: "恢复前新值" });

    const restored = await restoreBackup(encrypted, { preserveAiConfig: "false" });
    expect(restored.status).toBe(200);
    expect(restored.headers.get("Cache-Control")).toContain("no-store");
    const result = await restored.json() as {
      stats: Record<string, number>;
      snapshotCreated: string;
    };
    expect(result.stats).toMatchObject({ resumes: 1, interview_turns: 1 });
    expect(db.prepare("SELECT title FROM resumes").get()).toEqual({ title: "原简历" });
    const snapshot = new DatabaseSync(result.snapshotCreated, { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT title FROM resumes").get()).toEqual({ title: "恢复前新值" });
      expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      snapshot.close();
    }
  });

  it("恢复前头像读取失败时保留正式库与原头像", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const { saveUploadFile } = await import("@/lib/upload-storage");
    const avatar = await saveUploadFile(Buffer.from("original-avatar"), ".png");
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,sort,content,updated_at) VALUES (1,'basic','basic',0,?,'')")
      .run(JSON.stringify({ avatar: avatar.url }));
    db.exec("UPDATE resumes SET title='恢复前保留值'");

    const originalRead = fs.readFileSync.bind(fs);
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(target).endsWith(avatar.filename)) {
        throw Object.assign(new Error("synthetic avatar read failure"), { code: "EACCES" });
      }
      return originalRead(target, options as BufferEncoding);
    }) as typeof fs.readFileSync);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let response: Response;
    try {
      response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
    } finally {
      readSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(response.status).toBe(500);
    expect(db.prepare("SELECT title FROM resumes").get()).toEqual({ title: "恢复前保留值" });
    expect(db.prepare("SELECT content FROM resume_modules WHERE resume_id=1 AND module_key='basic'").get())
      .toEqual({ content: JSON.stringify({ avatar: avatar.url }) });
    expect(fs.readFileSync(path.join(tempDir, "data", "uploads", avatar.filename), "utf8")).toBe("original-avatar");
    expect(fs.readdirSync(path.join(tempDir, "data", "backups"))
      .filter((name) => name.startsWith(PRE_RESTORE_SNAPSHOT_PREFIX))).toEqual([]);
  });

  it("restore 对错误密码、篡改密文、普通 JSON 与未知版本均返回 400 且正式库不变", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1]! ^= 0x01;
    const unknownVersion = Buffer.from(encrypted);
    unknownVersion[6] = 0x03;
    const original = await databaseState();
    const cases: Array<[Buffer, string]> = [
      [encrypted, "different correct-length password"],
      [tampered, BACKUP_PASSWORD],
      [Buffer.from('{"meta":{}}', "utf8"), BACKUP_PASSWORD],
      [unknownVersion, BACKUP_PASSWORD],
    ];

    for (const [bytes, password] of cases) {
      const response = await restoreBackup(bytes, { password, preserveAiConfig: "false" });
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
      expect(await databaseState()).toEqual(original);
    }
    expect(fs.existsSync(path.join(tempDir, "data", "backups"))).toBe(false);
  });

  it("restore 流式执行 2GiB 硬上限，不调用 arrayBuffer 或 json 且不改正式库", async () => {
    seedInterview();
    const { MAX_ENCRYPTED_BACKUP_BYTES } = await import("@/lib/backup-limits");
    const { encodeBackupPasswordHeader } = await import("@/lib/backup-container");
    const oversized = new Uint8Array(0);
    Object.defineProperty(oversized, "byteLength", { get: () => MAX_ENCRYPTED_BACKUP_BYTES + 1 });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });
    const arrayBuffer = vi.fn(() => { throw new Error("must not buffer request"); });
    const json = vi.fn(() => { throw new Error("must not parse encrypted body"); });
    const requestWithStream = {
      body,
      headers: new Headers({
        "X-Resume-Life-Backup-Password": encodeBackupPasswordHeader(BACKUP_PASSWORD),
        "X-Resume-Life-Preserve-Ai-Config": "false",
      }),
      arrayBuffer,
      json,
    } as unknown as Request;
    const original = await databaseState();
    const route = await import("@/app/api/backup/restore/route");

    const response = await route.POST(requestWithStream);

    expect(response.status).toBe(413);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(await databaseState()).toEqual(original);
  });

  it("restore 严格拒绝非法 preserveAiConfig 请求头且不创建快照", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const original = await databaseState();

    const response = await restoreBackup(encrypted, { preserveAiConfig: "yes" });

    expect(response.status).toBe(400);
    expect(await databaseState()).toEqual(original);
    expect(fs.existsSync(path.join(tempDir, "data", "backups"))).toBe(false);
  });

  it("缺省 preserveAiConfig 时保留本机 AI 配置，而不是用备份里的覆盖", async () => {
    // 缺省曾按「覆盖」处理：任何不带该头的调用方（脚本、新客户端）都会静默
    seedInterview();
    const { writeSettings, readSettings } = await import("@/lib/settings");
    const settings = (baseUrl: string, apiKey: string, model: string) => ({
      base_url: baseUrl,
      api_key: apiKey,
      api_format: "openai_chat",
      model_parse: model,
      model_summary: model,
      model_question: model,
      model_evaluate: model,
    });
    writeSettings(settings("https://old.example/v1", "sk-old", "old-model"));
    const encrypted = await exportBackupBytes();

    writeSettings(settings("https://current.example/v1", "sk-current", "current-model"));
    const response = await restoreBackup(encrypted);

    expect(response.status).toBe(200);
    expect(readSettings()).toMatchObject({
      base_url: "https://current.example/v1",
      api_key: "sk-current",
      model_parse: "current-model",
    });
  });

  it("显式传 false 时恢复用户备份的普通设置、清空凭证且可重新填写", async () => {
    seedInterview();
    const { writeSettings, readSettings } = await import("@/lib/settings");
    const settings = (baseUrl: string, apiKey: string, model: string) => ({
      base_url: baseUrl,
      api_key: apiKey,
      api_format: "openai_chat",
      model_parse: model,
      model_summary: model,
      model_question: model,
      model_evaluate: model,
    });
    writeSettings({ ...settings("https://old.example/v1", "sk-old", "old-model"), proxy_password: "synthetic-old-password" });
    const encrypted = await exportBackupBytes();

    writeSettings({ ...settings("https://current.example/v1", "sk-current", "current-model"), proxy_password: "synthetic-current-password" });
    const response = await restoreBackup(encrypted, { preserveAiConfig: "false" });

    expect(response.status).toBe(200);
    expect(readSettings()).toMatchObject({
      base_url: "https://old.example/v1",
      api_key: "",
      proxy_password: "",
      model_parse: "old-model",
    });
    expect(db.prepare("SELECT api_key, proxy_password FROM settings WHERE id = 1").get()).toMatchObject({ api_key: "", proxy_password: "" });
    const { PUT } = await import("@/app/api/settings/route");
    const savedResponse = await PUT(new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...readSettings(), api_key: "sk-synthetic-new-key", proxy_password: "synthetic-new-password" }),
    }));
    expect(savedResponse.status).toBe(200);
    expect(readSettings()).toMatchObject({ base_url: "https://old.example/v1", api_key: "sk-synthetic-new-key", proxy_password: "synthetic-new-password", model_parse: "old-model" });
  });

  it("统计表缺失时返回 503 而不是把失败伪装为零", async () => {
    db.exec("DROP TABLE notebook_entries");
    const { GET } = await import("@/app/api/backup/stats/route");
    const response = await GET(new Request("http://localhost/api/backup/stats"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
  });
  it("正式库 schema 损坏时 validate 与 restore 返回 500 而非用户输入错误", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    db.exec("DROP TABLE notebook_entries");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const validation = await validateBackup(encrypted);
      const restoration = await restoreBackup(encrypted, { preserveAiConfig: "false" });
      expect(validation.status).toBe(500);
      expect(restoration.status).toBe(500);
      expect(validation.headers.get("Cache-Control")).toContain("no-store");
      expect(restoration.headers.get("Cache-Control")).toContain("no-store");
    } finally {
      consoleSpy.mockRestore();
    }
  });
  it("快照目录不可写时 restore 返回 500 并保持原数据", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    db.exec("UPDATE resumes SET title='恢复前新值'");
    const original = await databaseState();
    fs.writeFileSync(path.join(tempDir, "data", "backups"), "阻止创建目录");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
      expect(response.status).toBe(500);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    } finally {
      consoleSpy.mockRestore();
    }
    expect(await databaseState()).toEqual(original);
  });
  it("恢复争用写锁返回 500 后仍保持外键检查开启且数据不变", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    const original = await databaseState();
    const writer = new DatabaseSync(path.join(tempDir, "data", "resume-life.db"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      writer.exec("BEGIN IMMEDIATE");
      const response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
      expect(response.status).toBe(500);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(await databaseState()).toEqual(original);
    } finally {
      consoleSpy.mockRestore();
      writer.exec("ROLLBACK");
      writer.close();
    }
    // 生产连接现带 busy_timeout = 5000，争锁时会等待约 5 秒才报 SQLITE_BUSY，
    // 故必须放宽 vitest 默认的 5 秒单测超时（断言本身未变）
  }, 15_000);
  it("restore 写入中途失败会回滚数据并恢复 trigger 与外键状态", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    db.exec("UPDATE resumes SET title='恢复前保留值'");
    const original = await databaseState();
    const guardsBefore = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'guard_*_position_*' ORDER BY name",
    ).all();
    const writeError = new Error("injected destination write failure");
    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (this !== db || !sql.startsWith('INSERT INTO "resumes"')) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === "run") return () => { throw writeError; };
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    try {
      response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
    } finally {
      prepareSpy.mockRestore();
      consoleSpy.mockRestore();
    }

    expect(response.status).toBe(500);
    expect(await databaseState()).toEqual(original);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'guard_*_position_*' ORDER BY name",
    ).all()).toEqual(guardsBefore);
  });
  it("COMMIT 后 foreign_keys 恢复失败仍返回成功并记录脱敏 cleanup 诊断", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    db.exec("UPDATE resumes SET title='恢复前新值'");
    const cleanupError = new Error(`foreign key cleanup failed ${BACKUP_PASSWORD} sk-backup-sentinel`);
    cleanupError.name = `foreign-key-name-${BACKUP_PASSWORD}-sk-backup-sentinel`;
    const originalExec = DatabaseSync.prototype.exec;
    let committed = false;
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (this === db && sql === "COMMIT") {
        const result = originalExec.call(this, sql);
        committed = true;
        return result;
      }
      if (this === db && committed && sql === "PRAGMA foreign_keys = ON") throw cleanupError;
      return originalExec.call(this, sql);
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    let logOutput = "";
    try {
      response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
      logOutput = JSON.stringify(consoleSpy.mock.calls);
    } finally {
      execSpy.mockRestore();
      consoleSpy.mockRestore();
      originalExec.call(db, "PRAGMA foreign_keys = ON");
    }

    expect(response.status).toBe(200);
    expect(db.prepare("SELECT title FROM resumes").get()).toEqual({ title: "原简历" });
    expect(logOutput).toContain("PRAGMA foreign_keys = ON");
    expect(logOutput).not.toContain(BACKUP_PASSWORD);
    expect(logOutput).not.toContain("sk-backup-sentinel");
    expect(logOutput).not.toContain(cleanupError.name);
  });
  it("restore 提交后暂存目录删除失败仍返回成功并记录脱敏诊断", async () => {
    seedInterview();
    const encrypted = await exportBackupBytes();
    db.exec("UPDATE resumes SET title='恢复前新值'");
    const cleanupError = new Error(`dispose cleanup failed ${BACKUP_PASSWORD} sk-backup-sentinel`);
    cleanupError.name = `dispose-name-${BACKUP_PASSWORD}-sk-backup-sentinel`;
    const originalRmSync = fs.rmSync;
    let residualDirectory: string | undefined;
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      const resolved = path.resolve(String(target));
      if (path.basename(resolved).startsWith("resume-life-restore-")) {
        residualDirectory = resolved;
        throw cleanupError;
      }
      return Reflect.apply(originalRmSync, fs, [target, options]);
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    let logOutput = "";
    try {
      response = await restoreBackup(encrypted, { preserveAiConfig: "false" });
      logOutput = JSON.stringify(consoleSpy.mock.calls);
    } finally {
      rmSpy.mockRestore();
      consoleSpy.mockRestore();
    }

    try {
      expect(response.status).toBe(200);
      expect(db.prepare("SELECT title FROM resumes").get()).toEqual({ title: "原简历" });
      expect(residualDirectory).toBeTruthy();
      expect(fs.existsSync(residualDirectory!)).toBe(true);
      expect(logOutput).toContain('\\"operation\\":\\"dispose\\\"');
      expect(logOutput).not.toContain(BACKUP_PASSWORD);
      expect(logOutput).not.toContain("sk-backup-sentinel");
      expect(logOutput).not.toContain(cleanupError.name);
    } finally {
      if (residualDirectory) {
        const resolved = path.resolve(residualDirectory);
        if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("resume-life-restore-")) {
          throw new Error("Unsafe restore cleanup path");
        }
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
    expect(fs.existsSync(residualDirectory!)).toBe(false);
  });
  it("保留配置时保持原配置整行与自增序列一致", async () => {
    seedInterview();
    db.exec("INSERT INTO settings (id,api_key,updated_at) VALUES (1,'import-key','import-time')");
    const encrypted = await exportBackupBytes();
    db.exec("UPDATE settings SET api_key='old-key',updated_at='old-time'");
    const response = await restoreBackup(encrypted, { preserveAiConfig: "true" });
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT api_key,updated_at FROM settings").get()).toEqual({ api_key: "old-key", updated_at: "old-time" });
    const inserted = db.prepare("INSERT INTO resumes (title,created_at,updated_at) VALUES ('新简历','','')").run();
    expect(Number(inserted.lastInsertRowid)).toBeGreaterThan(1);
  });
});

describe("真实路由异步提交", () => {
  it("逐句点评等待模型时保存的新句子不会被旧点评覆盖", async () => {
    seedInterview();
    const original = JSON.stringify([{ text: "旧句子", comment: "" }]);
    db.prepare("INSERT INTO intros (id,resume_id,jd,created_at) VALUES (1,1,'岗位','')").run();
    db.prepare("INSERT INTO intro_versions (intro_id,kind,sentences,updated_at) VALUES (1,'30s',?,'')").run(original);
    const paused = gate();
    llm.chat.mockReturnValue(paused.promise);
    const recomment = await import("@/app/api/intros/[id]/recomment/route");
    const update = await import("@/app/api/intros/[id]/versions/[kind]/route");
    const { GET: introDetail } = await import("@/app/api/intros/[id]/route");
    const detail = await (await introDetail(new Request("http://localhost/api/intros/1"), context)).json();
    const responsePromise = recomment.POST(request({ kind: "30s" }), { params: Promise.resolve({ id: "1" }) });
    await vi.waitFor(() => expect(llm.chat).toHaveBeenCalledOnce());
    expect((await update.PATCH(request({ sentences: [{ text: "新句子", comment: "" }], baseRevision: detail.versions[0].revision }), {
      params: Promise.resolve({ id: "1", kind: "30s" }),
    })).status).toBe(200);
    paused.resolve('{"comments":["旧点评"]}');
    expect((await responsePromise).status).toBe(409);
    expect(JSON.parse((db.prepare("SELECT sentences FROM intro_versions WHERE intro_id=1 AND kind='30s'").get() as { sentences: string }).sentences))
      .toEqual([{ text: "新句子", comment: "" }]);
  });

  it("同一题的两个并发重答都会追加到最新历史", async () => {
    seedInterview();
    const first = gate();
    const second = gate();
    llm.chat.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const retry = await import("@/app/api/interviews/[id]/turns/[tid]/retry/route");
    const retryContext = { params: Promise.resolve({ id: "1", tid: "1" }) };
    const one = retry.POST(request({ answer: "回答一" }), retryContext);
    const two = retry.POST(request({ answer: "回答二" }), retryContext);
    await vi.waitFor(() => expect(llm.chat).toHaveBeenCalledTimes(2));
    first.resolve(JSON.stringify({ depth: 7, structure: 7, authenticity: 7, completeness: 7, comment: "一", reference: "参考一" }));
    second.resolve(JSON.stringify({ depth: 8, structure: 8, authenticity: 8, completeness: 8, comment: "二", reference: "参考二" }));
    expect((await Promise.all([one, two])).map((response) => response.status)).toEqual([200, 200]);
    const stored = JSON.parse((db.prepare("SELECT retries FROM interview_turns WHERE id=1").get() as { retries: string }).retries) as Array<{ id: string; answer: string }>;
    expect(stored.map((item) => item.answer).sort()).toEqual(["回答一", "回答二"]);
    expect(new Set(stored.map((item) => item.id)).size).toBe(2);
  });

  it("两次并发作答只调用一次模型并产生一个下一题", async () => {
    seedInterview();
    const paused = gate();
    llm.chatStream.mockReturnValue(paused.promise);
    const { POST } = await import("@/app/api/interviews/[id]/answer/route");
    const first = await POST(request({ turn_id: 1, answer: "回答一" }), context);
    const second = await POST(request({ turn_id: 1, answer: "回答二" }), context);
    paused.resolve(answerResult);
    const firstText = await first.text();
    await second.text();
    expect(second.status).toBe(409);
    expect(firstText).toContain("event: done");
    expect(llm.chatStream).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM interview_turns WHERE idx=2").get()).toEqual({ n: 1 });
  });
  it("模型等待期间结束面试，过期作答不能写入", async () => {
    seedInterview();
    const paused = gate();
    llm.chatStream.mockReturnValue(paused.promise);
    const { POST } = await import("@/app/api/interviews/[id]/answer/route");
    const response = await POST(request({ turn_id: 1, answer: "过期回答" }), context);
    db.exec("UPDATE interviews SET status='finished' WHERE id=1");
    paused.resolve(answerResult);
    expect(await response.text()).toContain("event: error");
    expect(db.prepare("SELECT answer FROM interview_turns WHERE id=1").get()).toEqual({ answer: "" });
  });
  it("并发进阶请求只创建一轮", async () => {
    seedInterview();
    db.exec("INSERT INTO interview_series (id,resume_id,jd,created_at) VALUES (1,1,'岗位',''); UPDATE interviews SET series_id=1,round_no=1,status='finished',report='{}'");
    const paused = gate();
    llm.chat.mockReturnValue(paused.promise);
    const { POST } = await import("@/app/api/interviews/series/[id]/advance/route");
    const first = POST(request({}), context);
    await vi.waitFor(() => expect(llm.chat).toHaveBeenCalledTimes(1));
    const secondPromise = POST(request({}), context);
    // 先确认第二个请求此刻已因锁被拒绝，再放行模型；并发窗口由这个 await 确定，而不是靠宏任务时序
    const two = await expectRejectedWithoutModel(secondPromise, "第二个进阶请求");
    expect(two.status).toBe(409);
    paused.resolve('{"question":"下一轮题目"}');
    const one = await first;
    expect(one.status).toBe(201);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM interviews WHERE round_no=2").get()).toEqual({ n: 1 });
  });
  it("模型等待期间进阶面试结束，下一轮不得落库", async () => {
    seedInterview();
    db.exec("INSERT INTO interview_series (id,resume_id,jd,created_at) VALUES (1,1,'岗位',''); UPDATE interviews SET series_id=1,round_no=1,status='finished',report='{}'");
    const paused = gate();
    llm.chat.mockReturnValue(paused.promise);
    const { POST } = await import("@/app/api/interviews/series/[id]/advance/route");
    const responsePromise = POST(request({}), context);
    await vi.waitFor(() => expect(llm.chat).toHaveBeenCalledTimes(1));
    db.exec("UPDATE interview_series SET status='finished' WHERE id=1");
    paused.resolve('{"question":"过期下一轮"}');
    expect((await responsePromise).status).toBe(409);
    expect(db.prepare("SELECT COUNT(*) AS n FROM interviews").get()).toEqual({ n: 1 });
  });
  it("两次并发生成跨轮总评只调用一次模型并只提交一次", async () => {
    seedInterview();
    const report = JSON.stringify({ depth: 8, structure: 8, authenticity: 8, completeness: 8, jd_match: 8, overall: 8, strengths: "优点", weaknesses: "不足", suggestions: "建议" });
    db.exec("INSERT INTO interview_series (id,resume_id,jd,created_at) VALUES (1,1,'岗位',''); DELETE FROM interviews; DELETE FROM interview_turns");
    const insert = db.prepare("INSERT INTO interviews (resume_id,jd,style,series_id,round_no,status,report,created_at) VALUES (1,'岗位',?,1,?,'finished',?,'')");
    insert.run("gentle", 1, report); insert.run("manager", 2, report); insert.run("hr", 3, report);
    const paused = gate();
    llm.chat.mockReturnValue(paused.promise);
    const { POST } = await import("@/app/api/interviews/series/[id]/finalize/route");
    const first = POST(request({}), context);
    await vi.waitFor(() => expect(llm.chat).toHaveBeenCalledTimes(1));
    const secondPromise = POST(request({}), context);
    const second = await expectRejectedWithoutModel(secondPromise, "第二个总评请求");
    expect(second.status).toBe(409);
    paused.resolve('{"verdict":"通过","strengths":"稳定","weaknesses":"表达","suggestions":"练习"}');
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status, COUNT(*) AS n FROM interview_series WHERE final_report != ''").get()).toEqual({ status: "finished", n: 1 });
  });
  it.each<[string, unknown]>([
    ["根值 null", null],
    ["根值数组", []],
    ["根值字符串", "结论"],
    ["根值数字", 8],
    ["根值布尔", true],
    ...["verdict", "strengths", "weaknesses", "suggestions"].flatMap((field) =>
      [undefined, "", " \n\t", 8, [], {}].map((value): [string, unknown] => [
        `${field} 为 ${JSON.stringify(value)}`,
        { verdict: "通过", strengths: "稳定", weaknesses: "表达", suggestions: "练习", [field]: value },
      ]),
    ),
  ])("跨轮总评拒绝 %s 且保留三轮报告并允许重试", async (_label, invalid) => {
    seedInterview();
    const report = JSON.stringify({ depth: 8, structure: 8, authenticity: 8, completeness: 8, jd_match: 8, overall: 8, strengths: "优点", weaknesses: "不足", suggestions: "建议" });
    db.exec("INSERT INTO interview_series (id,resume_id,jd,created_at) VALUES (1,1,'岗位',''); DELETE FROM interviews; DELETE FROM interview_turns");
    const insert = db.prepare("INSERT INTO interviews (resume_id,jd,style,series_id,round_no,status,report,created_at) VALUES (1,'岗位',?,1,?,'finished',?,'')");
    insert.run("deep", 1, report); insert.run("manager", 2, report); insert.run("hr", 3, report);
    const rounds = db.prepare("SELECT * FROM interviews ORDER BY round_no").all();
    const valid = { verdict: "通过", strengths: "稳定", weaknesses: "表达", suggestions: "练习" };
    llm.chat.mockResolvedValue(JSON.stringify(invalid));
    const { POST } = await import("@/app/api/interviews/series/[id]/finalize/route");

    const rejected = await POST(request({}), context);
    expect(rejected.status).toBe(502);
    await expect(rejected.json()).resolves.toEqual({ error: expect.stringContaining("AI 总评") });
    expect(db.prepare("SELECT status, final_report, finished_at FROM interview_series WHERE id=1").get())
      .toEqual({ status: "ongoing", final_report: "", finished_at: "" });
    expect(db.prepare("SELECT * FROM interviews ORDER BY round_no").all()).toEqual(rounds);

    llm.chat.mockResolvedValue(JSON.stringify({ ...valid, overall: 1 }));
    const retried = await POST(request({}), context);
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({ report: { ...valid, overall: 8 } });
    const stored = db.prepare("SELECT status, final_report, finished_at FROM interview_series WHERE id=1").get();
    expect(stored).toMatchObject({ status: "finished", final_report: JSON.stringify({ overall: 8, ...valid }), finished_at: expect.any(String) });
    expect(stored?.finished_at).not.toBe("");
  });
  it("跨轮总评只接受第 1 至第 3 轮各一份报告", async () => {
    seedInterview();
    const report = JSON.stringify({ depth: 8, structure: 8, authenticity: 8, completeness: 8, jd_match: 8, overall: 8, strengths: "优点", weaknesses: "不足", suggestions: "建议" });
    db.exec("INSERT INTO interview_series (id,resume_id,jd,created_at) VALUES (1,1,'岗位',''); DELETE FROM interviews; DELETE FROM interview_turns");
    const insert = db.prepare("INSERT INTO interviews (resume_id,jd,style,series_id,round_no,status,report,created_at) VALUES (1,'岗位',?,1,?,'finished',?,'')");
    insert.run("gentle", 1, report); insert.run("hr", 3, report); insert.run("hr", 4, report);
    const { POST } = await import("@/app/api/interviews/series/[id]/finalize/route");
    const response = await POST(request({}), context);
    expect(response.status).toBe(400);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(db.prepare("SELECT final_report FROM interview_series WHERE id=1").get()).toEqual({ final_report: "" });
  });

  it("模型等待期间系列状态变化时过期总评不得落库", async () => {
    seedInterview();
    const report = JSON.stringify({ depth: 8, structure: 8, authenticity: 8, completeness: 8, jd_match: 8, overall: 8, strengths: "优点", weaknesses: "不足", suggestions: "建议" });
    db.exec("INSERT INTO interview_series (id,resume_id,jd,created_at) VALUES (1,1,'岗位',''); DELETE FROM interviews; DELETE FROM interview_turns");
    const insert = db.prepare("INSERT INTO interviews (resume_id,jd,style,series_id,round_no,status,report,created_at) VALUES (1,'岗位',?,1,?,'finished',?,'')");
    insert.run("gentle", 1, report); insert.run("manager", 2, report); insert.run("hr", 3, report);
    const paused = gate();
    llm.chat.mockReturnValue(paused.promise);
    const { POST } = await import("@/app/api/interviews/series/[id]/finalize/route");
    const response = POST(request({}), context);
    await vi.waitFor(() => expect(llm.chat).toHaveBeenCalledTimes(1));
    db.exec("UPDATE interview_series SET status='finished' WHERE id=1");
    paused.resolve('{"verdict":"过期","strengths":"稳定","weaknesses":"表达","suggestions":"练习"}');
    expect((await response).status).toBe(409);
    expect(db.prepare("SELECT final_report FROM interview_series WHERE id=1").get()).toEqual({ final_report: "" });
  });
  it("模型等待期间任一轮报告变化时过期总评不得落库", async () => {
    seedInterview();
    const report = { depth: 8, structure: 8, authenticity: 8, completeness: 8, jd_match: 8, overall: 8, strengths: "优点", weaknesses: "不足", suggestions: "建议" };
    db.exec("INSERT INTO interview_series (id,resume_id,jd,created_at) VALUES (1,1,'岗位',''); DELETE FROM interviews; DELETE FROM interview_turns");
    const insert = db.prepare("INSERT INTO interviews (resume_id,jd,style,series_id,round_no,status,report,created_at) VALUES (1,'岗位',?,1,?,'finished',?,'')");
    insert.run("gentle", 1, JSON.stringify(report)); insert.run("manager", 2, JSON.stringify(report)); insert.run("hr", 3, JSON.stringify(report));
    const paused = gate();
    llm.chat.mockReturnValue(paused.promise);
    const { POST } = await import("@/app/api/interviews/series/[id]/finalize/route");
    const response = POST(request({}), context);
    await vi.waitFor(() => expect(llm.chat).toHaveBeenCalledTimes(1));
    db.prepare("UPDATE interviews SET report = ? WHERE series_id = 1 AND round_no = 2")
      .run(JSON.stringify({ ...report, overall: 9, strengths: "已更新" }));
    paused.resolve('{"verdict":"过期","strengths":"稳定","weaknesses":"表达","suggestions":"练习"}');
    expect((await response).status).toBe(409);
    expect(db.prepare("SELECT final_report FROM interview_series WHERE id=1").get()).toEqual({ final_report: "" });
  });
  it("其他提交已完成当前题时，过期模型结果不得覆盖它", async () => {
    seedInterview();
    const paused = gate();
    llm.chatStream.mockReturnValue(paused.promise);
    const { POST } = await import("@/app/api/interviews/[id]/answer/route");
    const response = await POST(request({ turn_id: 1, answer: "过期回答" }), context);
    db.exec("UPDATE interview_turns SET answered_at='done',answer='已保存回答' WHERE id=1");
    paused.resolve(answerResult);
    expect(await response.text()).toContain("event: error");
    expect(db.prepare("SELECT answer FROM interview_turns WHERE id=1").get()).toEqual({ answer: "已保存回答" });
  });
  it("模型漏掉 hr_response 时返回 502 且不落库", async () => {
    seedNegotiation();
    const { POST } = await import("@/app/api/tools/salary-negotiations/[id]/turn/route");
    llm.chat.mockResolvedValueOnce('{"hr_tactics":"综合拉扯"}');
    const response = await POST(request({ user_message: "提高报价" }), context);
    expect(response.status).toBe(502);
    expect(db.prepare("SELECT COUNT(*) AS n FROM salary_negotiation_turns").get()).toEqual({ n: 1 });
  });
  it("成功谈判回合的并发请求仅追加一次，使用最大序号而非行数", async () => {
    seedNegotiation();
    db.exec("UPDATE salary_negotiation_turns SET turn_no=3");
    const paused = gate();
    llm.chat.mockReturnValue(paused.promise);
    const { POST } = await import("@/app/api/tools/salary-negotiations/[id]/turn/route");
    const first = POST(request({ user_message: "提高报价" }), context);
    await vi.waitFor(() => expect(llm.chat).toHaveBeenCalledTimes(1));
    const second = await POST(request({ user_message: "提高报价" }), context);
    paused.resolve(validNegotiationTurn);
    expect(second.status).toBe(409);
    expect((await first).status).toBe(201);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT turn_no FROM salary_negotiation_turns ORDER BY turn_no").all()).toEqual([{ turn_no: 3 }, { turn_no: 4 }]);
  });
  it("并发谈判只调用一次模型且结束后的过期回合不落库", async () => {
    seedNegotiation();
    const paused = gate();
    llm.chat.mockReturnValue(paused.promise);
    const { POST } = await import("@/app/api/tools/salary-negotiations/[id]/turn/route");
    const first = POST(request({ user_message: "提高报价" }), context);
    await vi.waitFor(() => expect(llm.chat).toHaveBeenCalledTimes(1));
    const secondPromise = POST(request({ user_message: "提高报价" }), context);
    // 先确认第二个请求已因锁被拒绝，再改状态；否则无法区分「被锁挡住」与「改完状态才被挡住」
    const second = await expectRejectedWithoutModel(secondPromise, "第二个谈判请求");
    expect(second.status).toBe(409);
    db.exec("UPDATE salary_negotiations SET status='finished' WHERE id=1");
    paused.resolve(validNegotiationTurn);
    expect((await first).status).toBe(409);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM salary_negotiation_turns").get()).toEqual({ n: 1 });
  });
  it.each(["turn", "finalize"] as const)("%s 先开始时，另一谈判命令在模型前被拒绝", async (firstKind) => {
    seedNegotiation();
    const paused = gate();
    llm.chat.mockReturnValue(paused.promise);
    const turn = await import("@/app/api/tools/salary-negotiations/[id]/turn/route");
    const finalize = await import("@/app/api/tools/salary-negotiations/[id]/finalize/route");
    const first = firstKind === "turn" ? turn.POST(request({ user_message: "提高报价" }), context) : finalize.POST(request({}), context);
    await vi.waitFor(() => expect(llm.chat).toHaveBeenCalledTimes(1));
    const second = firstKind === "turn" ? await finalize.POST(request({}), context) : await turn.POST(request({ user_message: "继续谈判" }), context);
    expect(second.status).toBe(409);
    paused.resolve(firstKind === "turn" ? validNegotiationTurn : validNegotiationReport);
    expect((await first).status).toBe(firstKind === "turn" ? 201 : 200);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status FROM salary_negotiations").get()).toEqual({ status: firstKind === "turn" ? "ongoing" : "finished" });
  });
  it("复盘模型等待期间其他连接追加回合，过期报告不得结束谈判", async () => {
    seedNegotiation();
    const paused = gate();
    llm.chat.mockReturnValue(paused.promise);
    const finalize = await import("@/app/api/tools/salary-negotiations/[id]/finalize/route");
    const response = finalize.POST(request({}), context);
    await vi.waitFor(() => expect(llm.chat).toHaveBeenCalledTimes(1));
    const writer = new DatabaseSync(path.join(tempDir, "data", "resume-life.db"));
    try { writer.exec("INSERT INTO salary_negotiation_turns (negotiation_id,turn_no,user_message,hr_response,created_at) VALUES (1,2,'新回合','新回复','')"); }
    finally { writer.close(); }
    paused.resolve(validNegotiationReport);
    expect((await response).status).toBe(409);
    expect(db.prepare("SELECT status,report FROM salary_negotiations").get()).toEqual({ status: "ongoing", report: "" });
  });
});

describe("谈判成本与收藏快照", () => {
  it("开局预算包括系统提示词，超限不调用模型也不创建谈判", async () => {
    llm.chat.mockResolvedValue(validNegotiationOpening);
    const { POST } = await import("@/app/api/tools/salary-negotiations/route");
    const response = await POST(request({ target_role: "岗位", expected_salary: "30k", current_or_competing_offer: "字".repeat(31000) }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("32000");
    expect(llm.chat).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM salary_negotiations").get()).toEqual({ n: 0 });
  });
  it("合法开局保持正常创建并传递取消信号", async () => {
    llm.chat.mockResolvedValue(validNegotiationOpening);
    const { POST } = await import("@/app/api/tools/salary-negotiations/route");
    const req = request({ target_role: "岗位", expected_salary: "30k", current_or_competing_offer: "同行报价" });
    expect((await POST(req)).status).toBe(201);
    expect(llm.chat.mock.calls[0]![2].signal).toBe(req.signal);
    expect(db.prepare("SELECT COUNT(*) AS n FROM salary_negotiations").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM salary_negotiation_turns").get()).toEqual({ n: 1 });
  });
  it("超长输入与回合上限在调用模型前被拒绝", async () => {
    seedNegotiation();
    llm.chat.mockResolvedValue('{"hr_response":"好"}');
    const { POST } = await import("@/app/api/tools/salary-negotiations/[id]/turn/route");
    expect((await POST(request({ user_message: "字".repeat(4001) }), context)).status).toBe(400);
    for (let i = 2; i <= 21; i++) db.prepare("INSERT INTO salary_negotiation_turns (negotiation_id,turn_no,user_message,hr_response,created_at) VALUES (1,?,'回答','回复','')").run(i);
    expect((await POST(request({ user_message: "再问" }), context)).status).toBe(400);
    expect(llm.chat).not.toHaveBeenCalled();
  });
  it("回合 prompt 拒绝超限，但合法旧会话的复盘会裁剪到预算内并保留全部回合", async () => {
    const builders = await import("@/lib/salary-negotiation-llm");
    const base = { targetCompanyTier: "公司", targetRole: "岗位", expectedSalary: "薪资", currentOrCompetingOffer: "", hrStyleDesc: "正常" };
    const turns = [{ turn_no: 1, user_message: "", hr_response: "字".repeat(33000), hr_mindset_str: "{}", mentor_analysis_str: "{}" }];
    expect(() => builders.buildTurnHistoryMessages({ ...base, turns, newUserMessage: "答" })).toThrow();
    expect(builders.buildFinalizeUserPrompt({ ...base, turns, initialOffer: "报价" }).length + builders.SALARY_NEGOTIATION_FINALIZE_PROMPT.length)
      .toBeLessThanOrEqual(builders.MAX_NEGOTIATION_CONTEXT_CHARS);
    const nearLimit = [{ ...turns[0]!, hr_response: "字".repeat(31500) }];
    expect(() => builders.buildTurnHistoryMessages({ ...base, turns: nearLimit, newUserMessage: "答" })).toThrow();
    expect(() => builders.buildFinalizeUserPrompt({ ...base, turns: nearLimit, initialOffer: "报价" })).not.toThrow();

    const twentyTurns = Array.from({ length: 20 }, (_, index) => ({
      turn_no: index + 1,
      user_message: "求".repeat(500),
      hr_response: "回".repeat(200),
      hr_mindset_str: "心理".repeat(500),
      mentor_analysis_str: "分析".repeat(500),
    }));
    const prompt = builders.buildFinalizeUserPrompt({ ...base, turns: twentyTurns, initialOffer: "报价" });
    expect(prompt.length + builders.SALARY_NEGOTIATION_FINALIZE_PROMPT.length)
      .toBeLessThanOrEqual(builders.MAX_NEGOTIATION_CONTEXT_CHARS);
    for (let turn = 1; turn <= 20; turn += 1) expect(prompt).toContain(`【第 ${turn} 回合】`);
    expect(prompt).not.toContain("军师即时分析");
    expect(prompt).not.toContain("HR心理状态");
  });
  it("收藏保留当时参考答案，重新生成源答案不改变收藏", async () => {
    seedInterview();
    const notebook = await import("@/app/api/notebook/route");
    expect((await notebook.POST(request({ source: "interview", source_id: 1 }))).status).toBe(201);
    expect(db.prepare("SELECT reference FROM notebook_entries").get()).toEqual({ reference: "原参考答案" });
    llm.chat.mockResolvedValue('{"reference":"新参考答案"}');
    const reference = await import("@/app/api/interviews/[id]/turns/[tid]/reference/route");
    expect((await reference.POST(request({}), { params: Promise.resolve({ id: "1", tid: "1" }) })).status).toBe(200);
    expect(db.prepare("SELECT reference FROM interview_turns").get()).toEqual({ reference: "新参考答案" });
    expect(db.prepare("SELECT reference FROM notebook_entries").get()).toEqual({ reference: "原参考答案" });
  });
});

describe("inTransaction 的并发语义", () => {
  it("BEGIN IMMEDIATE 争锁失败后，下一次事务仍能整体回滚", async () => {
    const { inTransaction } = await import("@/lib/db");
    db.exec("CREATE TABLE tx_probe (value TEXT NOT NULL)");
    db.exec("PRAGMA busy_timeout = 10");
    const other = new DatabaseSync(path.join(tempDir, "data", "resume-life.db"));
    other.exec("BEGIN IMMEDIATE");
    try {
      expect(() => inTransaction(() => db.exec("INSERT INTO tx_probe VALUES ('blocked')")))
        .toThrow(/database is locked/i);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }

    expect(() => inTransaction(() => {
      db.exec("INSERT INTO tx_probe VALUES ('must roll back')");
      throw new Error("force rollback");
    })).toThrow("force rollback");
    expect(db.prepare("SELECT COUNT(*) AS n FROM tx_probe").get()).toEqual({ n: 0 });
  });

  it("两个连接争用同一库时，写锁冲突会在 busy_timeout 内等待而非立即失败", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tx-immediate-"));
    const file = path.join(dir, "probe.db");

    const a = new DatabaseSync(file);
    const b = new DatabaseSync(file);
    try {
      a.exec("PRAGMA journal_mode = WAL");
      b.exec("PRAGMA journal_mode = WAL");
      b.exec("PRAGMA busy_timeout = 5000");
      a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");

      a.exec("BEGIN IMMEDIATE");
      a.prepare("INSERT INTO t (v) VALUES ('from-a')").run();

      // B 在 A 持有写锁时发起写入：应等待，而不是立刻抛 SQLITE_BUSY
      const started = Date.now();
      let threw: unknown = null;
      try {
        b.exec("BEGIN IMMEDIATE");
        b.prepare("INSERT INTO t (v) VALUES ('from-b')").run();
        b.exec("COMMIT");
      } catch (err) {
        threw = err;
      }
      const waited = Date.now() - started;

      a.exec("COMMIT");

      if (threw) {
        // 允许最终超时报错，但必须已经等待过（证明 busy_timeout 生效，而非立即失败）
        expect(waited).toBeGreaterThanOrEqual(4000);
      }
    } finally {
      a.close();
      b.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // 本用例刻意等待 busy_timeout（5 秒）超时，故必须放宽 vitest 默认的 5 秒单测超时
  }, 15_000);

  it("inTransaction 使用 BEGIN IMMEDIATE 而非 deferred BEGIN", async () => {
    const { inTransaction } = await import("@/lib/db");
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");
    inTransaction(() => undefined);
    expect(execSpy).toHaveBeenCalledWith("BEGIN IMMEDIATE");
    expect(execSpy).not.toHaveBeenCalledWith("BEGIN");
  });

  it("getDb 建立的连接设置了 busy_timeout（跨进程锁等待自动重试）", () => {
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  });
});
