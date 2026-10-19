import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptySummary } from "../summary";

let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-summary-history-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'项目','','')");
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-summary-history-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("project summary history", () => {
  it.each(["T", "中", '"'])("rejects oversized material snapshots atomically (%s)", async (character) => {
    const history = await import("../project-summary-history");
    const insert = db.prepare("INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,?,'正文','')");
    for (let i = 0; i < 5; i++) insert.run(character.repeat(450_000));
    const summary = { ...emptySummary(), overview: "不能保存" };
    const fingerprint = history.prepareProjectSummaryProposal(1, summary).materialFingerprint;
    const before = db.prepare("SELECT * FROM projects WHERE id = 1").get();
    expect(() => history.saveProjectSummary(1, {
      summary,
      proposal: { generated: summary, acceptedKeys: ["overview"], source: "repo", materialFingerprint: fingerprint },
    })).toThrow(expect.objectContaining({ name: "ProjectSummaryHistoryError", status: 413 }));
    expect(db.prepare("SELECT * FROM projects WHERE id = 1").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
  });

  it("counts JSON escaping and the AI baseline in the final backup record budget", async () => {
    const history = await import("../project-summary-history");
    const summary = { ...emptySummary(), overview: '"'.repeat(300_000) };
    const fingerprint = history.prepareProjectSummaryProposal(1, summary).materialFingerprint;
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(2 * 1024 * 1024);
    expect(() => history.saveProjectSummary(1, {
      summary,
      proposal: { generated: summary, acceptedKeys: ["overview"], source: "ai", materialFingerprint: fingerprint },
    })).toThrow(expect.objectContaining({ status: 413 }));
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_summary_history").get()).toEqual({ count: 0 });
  });

  it("can back up and restore a large history record within the encoded budget", async () => {
    const history = await import("../project-summary-history");
    db.prepare("INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,?,'正文','')").run('"'.repeat(200_000));
    const summary = { ...emptySummary(), overview: "可备份" };
    const fingerprint = history.prepareProjectSummaryProposal(1, summary).materialFingerprint;
    const saved = history.saveProjectSummary(1, {
      summary,
      proposal: { generated: summary, acceptedKeys: ["overview"], source: "repo", materialFingerprint: fingerprint },
    });
    const { createBackupRecordStream } = await import("../backup-records");
    const { stageBackupRecordStream } = await import("../backup-staging");
    const staged = await stageBackupRecordStream(createBackupRecordStream(db), db);
    try {
      (await import("../backup")).restoreAllData(staged, false);
    } finally {
      staged.dispose();
    }
    expect(history.listProjectSummaryHistory(1, null, 10).items[0]).toMatchObject({ id: saved.id, summary });
  });

  it("saves versions, keeps AI baselines through manual edits, and rejects stale revisions", async () => {
    const history = await import("../project-summary-history");
    const ai = { ...emptySummary(), overview: "AI 原稿", architecture: "旧架构" };
    const firstFingerprint = history.prepareProjectSummaryProposal(1, ai).materialFingerprint;
    const first = history.saveProjectSummary(1, { summary: ai, expectedRevisionId: 0, proposal: { generated: ai, acceptedKeys: ["overview", "architecture"], source: "ai", materialFingerprint: firstFingerprint } });
    const edited = { ...ai, overview: "用户校正原稿" };
    const second = history.saveProjectSummary(1, { summary: edited, expectedRevisionId: first.id });
    expect(second.aiBaseline).toMatchObject({ overview: "AI 原稿", architecture: "旧架构" });

    const proposal = history.prepareProjectSummaryProposal(1, { ...ai, overview: "AI 新稿", architecture: "新架构" });
    expect(proposal.comparison.map(({ key, status }) => [key, status])).toEqual([["overview", "conflict"], ["architecture", "changed"]]);
    const adopted = history.saveProjectSummary(1, {
      summary: { ...edited, architecture: "新架构" },
      expectedRevisionId: second.id,
      proposal: { generated: { ...ai, overview: "AI 新稿", architecture: "新架构" }, acceptedKeys: ["architecture"], source: "ai", materialFingerprint: proposal.materialFingerprint },
    });
    expect(adopted.summary).toMatchObject({ overview: "用户校正原稿", architecture: "新架构" });
    expect(adopted.aiBaseline).toMatchObject({ overview: "AI 原稿", architecture: "新架构" });
    expect(() => history.saveProjectSummary(1, { summary: ai, expectedRevisionId: second.id })).toThrow(/已更新/);
    expect(history.listProjectSummaryHistory(1, null, 2).items.map((item) => item.id)).toEqual([adopted.id, second.id]);
    expect(history.listProjectSummaryHistory(1, second.id, 2).items.map((item) => item.id)).toEqual([first.id]);
  });

  it("records material additions, edits and removals against the last saved snapshot", async () => {
    const history = await import("../project-summary-history");
    db.exec("INSERT INTO project_materials (id,project_id,title,content,created_at) VALUES (1,1,'架构','旧内容',''),(2,1,'复盘','旧复盘','')");
    const initial = { ...emptySummary(), overview: "初稿" };
    const fingerprint = history.prepareProjectSummaryProposal(1, initial).materialFingerprint;
    history.saveProjectSummary(1, { summary: initial, expectedRevisionId: 0, proposal: { generated: initial, acceptedKeys: ["overview"], source: "ai", materialFingerprint: fingerprint } });
    db.exec("UPDATE project_materials SET content='新内容' WHERE id=1; DELETE FROM project_materials WHERE id=2; INSERT INTO project_materials (id,project_id,title,content,created_at) VALUES (3,1,'新增','新材料','')");
    const proposal = history.prepareProjectSummaryProposal(1, { ...emptySummary(), overview: "新稿" });
    expect(proposal.materialChanges.map(({ title, status }) => [title, status])).toEqual([["架构", "changed"], ["复盘", "removed"], ["新增", "new"]]);
  });

  it("does not mark new material as summarized by a later manual text edit", async () => {
    const history = await import("../project-summary-history");
    db.exec("INSERT INTO project_materials (id,project_id,title,content,created_at) VALUES (1,1,'原材料','旧内容','')");
    const generated = { ...emptySummary(), overview: "AI 原稿" };
    const fingerprint = history.prepareProjectSummaryProposal(1, generated).materialFingerprint;
    history.saveProjectSummary(1, { summary: generated, proposal: { generated, acceptedKeys: ["overview"], source: "ai", materialFingerprint: fingerprint } });
    db.exec("INSERT INTO project_materials (id,project_id,title,content,created_at) VALUES (2,1,'新材料','新内容','')");
    history.saveProjectSummary(1, { summary: { ...generated, overview: "用户校正" } });
    expect(history.prepareProjectSummaryProposal(1, generated).materialChanges).toMatchObject([{ title: "新材料", status: "new" }]);
  });

  it("keeps material changes pending when a proposal is saved without adopting its content", async () => {
    const history = await import("../project-summary-history");
    db.exec("INSERT INTO project_materials (id,project_id,title,content,created_at) VALUES (1,1,'原材料','旧内容','')");
    const original = { ...emptySummary(), overview: "原总结" };
    const firstFingerprint = history.prepareProjectSummaryProposal(1, original).materialFingerprint;
    history.saveProjectSummary(1, {
      summary: original,
      proposal: { generated: original, acceptedKeys: ["overview"], source: "ai", materialFingerprint: firstFingerprint },
    });
    db.exec("INSERT INTO project_materials (id,project_id,title,content,created_at) VALUES (2,1,'新材料','新内容','')");
    const generated = { ...original, overview: "AI 新总结" };
    const proposal = history.prepareProjectSummaryProposal(1, generated);
    history.saveProjectSummary(1, {
      summary: { ...original, brief: "人工补充" },
      expectedRevisionId: proposal.revisionId,
      proposal: { generated, acceptedKeys: [], source: "ai", materialFingerprint: proposal.materialFingerprint },
    });
    expect(history.prepareProjectSummaryProposal(1, generated).materialChanges).toMatchObject([{ title: "新材料", status: "new" }]);
  });

  it("keeps the remaining achievement's AI baseline after a manual deletion", async () => {
    const history = await import("../project-summary-history");
    const original = { ...emptySummary(), achievements: ["AI 成果一", "AI 成果二"] };
    const fingerprint = history.prepareProjectSummaryProposal(1, original).materialFingerprint;
    const first = history.saveProjectSummary(1, {
      summary: original,
      proposal: { generated: original, acceptedKeys: ["achievement:0", "achievement:1"], source: "ai", materialFingerprint: fingerprint },
    });
    const edited = history.saveProjectSummary(1, {
      summary: { ...original, achievements: ["AI 成果二"] },
      expectedRevisionId: first.id,
    });
    expect(edited.aiBaseline).toEqual({ "achievement:0": "AI 成果二" });
    const proposal = history.prepareProjectSummaryProposal(1, { ...original, achievements: ["AI 新成果二"] });
    expect(proposal.comparison.map(({ key, status }) => [key, status])).toEqual([["achievement:0", "changed"]]);
    history.saveProjectSummary(1, {
      summary: { ...original, achievements: ["我校正的成果二"] },
      expectedRevisionId: edited.id,
    });
    const conflict = history.prepareProjectSummaryProposal(1, { ...original, achievements: ["AI 新成果二"] });
    expect(conflict.comparison.map(({ key, status }) => [key, status])).toEqual([["achievement:0", "conflict"]]);
  });

  it("recognizes generated achievement text retained while a manual item is appended", async () => {
    const history = await import("../project-summary-history");
    const old = { ...emptySummary(), achievements: ["旧成果一", "旧成果二"] };
    const firstFingerprint = history.prepareProjectSummaryProposal(1, old).materialFingerprint;
    history.saveProjectSummary(1, {
      summary: old,
      proposal: { generated: old, acceptedKeys: ["achievement:0", "achievement:1"], source: "ai", materialFingerprint: firstFingerprint },
    });
    const generated = { ...old, achievements: ["新成果一", "新成果二"] };
    const proposal = history.prepareProjectSummaryProposal(1, generated);
    const saved = history.saveProjectSummary(1, {
      summary: { ...old, achievements: ["新成果一", "新成果二", "手动成果三"] },
      expectedRevisionId: proposal.revisionId,
      proposal: { generated, acceptedKeys: [], source: "ai", materialFingerprint: proposal.materialFingerprint },
    });
    expect(saved.aiBaseline).toMatchObject({ "achievement:0": "新成果一", "achievement:1": "新成果二" });
    expect(saved.aiBaseline).not.toHaveProperty("achievement:2");
    const next = history.prepareProjectSummaryProposal(1, { ...old, achievements: ["再改成果一", "新成果二", "手动成果三"] });
    expect(next.comparison.map(({ key, status }) => [key, status])).toEqual([["achievement:0", "changed"]]);
  });

  it("records the original AI text when the first generated draft is edited before saving", async () => {
    const history = await import("../project-summary-history");
    const generated = { ...emptySummary(), overview: "AI 原稿" };
    const fingerprint = history.prepareProjectSummaryProposal(1, generated).materialFingerprint;
    const saved = history.saveProjectSummary(1, {
      summary: { ...generated, overview: "用户首次校正" },
      proposal: { generated, acceptedKeys: [], source: "ai", materialFingerprint: fingerprint },
    });
    expect(saved.aiBaseline.overview).toBe("AI 原稿");
    const proposal = history.prepareProjectSummaryProposal(1, { ...generated, overview: "AI 新稿" });
    expect(proposal.comparison.map(({ key, status }) => [key, status])).toEqual([["overview", "conflict"]]);
  });

  it("restores summary history from a backup and can append another revision", async () => {
    const history = await import("../project-summary-history");
    const backup = await import("./backup-fixture");
    const first = history.saveProjectSummary(1, { summary: { ...emptySummary(), overview: "恢复前版本" } });
    expect(backup.validateBackupPayload(backup.exportAllData()).valid).toBe(true);

    const { createBackupRecordStream } = await import("../backup-records");
    const { stageBackupRecordStream } = await import("../backup-staging");
    const chunks: Uint8Array[] = [];
    for await (const chunk of createBackupRecordStream(db)) chunks.push(chunk);
    async function* source() { for (const chunk of chunks) yield chunk; }
    const staged = await stageBackupRecordStream(source(), db);
    try {
      db.prepare("DELETE FROM project_summary_history").run();
      backup.restoreAllData(staged, false);
    } finally {
      staged.dispose();
    }
    expect(history.listProjectSummaryHistory(1, null, 10).items[0]).toMatchObject({ id: first.id, summary: { overview: "恢复前版本" } });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const next = history.saveProjectSummary(1, { summary: { ...emptySummary(), overview: "恢复后版本" }, expectedRevisionId: first.id });
    expect(next.id).toBeGreaterThan(first.id);
  });
});
