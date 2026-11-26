import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as z from "zod/v4";
import type { RebaseRegistrar } from "./rebase-tools";
import type { McpTools } from "./tools";

// Integration fixtures deliberately inspect arbitrary decoded JSON contracts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Bag = Record<string, any>;
let directory: string, db: DatabaseSync, appId: number;
const connections: { client: Client; server: McpServer }[] = [];
let client: Client;
async function connect(allow?: Set<string>) {
  const server = new McpServer({ name: "isolated-rebase-test", version: "1" });
  const { classifyMcpError } = await import("@/lib/mcp-errors");
  const { REBASE_OUTPUT_SCHEMAS } = await import("@/lib/mcp-rebase-types");
  const registrar: RebaseRegistrar = {
    permits: (...names) => !allow || names.every(n => allow.has(n)),
    register(name, config, run) {
      server.registerTool(name, { ...config, inputSchema: config.inputSchema as z.ZodType }, async args => {
        try {
          const response = await run(config.inputSchema.parse(args));
          if (Object.hasOwn(REBASE_OUTPUT_SCHEMAS, name)) {
            const text = response.content.find(v => v.type === "text");
            REBASE_OUTPUT_SCHEMAS[name].parse(JSON.parse(text?.type === "text" ? text.text : "{}"));
          }
          return response;
        }
        catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify(classifyMcpError(error)) }] }; }
      });
    },
  };
  (await import("./rebase-tools")).registerRebaseTools(registrar);
  // Same callbacks as production; central config/output registries intentionally remain the main agent's scope.
  (await import("./resume-draft-tools")).registerResumeDraftTools(registrar as unknown as McpTools);
  const c = new Client({ name: "agent", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await c.connect(a);
  connections.push({ client: c, server }); return c;
}
async function call(name: string, args: Bag, c = client) {
  const result = await c.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[]).find(v => v.type === "text")!.text;
  let value: Bag;
  try { value = JSON.parse(text); } catch { value = { message: text }; }
  return { result, value };
}
async function ok(name: string, args: Bag, c = client): Promise<Bag> {
  const { result, value } = await call(name, args, c); expect(result.isError, JSON.stringify(value)).not.toBe(true); return value;
}
async function fail(name: string, args: Bag, code: string, c = client) {
  const { result, value } = await call(name, args, c); expect(result.isError).toBe(true); expect(value.code).toBe(code); return value;
}
async function full(name: string, args: Bag, c = client) {
  let section = await ok(name, args, c), text = section.text;
  const revision = section.revision, previewToken = section.previewToken;
  while (section.nextOffset !== null) {
    const page = { offset: section.nextOffset, expectedRevision: revision, length: args.page?.length ?? 4000 };
    section = await ok(name, { ...args, ...(name === "get_resume_draft_context" ? page : { page }) }, c); text += section.text;
  }
  expect(text.length).toBe(section.totalLength);
  return { revision, previewToken, value: JSON.parse(text) as Bag };
}
async function resumeBase() {
  const read = await full("get_resume_draft_context", { resumeId: 1 });
  return (await full("preview_resume_draft_rebase", { mode: "capture", resumeId: 1, expectedRevision: read.revision })).value;
}
async function appBase() {
  const { getApplicationById } = await import("@/lib/applications"), { mcpRevision } = await import("@/lib/mcp-revision");
  return (await full("preview_application_rebase", { mode: "capture", applicationId: appId, expectedRevision: mcpRevision("application", getApplicationById(appId)!) })).value;
}
async function webResume(content: Bag) {
  const { loadResume } = await import("@/lib/resumes"), { PATCH } = await import("@/app/api/resumes/[id]/route");
  const mod = loadResume(1)!.modules[0]!;
  const response = await PATCH(new Request("http://localhost/api/resumes/1", { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modules: { [mod.key]: content }, moduleRevisions: { [mod.key]: mod.revision } }) }), { params: Promise.resolve({ id: "1" }) });
  expect(response.status, JSON.stringify(await response.json())).toBe(200);
}
async function webApplication(fields: Bag) {
  const { PATCH } = await import("@/app/api/applications/[id]/route");
  const response = await PATCH(new Request("http://localhost/api/applications/1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) }),
    { params: Promise.resolve({ id: String(appId) }) });
  expect(response.status, JSON.stringify(await response.json())).toBe(200);
}
beforeEach(async () => {
  vi.resetModules(); directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-rebase-")); vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb();
  db.exec(`INSERT INTO resumes(id,title,created_at,updated_at) VALUES(1,'resume','','');
    INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES(1,'basic','basic','基本',0,'{"name":"base","phone":"123","email":"a@b.c","location":"HK","birthday":"","links":""}','')`);
  const version = (await import("@/lib/resume-versions")).publishResumeVersion(1, { name: "published" });
  appId = (await import("@/lib/applications")).createApplication({ company: "company", role: "role", stage: "applied", resume_id: 1, resume_version_id: version.id, notes: "base note", jd: "base jd" }).id;
  client = await connect();
});
afterEach(async () => {
  for (const c of connections.splice(0)) { await c.client.close(); await c.server.close(); }
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-rebase-")) throw new Error("unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

it("preserves Web changes and both Agents' disjoint edits using real preview/save, with fixed published snapshots", async () => {
  const agent2 = await connect(), base = await resumeBase();
  const frozen = db.prepare("SELECT snapshot FROM resume_versions").all();
  const submission = db.prepare("SELECT submitted_resume,submitted_jd FROM applications WHERE id=?").get(appId);
  const old = base.original.modules[0];
  await webResume({ ...old.content, phone: "web" });
  for (const [c, field, value] of [[client, "name", "agent1"], [agent2, "email", "agent2@example.com"]] as const) {
    const result = (await full("preview_resume_draft_rebase", { mode: "rebase", resumeId: 1, baseToken: base.baseToken,
      proposed: { modules: [{ ...old, content: { ...old.content, [field]: value } }] } }, c)).value;
    expect(result.unresolved).toBe(0); expect(result.prepared).not.toBeNull();
    const preview = await full(result.prepared.tool, result.prepared.arguments, c);
    const args = { ...result.prepared.arguments, previewToken: preview.previewToken, idempotencyKey: `save-agent-${field}` };
    await ok("save_resume_draft_edit", args, c); await ok("save_resume_draft_edit", args, c);
  }
  const final = JSON.parse(String(db.prepare("SELECT content FROM resume_modules").get()!.content));
  expect(final).toMatchObject({ name: "agent1", email: "agent2@example.com", phone: "web" });
  expect(db.prepare("SELECT snapshot FROM resume_versions").all()).toEqual(frozen);
  expect(db.prepare("SELECT submitted_resume,submitted_jd FROM applications WHERE id=?").get(appId)).toEqual(submission);
});

it("requires choices for the same field and fresh comparison after a further edit; never writes on preview", async () => {
  const base = await resumeBase(), old = base.original.modules[0];
  await webResume({ ...old.content, name: "web" });
  const input = { mode: "rebase", resumeId: 1, baseToken: base.baseToken, proposed: { modules: [{ ...old, content: { ...old.content, name: "mine", email: "new" } }] } };
  const result = (await full("preview_resume_draft_rebase", input)).value;
  expect(result).toMatchObject({ unresolved: 1, prepared: null });
  expect(result.safeProposal.modules[0].content).toMatchObject({ name: "web", email: "new" });
  const choice = { path: result.conflicts[0].path, take: "proposed" };
  await fail("preview_resume_draft_rebase", { ...input, choices: [choice] }, "INVALID_ARGUMENT");
  const resolved = (await full("preview_resume_draft_rebase", { ...input, expectedRevision: result.currentRevision, choices: [choice] })).value;
  const preview = await full(resolved.prepared.tool, resolved.prepared.arguments);
  await webResume({ ...old.content, name: "web2" });
  await fail("save_resume_draft_edit", { ...resolved.prepared.arguments, previewToken: preview.previewToken, idempotencyKey: "stale-after-preview" }, "CONFLICT");
  await fail("preview_resume_draft_rebase", { ...input, expectedRevision: result.currentRevision, choices: [choice] }, "CONFLICT");
});

it("merges application fields and recovers save after reconnect without altering first submission", async () => {
  const base = await appBase(), submission = db.prepare("SELECT submitted_resume,submitted_jd FROM applications WHERE id=?").get(appId);
  await webApplication({ notes: "web note" });
  const input = { mode: "rebase", applicationId: appId, baseToken: base.baseToken, proposed: { jd: "mine jd" } };
  const r = (await full("preview_application_rebase", input)).value;
  expect(r.unresolved).toBe(0); expect(r.safeProposal.fields).toEqual({ jd: "mine jd" });
  const before = db.prepare("SELECT * FROM applications WHERE id=?").get(appId);
  const preview = await full(r.prepared.tool, r.prepared.arguments);
  expect(db.prepare("SELECT * FROM applications WHERE id=?").get(appId)).toEqual(before);
  const args = { ...r.prepared.arguments, previewToken: preview.previewToken, idempotencyKey: "application-reconnect" };
  await ok("save_application_edit", args);
  const client2 = await connect(); await ok("save_application_edit", args, client2);
  expect(db.prepare("SELECT notes,jd FROM applications WHERE id=?").get(appId)).toEqual({ notes: "web note", jd: "mine jd" });
  expect(db.prepare("SELECT submitted_resume,submitted_jd FROM applications WHERE id=?").get(appId)).toEqual(submission);
  expect(db.prepare("SELECT count(*) n FROM mcp_creation_receipts WHERE tool='save_application_edit'").get()!.n).toBe(1);
});

it("reports application same-field and lifecycle coupling conflicts and requires new preview", async () => {
  const base = await appBase(); await webApplication({ notes: "web", stage: "interviewing" });
  const input = { mode: "rebase", applicationId: appId, baseToken: base.baseToken, proposed: { notes: "mine", stage: "rejected", terminal_stage: "resume_screening", terminal_reason: "reason" } };
  const r = (await full("preview_application_rebase", input)).value;
  expect(r.unresolved).toBe(2); expect(r.conflicts.map((v: Bag) => v.path)).toEqual([["notes"], ["lifecycle"]]);
  const resolved = (await full("preview_application_rebase", { ...input, expectedRevision: r.currentRevision,
    choices: r.conflicts.map((v: Bag) => ({ path: v.path, take: "proposed" })) })).value;
  const preview = await full(resolved.prepared.tool, resolved.prepared.arguments);
  await fail("save_application_edit", { ...resolved.prepared.arguments, fields: { notes: "tampered" }, previewToken: preview.previewToken, idempotencyKey: "tampered-preview" }, "CONFLICT");
  await webApplication({ notes: "later" });
  await fail("save_application_edit", { ...resolved.prepared.arguments, previewToken: preview.previewToken, idempotencyKey: "stale-app-preview" }, "CONFLICT");
});

it("binds base to source, workspace and generation and keeps it usable on a fresh server connection", async () => {
  const rb = await resumeBase(), ab = await appBase();
  const input = { mode: "rebase", resumeId: 1, baseToken: rb.baseToken, proposed: { title: "new", modules: [] } };
  await full("preview_resume_draft_rebase", input, await connect());
  db.exec("INSERT INTO resumes(id,title,created_at,updated_at) VALUES(2,'other','','')");
  await fail("preview_resume_draft_rebase", { ...input, resumeId: 2 }, "CONFLICT");
  db.exec("UPDATE mcp_runtime_identity SET instance_id='different-workspace' WHERE id=1");
  await fail("preview_resume_draft_rebase", input, "CONFLICT");
  db.exec("UPDATE runtime_state SET data_generation='restored' WHERE id=1");
  await fail("preview_application_rebase", { mode: "rebase", applicationId: appId, baseToken: ab.baseToken, proposed: { notes: "old" } }, "CONFLICT");
});

it("fails before reading sources when permissions are missing, even with a stolen valid token", async () => {
  const base = await resumeBase(), applicationBase = await appBase();
  const denied = await connect(new Set());
  const before = db.prepare("SELECT count(*) n FROM mcp_creation_receipts").get();
  for (const resumeId of [1, 999999]) {
    const result = await fail("preview_resume_draft_rebase", { mode: "rebase", resumeId, baseToken: base.baseToken, proposed: { modules: [] } }, "FORBIDDEN", denied);
    expect(JSON.stringify(result)).not.toContain("a@b.c");
  }
  await fail("preview_application_rebase", { mode: "rebase", applicationId: appId, baseToken: applicationBase.baseToken, proposed: { notes: "test" } }, "FORBIDDEN", denied);
  expect(db.prepare("SELECT count(*) n FROM mcp_creation_receipts").get()).toEqual(before);
});

it("pages large Unicode comparisons losslessly, rejecting a cursor when source changes", async () => {
  const base = await appBase(), input = { mode: "rebase", applicationId: appId, baseToken: base.baseToken, proposed: { notes: "😀中文".repeat(4000) }, page: { length: 3999 } };
  const value = (await full("preview_application_rebase", input)).value;
  expect(value.prepared.arguments.fields.notes).toBe(input.proposed.notes);
  const first = await ok("preview_application_rebase", input);
  await webApplication({ jd: "new" });
  await fail("preview_application_rebase", { ...input, page: { offset: first.nextOffset, expectedRevision: first.revision } }, "CONFLICT");
});

it("does not drop unknown current metadata, silently change module types or accept spoofed base", async () => {
  const base = await resumeBase(), old = base.original.modules[0];
  db.prepare("UPDATE resumes SET style_overrides=? WHERE id=1").run('{"fontSize":13}');
  const input = { mode: "rebase", resumeId: 1, baseToken: base.baseToken, proposed: { title: "title", modules: [] } };
  const r = (await full("preview_resume_draft_rebase", input)).value;
  expect(r).toMatchObject({ unresolved: 1, prepared: null }); expect(r.conflicts[0].reason).toBe("metadata-changed-use-current");
  const ack = (await full("preview_resume_draft_rebase", { ...input, expectedRevision: r.currentRevision, choices: [{ path: ["metadata"], take: "current" }] })).value;
  expect(ack.prepared.arguments.title).toBe("title");
  const typeChange = (await full("preview_resume_draft_rebase", { ...input, proposed: { modules: [{ key: "basic", type: "summary", label: "基本", content: { text: "type-change" } }] } })).value;
  expect(typeChange.prepared).toBeNull(); expect(typeChange.blockers.join()).toContain("类型");
  db.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ ...old.content, futureMetadata: "retain" }));
  const unknown = (await full("preview_resume_draft_rebase", { ...input, proposed: { modules: [{ ...old, content: { ...old.content, name: "mine" } }] } })).value;
  expect(unknown.prepared).toBeNull(); expect(unknown.blockers.join()).toContain("字段");
  expect(unknown.safeProposal).toBeNull(); expect(unknown.safeBlockers.length).toBeGreaterThan(0);
  expect(JSON.stringify(unknown.current)).toContain("futureMetadata");
  const spoof = await call("preview_resume_draft_rebase", { ...input, base: base.original });
  expect(spoof.result.isError).toBe(true);
});

it("preserves stable entry/subitem IDs through actual rebase and save and surfaces delete/edit", async () => {
  const work = { key: "work", type: "work", label: "工作", content: [{ id: "entry-a", company: "A", title: "base", start: "", end: "", description: "base", subItems: [{ id: "sub-a", label: "label", value: "base" }] }] };
  db.prepare("INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES(1,'work','work','工作',1,?,'')").run(JSON.stringify(work.content));
  const base = await resumeBase();
  const current = structuredClone(work.content); current[0]!.company = "Web company"; current[0]!.subItems[0]!.label = "Web label";
  db.prepare("UPDATE resume_modules SET content=? WHERE module_key='work'").run(JSON.stringify(current));
  const proposed = structuredClone(work); proposed.content[0]!.title = "Agent title"; proposed.content[0]!.subItems[0]!.value = "Agent value";
  const input = { mode: "rebase", resumeId: 1, baseToken: base.baseToken, proposed: { modules: [proposed] } };
  const result = (await full("preview_resume_draft_rebase", input)).value;
  expect(result.prepared).not.toBeNull(); const preview = await full(result.prepared.tool, result.prepared.arguments);
  await ok("save_resume_draft_edit", { ...result.prepared.arguments, previewToken: preview.previewToken, idempotencyKey: "stable-array-save" });
  const saved = JSON.parse(String(db.prepare("SELECT content FROM resume_modules WHERE module_key='work'").get()!.content));
  expect(saved).toMatchObject([{ id: "entry-a", company: "Web company", title: "Agent title", subItems: [{ id: "sub-a", label: "Web label", value: "Agent value" }] }]);
  db.prepare("UPDATE resume_modules SET content='[]' WHERE module_key='work'").run();
  const deleted = (await full("preview_resume_draft_rebase", input)).value;
  expect(deleted.conflicts[0]).toMatchObject({ reason: "delete-edit", path: ["modules", "@key:work", "content", "@id:entry-a"] });
});

it("refuses to silently remove unknown base fields or normalize away an intended description edit", async () => {
  const old = (await resumeBase()).original.modules[0];
  db.prepare("UPDATE resume_modules SET content=? WHERE module_key='basic'").run(JSON.stringify({ ...old.content, future: "metadata" }));
  const base = await resumeBase();
  const result = (await full("preview_resume_draft_rebase", { mode: "rebase", resumeId: 1, baseToken: base.baseToken,
    proposed: { modules: [{ ...old, content: { ...old.content, name: "mine" } }] } })).value;
  expect(result.prepared).toBeNull(); expect(result.blockers.join()).toContain("来源");
  const work = { key: "work", type: "work", label: "工作", content: [{ id: "a", company: "A", title: "T", start: "", end: "", description: "old", descriptionItems: ["old"] }] };
  db.prepare("INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES(1,'work','work','工作',1,?,'')").run(JSON.stringify(work.content));
  const wb = await resumeBase(); work.content[0]!.description = "mine";
  const r = (await full("preview_resume_draft_rebase", { mode: "rebase", resumeId: 1, baseToken: wb.baseToken, proposed: { modules: [work] } })).value;
  expect(r.prepared).toBeNull(); expect(r.blockers.join()).toContain("规范化");
});

it("invalidates base and committed replay after actual backup restore; newly captured base works", async () => {
  const base = await appBase();
  const r = (await full("preview_application_rebase", { mode: "rebase", applicationId: appId, baseToken: base.baseToken, proposed: { notes: "new" } })).value;
  const preview = await full(r.prepared.tool, r.prepared.arguments);
  const args = { ...r.prepared.arguments, previewToken: preview.previewToken, idempotencyKey: "restore-replay-test" };
  await ok("save_application_edit", args);
  const { createBackupRecordStream } = await import("@/lib/backup-records"), { stageBackupRecordStream } = await import("@/lib/backup-staging"), { restoreAllData } = await import("@/lib/backup");
  const staged = await stageBackupRecordStream(createBackupRecordStream(db), db);
  try { restoreAllData(staged, true); } finally { staged.dispose(); }
  await fail("save_application_edit", args, "CONFLICT");
  await fail("preview_application_rebase", { mode: "rebase", applicationId: appId, baseToken: base.baseToken, proposed: { notes: "old" } }, "CONFLICT");
  const fresh = await appBase(); expect(fresh.binding).not.toBe(base.binding);
});

it("can capture the same unchanged source after cache TTL expires without reviving the old token", async () => {
  const base = await appBase();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 169 * 3600000);
  await fail("preview_application_rebase", { mode: "rebase", applicationId: appId, baseToken: base.baseToken, proposed: { notes: "old" } }, "NOT_FOUND");
  const fresh = await appBase(); expect(fresh.baseToken).not.toBe(base.baseToken);
});

it("requires preview capability for application save and rejects a mismatched published resume binding", async () => {
  const base = await appBase();
  const r = (await full("preview_application_rebase", { mode: "rebase", applicationId: appId, baseToken: base.baseToken, proposed: { notes: "mine" } })).value;
  const preview = await full(r.prepared.tool, r.prepared.arguments);
  const denied = await connect(new Set(["get_application"]));
  await fail("save_application_edit", { ...r.prepared.arguments, previewToken: preview.previewToken, idempotencyKey: "denied-preview-save" }, "FORBIDDEN", denied);
  const bad = (await full("preview_application_rebase", { mode: "rebase", applicationId: appId, baseToken: base.baseToken, proposed: { resume_id: 1, resume_version_id: 999999 } })).value;
  expect(bad.prepared).toBeNull(); expect(bad.blockers.length).toBeGreaterThan(0);
  expect(bad.safeProposal).toBeNull();
  expect(db.prepare("SELECT count(*) n FROM mcp_creation_receipts WHERE tool='save_application_edit'").get()!.n).toBe(0);
});

it.each([{ resume_id: 1, resume_version_id: null }, { resume_version_id: null }])("rejects an implicit latest-version switch in application rebase: %j", async proposed => {
  const base = await appBase();
  const before = db.prepare("SELECT * FROM applications WHERE id=?").get(appId);
  const latest = (await import("@/lib/resume-versions")).publishResumeVersion(1, { name: "later publication" });
  expect(latest.id).not.toBe(base.original.resume.resume_version_id);
  await fail("preview_application_rebase", { mode: "rebase", applicationId: appId, baseToken: base.baseToken, proposed }, "INVALID_ARGUMENT");
  expect(db.prepare("SELECT * FROM applications WHERE id=?").get(appId)).toEqual(before);
});

it("preserves explicit application version selection and complete resume unbinding", async () => {
  const latest = (await import("@/lib/resume-versions")).publishResumeVersion(1, { name: "explicit publication" });
  for (const proposed of [{ resume_id: 1, resume_version_id: latest.id }, { resume_id: null }]) {
    const base = await appBase();
    const comparison = (await full("preview_application_rebase", { mode: "rebase", applicationId: appId, baseToken: base.baseToken, proposed })).value;
    expect(comparison.unresolved).toBe(0);
    const preview = await full(comparison.prepared.tool, comparison.prepared.arguments);
    const expected = { resume_id: proposed.resume_id, resume_version_id: proposed.resume_id === null ? null : latest.id };
    expect(preview.value.after.resume).toEqual(expected);
    await ok("save_application_edit", { ...comparison.prepared.arguments, previewToken: preview.previewToken, idempotencyKey: `explicit-resume-${proposed.resume_id}` });
    expect(db.prepare("SELECT resume_id,resume_version_id FROM applications WHERE id=?").get(appId)).toEqual(expected);
  }
});
