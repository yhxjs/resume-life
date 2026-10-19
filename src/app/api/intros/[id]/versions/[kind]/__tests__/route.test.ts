import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-intro-save-test-";
const original = [{ text: "原有介绍", comment: "原有点评" }];
const context = { params: Promise.resolve({ id: "1", kind: "30s" }) };
let tempDir: string;
let db: DatabaseSync;
let revision: string;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  db.prepare("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, 'Synthetic', '', '')").run();
  db.prepare("INSERT INTO intros (id, resume_id, jd, created_at) VALUES (1, 1, '', '')").run();
  db.prepare("INSERT INTO intro_versions (intro_id, kind, sentences, updated_at) VALUES (1, '30s', ?, 'original')")
    .run(JSON.stringify(original));
  const { introVersionRevision } = await import("@/lib/intro-versions");
  revision = introVersionRevision(stored());
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolved = path.resolve(tempDir);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error(`Unsafe cleanup path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

function stored() {
  return db.prepare("SELECT id, sentences, updated_at FROM intro_versions WHERE intro_id = 1 AND kind = '30s'").get() as {
    id: number; sentences: string; updated_at: string;
  };
}

async function save(sentences: unknown) {
  const { PATCH } = await import("../route");
  return PATCH(new Request("http://127.0.0.1/api/intros/1/versions/30s", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sentences, baseRevision: revision }),
  }), context);
}

describe("自我介绍用户保存边界", () => {
  it.each([
    ["800 字", [{ text: "字".repeat(795) + "尾部不能丢", comment: "" }]],
    ["60 句", Array.from({ length: 60 }, (_, i) => ({ text: `第 ${i + 1} 句`, comment: "" }))],
    ["正文空白", [{ text: "  原样保存\n正文  ", comment: "" }]],
  ])("完整保存合法的 %s", async (_label, sentences) => {
    const response = await save(sentences);
    expect(response.status).toBe(200);
    expect((await response.json()).sentences).toEqual(sentences);
    expect(JSON.parse(stored().sentences)).toEqual(sentences);
  });

  it.each([
    ["801 字", [{ text: "字".repeat(801), comment: "" }]],
    ["61 句", Array.from({ length: 61 }, () => ({ text: "句子", comment: "" }))],
    ["空句混合", [{ text: "合法句子", comment: "" }, { text: "  \n ", comment: "" }]],
    ["正文类型错误", [{ text: "合法句子", comment: "" }, { text: 123, comment: "" }]],
    ["句子类型错误", [{ text: "合法句子", comment: "" }, null]],
    ["点评类型错误", [{ text: "合法句子", comment: 123 }]],
    ["点评超过 300 字", [{ text: "合法句子", comment: "字".repeat(301) }]],
    ["空列表", []],
    ["不是列表", "句子"],
  ])("拒绝 %s 且不写入任何内容", async (_label, sentences) => {
    const before = stored();
    const response = await save(sentences);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual(expect.any(String));
    expect(stored()).toEqual(before);
  });

  it("继续兼容 AI 输出的截断与无效句过滤", async () => {
    const { normalizeSentences } = await import("@/lib/intro");
    expect(normalizeSentences([{ text: " " }, { text: "字".repeat(801), comment: "字".repeat(301) }]))
      .toEqual([{ text: "字".repeat(800), comment: "字".repeat(300) }]);
    expect(normalizeSentences(Array.from({ length: 61 }, () => ({ text: "句子" })))).toHaveLength(60);
  });
});
