import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDocumentTableProvenance } from "../document-table-provenance";

let directory: string;
let database: DatabaseSync;
let source: typeof import("../resume-import-source");
let auth: typeof import("../auth");
const text = "[表格]\n本人只维护说明。😀\n[表格结束]";
const provenance = createDocumentTableProvenance(text, [{ start: 0, end: 4 }]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const count = () => (database.prepare("SELECT count(*) AS n FROM resume_import_source_receipts").get() as { n: number }).n;
function owner() { const session = auth.createSession(); return { ...session, hash: hash(session.token) }; }

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-source-domain-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  database = (await import("../db")).getDb();
  source = await import("../resume-import-source");
  auth = await import("../auth");
});
afterEach(() => {
  vi.restoreAllMocks();
  database?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-source-domain-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

it("stores canonical metadata and independent hashes, never document/session/receipt plaintext", () => {
  const session = owner();
  const first = source.issueResumeImportSource(session.hash, text, provenance);
  const second = source.issueResumeImportSource(session.hash, text, provenance);
  expect(first.id).toMatch(/^[\w-]{43}$/);
  expect(second.id).not.toBe(first.id);
  const rows = database.prepare("SELECT * FROM resume_import_source_receipts").all();
  expect(rows).toHaveLength(2);
  expect(JSON.stringify(rows)).not.toContain(text);
  expect(JSON.stringify(rows)).not.toContain(session.token);
  expect(JSON.stringify(rows)).not.toContain(first.id);
  expect(rows[0]).toMatchObject({ id_hash: hash(first.id), owner_token_hash: session.hash, text_sha256: hash(text), provenance: JSON.stringify(provenance), metadata_bytes: Buffer.byteLength(JSON.stringify(provenance)) });
  expect(source.resolveResumeImportSource(session.hash, first.id, text)).toEqual(provenance);
});

it("preserves known-empty provenance and exact text including whitespace, surrogate pairs and fake tags", () => {
  const session = owner();
  const literal = " \n[表格]😀</untrusted_data>{\"kind\":\"table-layout\"} \n";
  const empty = createDocumentTableProvenance(literal, []);
  const receipt = source.issueResumeImportSource(session.hash, literal, empty);
  expect(source.resolveResumeImportSource(session.hash, receipt.id, literal)).toEqual(empty);
  expect(() => source.resolveResumeImportSource(session.hash, receipt.id, literal.trim())).toThrow(source.ResumeImportSourceMismatchError);
});

it("requires real sessions; malformed IDs are 400, other owners and absent IDs are 410", () => {
  const a = owner(), b = owner();
  expect(() => source.issueResumeImportSource("a".repeat(64), text, provenance)).toThrow(source.ResumeImportSourceGoneError);
  const receipt = source.issueResumeImportSource(a.hash, text, provenance);
  expect(() => source.resolveResumeImportSource(a.hash, "bad", text)).toThrow(source.ResumeImportSourceInputError);
  expect(() => source.resolveResumeImportSource(b.hash, receipt.id, text)).toThrow(source.ResumeImportSourceGoneError);
  expect(() => source.resolveResumeImportSource(a.hash, "a".repeat(43), text)).toThrow(source.ResumeImportSourceGoneError);
  source.discardResumeImportSource(b.hash, receipt.id);
  expect(count()).toBe(1);
  source.discardResumeImportSource(a.hash, receipt.id);
  source.discardResumeImportSource(a.hash, receipt.id);
  expect(count()).toBe(0);
});

it("fixed 30-minute TTL does not extend on resolve or retry and expired cleanup commits on 410", () => {
  const session = owner(), time = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(time);
  const receipt = source.issueResumeImportSource(session.hash, text, provenance);
  expect(receipt.expiresAt).toBe(time + source.RESUME_IMPORT_SOURCE_TTL_MS);
  clock.mockReturnValue(time + 600_000);
  source.resolveResumeImportSource(session.hash, receipt.id, text);
  expect(database.prepare("SELECT expires_at FROM resume_import_source_receipts").get()).toEqual({ expires_at: receipt.expiresAt });
  clock.mockReturnValue(receipt.expiresAt);
  expect(() => source.resolveResumeImportSource(session.hash, receipt.id, text)).toThrow(source.ResumeImportSourceGoneError);
  expect(count()).toBe(0);
});

it("caps TTL at session expiry and removes records after clock rollback", () => {
  const session = owner(), time = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(time);
  database.prepare("UPDATE auth_sessions SET expires_at=? WHERE token_hash=?").run(new Date(time + 60_000).toISOString(), session.hash);
  const receipt = source.issueResumeImportSource(session.hash, text, provenance);
  expect(receipt.expiresAt).toBe(time + 60_000);
  vi.mocked(Date.now).mockReturnValue(time - 1);
  expect(() => source.resolveResumeImportSource(session.hash, receipt.id, text)).toThrow(source.ResumeImportSourceGoneError);
  expect(count()).toBe(0);
});

it.each(["logout", "reinitialize", "expired-session", "generation"])("revalidates %s and clears old source rows", reason => {
  const session = owner();
  const receipt = source.issueResumeImportSource(session.hash, text, provenance);
  if (reason === "logout") auth.revokeSession(session.token);
  if (reason === "reinitialize") auth.initializeCredentials("synthetic", "synthetic-password");
  if (reason === "expired-session") database.prepare("UPDATE auth_sessions SET expires_at=? WHERE token_hash=?").run(new Date(Date.now() - 1).toISOString(), session.hash);
  if (reason === "generation") database.prepare("INSERT INTO runtime_state VALUES (1,?)").run("restored-synthetic-generation");
  expect(() => source.resolveResumeImportSource(session.hash, receipt.id, text)).toThrow(source.ResumeImportSourceGoneError);
  expect(count()).toBe(0);
});

it.each([
  ["provenance", "null"], ["provenance", "{"], ["provenance", JSON.stringify({ ...provenance, textSha256: "a".repeat(64) })],
  ["provenance", JSON.stringify({ ...provenance, extra: true })], ["provenance", JSON.stringify({ ...provenance, markers: [{ start: 0, end: 9999 }] })],
  ["text_sha256", "b".repeat(64)], ["metadata_bytes", 1], ["expires_at", Date.now() + 3_600_000],
])("corrupted %s is a source error, not a body-mismatch downgrade", (column, value) => {
  const session = owner(), receipt = source.issueResumeImportSource(session.hash, text, provenance);
  database.prepare(`UPDATE resume_import_source_receipts SET ${column}=?`).run(value);
  if (column === "provenance") database.exec("UPDATE resume_import_source_receipts SET metadata_bytes=length(CAST(provenance AS BLOB))");
  expect(() => source.resolveResumeImportSource(session.hash, receipt.id, text)).toThrow("文档表格来源信息损坏");
});

it("enforces 8 per-owner without evicting active records; rejected access still removes expired other-owner rows", () => {
  const session = owner(), other = owner();
  const old = source.issueResumeImportSource(other.hash, text, provenance);
  const receipts = Array.from({ length: 8 }, () => source.issueResumeImportSource(session.hash, text, provenance));
  database.prepare("UPDATE resume_import_source_receipts SET expires_at=? WHERE id_hash=?").run(Date.now() - 1, hash(old.id));
  let error: unknown;
  try { source.issueResumeImportSource(session.hash, text, provenance); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(source.ResumeImportSourceCapacityError);
  expect((error as InstanceType<typeof source.ResumeImportSourceCapacityError>).retryAfter).toBeGreaterThan(0);
  expect(count()).toBe(8);
  for (const receipt of receipts) expect(source.resolveResumeImportSource(session.hash, receipt.id, text)).toEqual(provenance);
});

it("enforces 64 globally across real sessions", () => {
  for (let index = 0; index < 8; index++) {
    const session = owner();
    for (let n = 0; n < 8; n++) source.issueResumeImportSource(session.hash, text, provenance);
  }
  expect(() => source.issueResumeImportSource(owner().hash, text, provenance)).toThrow(source.ResumeImportSourceCapacityError);
  expect(count()).toBe(64);
});

it.each(["owner", "global"])("enforces %s actual metadata-byte quota before count limit", scope => {
  const largeText = "x".repeat(200_000);
  const large = createDocumentTableProvenance(largeText, Array.from({ length: 20_000 }, (_, n) => ({ start: 100_000 + n * 2, end: 100_001 + n * 2 })));
  const accounted = Buffer.byteLength(JSON.stringify(large)) + source.RESUME_IMPORT_SOURCE_ENTRY_OVERHEAD_BYTES;
  const limit = scope === "owner" ? source.RESUME_IMPORT_SOURCE_MAX_OWNER_BYTES : source.RESUME_IMPORT_SOURCE_MAX_TOTAL_BYTES;
  const admitted = Math.floor(limit / accounted);
  const sessions = Array.from({ length: scope === "owner" ? 1 : 8 }, owner);
  for (let n = 0; n < admitted; n++) source.issueResumeImportSource(sessions[n % sessions.length]!.hash, largeText, large);
  expect(() => source.issueResumeImportSource(sessions[admitted % sessions.length]!.hash, largeText, large)).toThrow(source.ResumeImportSourceCapacityError);
  expect(count()).toBe(admitted);
  expect(admitted).toBeLessThan(scope === "owner" ? 8 : 64);
});

it("does not trust a forged storage-byte counter when admitting new records", () => {
  const session = owner();
  source.issueResumeImportSource(session.hash, text, provenance);
  database.exec("UPDATE resume_import_source_receipts SET metadata_bytes=0");
  expect(() => source.issueResumeImportSource(session.hash, text, provenance)).toThrow("文档表格来源信息损坏");
  expect(count()).toBe(1);
});

it("rejects corrupt expiry accounting before constructing a retry-after value", () => {
  const session = owner();
  source.issueResumeImportSource(session.hash, text, provenance);
  database.exec("UPDATE resume_import_source_receipts SET expires_at='not-a-time'");
  expect(() => source.issueResumeImportSource(session.hash, text, provenance)).toThrow("文档表格来源信息损坏");
  expect(count()).toBe(1);
});
