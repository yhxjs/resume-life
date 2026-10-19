import { getDb, inTransaction, now } from "./db";
import { loadResume, type ResumeWithModules } from "./resumes";
import type { ResumeSnapshot, ResumeVersion, ResumeVersionListItem } from "./resume-version-types";
import { resolveStyle, type ResumeStyleOverrides } from "./templates";
import { CorruptedTemplateError, readCustomTemplate } from "./custom-templates";
import { assertBackupRecordBytes, BackupLimitError } from "./backup-limits";

export class ResumeVersionError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "ResumeVersionError";
  }
}

type VersionRow = Omit<ResumeVersion, "snapshot"> & { snapshot: string };
const decode = (row: VersionRow): ResumeVersion => ({ ...row, snapshot: JSON.parse(row.snapshot) as ResumeSnapshot });

function storedStyle(template: string, overrides: ResumeStyleOverrides) {
  const customId = /^custom:(\d+)$/.exec(template)?.[1];
  const row = customId ? getDb().prepare("SELECT * FROM resume_templates WHERE id = ?").get(Number(customId)) as {
    id: number; name: string; style: string; created_at: string; updated_at: string;
  } | undefined : undefined;
  const custom = row ? readCustomTemplate(row) : null;
  if (custom?.corrupted) throw new CorruptedTemplateError(custom.id);
  return resolveStyle(template, custom ? [custom] : [], overrides);
}

function draft(resumeId: number, expectedRevision?: string): ResumeWithModules {
  const data = loadResume(resumeId);
  if (!data) throw new ResumeVersionError("简历不存在", 404);
  if (expectedRevision !== undefined && expectedRevision !== data.resume.draftRevision) {
    throw new ResumeVersionError("简历已在其他页面修改，请刷新后重新操作", 409);
  }
  return data;
}

export function listResumeVersions(resumeId: number) {
  return inTransaction(() => {
    const data = draft(resumeId);
    // 列表刻意不携带 snapshot（单份快照最大可到 2MiB，几十个版本后列表响应会膨胀到数 MB）：
    // 版本树只需要元数据，预览/对比所需快照由 GET /api/resumes/[id]/versions/[versionId] 按需获取。
    const rows = getDb().prepare(
      "SELECT id, resume_id, version, parent_id, name, description, created_at FROM resume_versions WHERE resume_id = ? ORDER BY version DESC"
    ).all(resumeId) as ResumeVersionListItem[];
    return { versions: rows, base_version_id: data.resume.base_version_id ?? null, draft_revision: data.resume.draftRevision! };
  });
}

export function getResumeVersion(resumeId: number, versionId: number): ResumeVersion | null {
  const row = getDb().prepare("SELECT * FROM resume_versions WHERE id = ? AND resume_id = ?").get(versionId, resumeId) as VersionRow | undefined;
  return row ? decode(row) : null;
}

/** 创建时绑定指定或最新发布版本。 */
export function resolveResumeVersionId(resumeId: number, value?: unknown): number {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM resumes WHERE id = ?").get(resumeId)) throw new ResumeVersionError("简历不存在", 404);
  if (value === undefined || value === null) {
    const latest = db.prepare("SELECT id FROM resume_versions WHERE resume_id = ? ORDER BY version DESC LIMIT 1").get(resumeId) as { id: number } | undefined;
    if (!latest) throw new ResumeVersionError("请先发布一个简历版本");
    return latest.id;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new ResumeVersionError("简历版本 ID 无效");
  if (!db.prepare("SELECT 1 FROM resume_versions WHERE id = ? AND resume_id = ?").get(value, resumeId)) {
    throw new ResumeVersionError("所选版本不存在或不属于这份简历");
  }
  return value;
}

export function publishResumeVersion(resumeId: number, input: { name: string; description?: string; draft_revision?: string }): ResumeVersion {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!name || name.length > 80) throw new ResumeVersionError("版本名称须为 1–80 字");
  if (description.length > 2000) throw new ResumeVersionError("版本说明不能超过 2000 字");
  return inTransaction(() => {
    const data = draft(resumeId, input.draft_revision);
    if (data.resume.styleCorrupted) throw new ResumeVersionError("简历排版数据损坏，请修复并保存排版后发布", 422);
    if (data.corruptedKeys.length) throw new ResumeVersionError("简历包含损坏模块，请修复后发布", 409);
    const snapshot: ResumeSnapshot = {
      title: data.resume.title,
      template: data.resume.template,
      style_overrides: data.resume.style_overrides,
      resolved_style: storedStyle(data.resume.template, data.resume.style_overrides),
      modules: data.modules.map(({ key, type, label, sort, content }) => ({ key, type, label, sort, content })),
    };
    const db = getDb();
    const { version } = db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM resume_versions WHERE resume_id = ?").get(resumeId) as { version: number };
    const timestamp = now();
    const result = db.prepare("INSERT INTO resume_versions (resume_id, version, parent_id, name, description, created_at, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(resumeId, version, data.resume.base_version_id ?? null, name, description, timestamp, JSON.stringify(snapshot));
    const id = Number(result.lastInsertRowid);
    const row = db.prepare("SELECT * FROM resume_versions WHERE id = ?").get(id);
    try { assertBackupRecordBytes(Buffer.byteLength(`${JSON.stringify({ kind: "row", table: "resume_versions", data: row })}\n`, "utf8")); }
    catch (error) {
      if (error instanceof BackupLimitError) throw new ResumeVersionError("简历版本内容过大，请精简后再发布", 413);
      throw error;
    }
    db.prepare("UPDATE resumes SET base_version_id = ?, updated_at = ? WHERE id = ?").run(id, timestamp, resumeId);
    return { id, resume_id: resumeId, version, parent_id: data.resume.base_version_id ?? null, name, description, created_at: timestamp, snapshot };
  });
}

export function branchResumeVersion(resumeId: number, versionId: number, draftRevision?: string): ResumeWithModules {
  return inTransaction(() => {
    draft(resumeId, draftRevision);
    const version = getResumeVersion(resumeId, versionId);
    if (!version) throw new ResumeVersionError("所选版本不存在或不属于这份简历", 404);
    const db = getDb();
    const timestamp = now();
    const snapshot = version.snapshot;
    let template = snapshot.template;
    let matchesSnapshotStyle = true;
    try {
      matchesSnapshotStyle = JSON.stringify(storedStyle(template, snapshot.style_overrides)) === JSON.stringify(snapshot.resolved_style);
    } catch (error) {
      if (!(error instanceof CorruptedTemplateError)) throw error;
      // 当前模板已损坏时仍可用历史快照恢复，不能复用坏引用。
      matchesSnapshotStyle = false;
    }
    if (!matchesSnapshotStyle) {
      const custom = db.prepare("INSERT INTO resume_templates (name, style, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(`分支 · ${version.name}`, JSON.stringify(snapshot.resolved_style), timestamp, timestamp);
      template = `custom:${Number(custom.lastInsertRowid)}`;
    }
    db.prepare("UPDATE resumes SET title = ?, template = ?, style_overrides = ?, base_version_id = ?, updated_at = ? WHERE id = ?")
      .run(snapshot.title, template, JSON.stringify(snapshot.style_overrides), versionId, timestamp, resumeId);
    db.prepare("DELETE FROM resume_modules WHERE resume_id = ?").run(resumeId);
    const insert = db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const item of snapshot.modules) {
      insert.run(resumeId, item.key, item.type, item.label, item.sort, JSON.stringify(item.content), timestamp);
    }
    return loadResume(resumeId)!;
  });
}
