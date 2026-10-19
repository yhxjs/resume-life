import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { safeChat } = vi.hoisted(() => ({ safeChat: vi.fn() }));
vi.mock("@/lib/safe-llm", async (original) => ({
  ...await original<typeof import("@/lib/safe-llm")>(),
  safeChat,
}));

const TEMP_PREFIX = "resume-life-intro-regenerate-test-";
const originalSentences = [{ text: "Original introduction", comment: "Original comment" }];
const generatedSentences = [{ text: "Generated introduction", comment: "Generated comment" }];
const generatedJson = JSON.stringify({ versions: [{ kind: "30s", sentences: generatedSentences }] });
const context = { params: Promise.resolve({ id: "1" }) };
let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  safeChat.mockReset().mockResolvedValue(generatedJson);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  db.prepare("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, 'Audit resume', '', '')").run();
  db.prepare("INSERT INTO intros (id, resume_id, jd, created_at) VALUES (1, 1, 'Synthetic JD', '')").run();
  seedVersion();
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

function seedVersion() {
  db.prepare("INSERT INTO intro_versions (intro_id, kind, sentences, updated_at) VALUES (1, '30s', ?, 'original-revision')")
    .run(JSON.stringify(originalSentences));
}

function request() {
  return new Request("http://127.0.0.1/api/intros/1/regenerate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "30s" }),
  });
}

function storedSentences() {
  const row = db.prepare("SELECT sentences FROM intro_versions WHERE intro_id = 1 AND kind = '30s'").get() as { sentences: string } | undefined;
  return row ? JSON.parse(row.sentences) : undefined;
}

async function pausedGeneration() {
  const entered = Promise.withResolvers<void>();
  const model = Promise.withResolvers<string>();
  safeChat.mockImplementationOnce(() => {
    entered.resolve();
    return model.promise;
  });
  const { POST } = await import("../route");
  const response = POST(request(), context);
  await entered.promise;
  return { response, release: () => model.resolve(generatedJson) };
}

describe("intro regeneration commit boundary", () => {
  it("commits the generated version when the original is unchanged", async () => {
    const { POST } = await import("../route");
    expect((await POST(request(), context)).status).toBe(200);
    expect(storedSentences()).toEqual(generatedSentences);
  });

  it("rejects a late result after a manual edit and preserves the saved sentences", async () => {
    const pending = await pausedGeneration();
    const manualSentences = [{ text: "New manual introduction", comment: "" }];
    const { GET } = await import("../../route");
    const detail = await (await GET(new Request("http://localhost/api/intros/1"), context)).json();
    const { PATCH } = await import("../../versions/[kind]/route");
    const edited = await PATCH(new Request("http://127.0.0.1/api/intros/1/versions/30s", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sentences: manualSentences, baseRevision: detail.versions[0].revision }),
    }), { params: Promise.resolve({ id: "1", kind: "30s" }) });
    expect(edited.status).toBe(200);
    pending.release();
    expect((await pending.response).status).toBe(409);
    expect(storedSentences()).toEqual(manualSentences);
  });

  it("rejects a changed database generation even when sentences are unchanged", async () => {
    const pending = await pausedGeneration();
    db.prepare("INSERT INTO runtime_state (id, data_generation) VALUES (1, 'restored-generation') ON CONFLICT(id) DO UPDATE SET data_generation = excluded.data_generation").run();
    pending.release();
    expect((await pending.response).status).toBe(409);
    expect(storedSentences()).toEqual(originalSentences);
  });

  it("returns 404 after the target version has been deleted", async () => {
    const pending = await pausedGeneration();
    db.prepare("DELETE FROM intro_versions WHERE intro_id = 1 AND kind = '30s'").run();
    pending.release();
    expect((await pending.response).status).toBe(404);
    expect(storedSentences()).toBeUndefined();
  });

  it("rejects deletion and recreation of the same intro and kind", async () => {
    const pending = await pausedGeneration();
    db.prepare("DELETE FROM intros WHERE id = 1").run();
    db.prepare("INSERT INTO intros (id, resume_id, jd, created_at) VALUES (1, 1, 'Synthetic JD', '')").run();
    seedVersion();
    pending.release();
    expect((await pending.response).status).toBe(409);
    expect(storedSentences()).toEqual(originalSentences);
  });

  it("rejects a saved revision even when the visible text was restored", async () => {
    const pending = await pausedGeneration();
    db.prepare("UPDATE intro_versions SET updated_at = 'new-revision' WHERE intro_id = 1 AND kind = '30s'").run();
    pending.release();
    expect((await pending.response).status).toBe(409);
    expect(storedSentences()).toEqual(originalSentences);
  });

  it("returns 404 before calling the model for a missing version", async () => {
    db.prepare("DELETE FROM intro_versions WHERE intro_id = 1 AND kind = '30s'").run();
    const { POST } = await import("../route");
    expect((await POST(request(), context)).status).toBe(404);
    expect(safeChat).not.toHaveBeenCalled();
  });
});
