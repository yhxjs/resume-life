import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { dataGeneration, getDb, inTransaction, now } from "@/lib/db";
import { deleteResume, loadResume, revisionOf } from "@/lib/resumes";
import {
  type ModuleKey,
  defaultContent,
  genModuleKey,
  isModuleKey,
  isValidModuleContentInput,
  normalizeContent,
} from "@/lib/modules";
import { isTemplateRef, sanitizeStyleOverrides } from "@/lib/templates";
import { avatarUrlFromContent, removeUnreferencedUploadsByUrls } from "@/lib/upload-storage";
import { loadCustomTemplate } from "@/lib/custom-templates";

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  }
  const data = loadResume(numericId);
  if (!data) return NextResponse.json({ error: "简历不存在" }, { status: 404 });
  return NextResponse.json(data);
}

async function handlePatch(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as unknown;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "请求体无效" }, { status: 400 });
  }
  const o = body as Record<string, unknown>;
  const db = getDb();
  const exists = db.prepare("SELECT id FROM resumes WHERE id = ?").get(numericId);
  if (!exists) return NextResponse.json({ error: "简历不存在" }, { status: 404 });

  const rows = db
    .prepare("SELECT module_key, type, label FROM resume_modules WHERE resume_id = ?")
    .all(numericId) as { module_key: string; type: string; label: string }[];
  const typeByKey = new Map(rows.map((r) => [r.module_key, r.type]));
  const keySet = new Set(rows.map((r) => r.module_key));

  const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
  const modules = o.modules;
  if (modules !== undefined && (modules === null || typeof modules !== "object" || Array.isArray(modules))) {
    return bad("modules 参数无效");
  }
  const revisions = o.moduleRevisions;
  const revisionMap = revisions && typeof revisions === "object" && !Array.isArray(revisions)
    ? revisions as Record<string, unknown> : {};
  const updates: { key: string; type: ModuleKey; content: string; revision: string }[] = [];
  const titleRevision = o.titleRevision;
  if (typeof o.title === "string" && o.title.trim() &&
    (typeof titleRevision !== "string" || !/^[0-9a-f]{64}$/.test(titleRevision))) {
    return NextResponse.json({ error: "简历标题缺少有效保存版本，本页草稿已保留；请在新标签页打开最新简历并手动合并" }, { status: 409 });
  }
  for (const [key, raw] of Object.entries(modules ?? {})) {
    const type = typeByKey.get(key);
    if (!type || !isModuleKey(type)) {
      return NextResponse.json({ error: "简历模块已变更，本页草稿已保留；请在新标签页打开最新简历并手动合并" }, { status: 409 });
    }
    if (!isValidModuleContentInput(type, raw)) return bad(`模块「${key}」内容结构无效`);
    const revision = revisionMap[key];
    if (typeof revision !== "string" || !/^[0-9a-f]{64}$/.test(revision)) {
      return NextResponse.json({ error: "简历草稿缺少有效保存版本，本页草稿已保留；请在新标签页打开最新简历并手动合并" }, { status: 409 });
    }
    updates.push({ key, type, content: JSON.stringify(normalizeContent(type, raw)), revision });
  }

  // 更新前记下旧头像指针：提交后据此删除被替换掉的文件（见文件末尾的清理）。
  const avatarsBefore = collectAvatarUrls(numericId);

  // —— 参数校验在事务前完成，便于直接返回友好错误 ——

  let addLabel = "";
  let addType: ModuleKey | null = null;
  if (o.addModule !== undefined) {
    const a = o.addModule && typeof o.addModule === "object" ? (o.addModule as Record<string, unknown>) : null;
    if (!a) return bad("addModule 参数无效");
    addLabel = typeof a.label === "string" ? a.label.trim() : "";
    if (!addLabel) return bad("模块名称不能为空");
    if (addLabel.length > 50) return bad("模块名称不能超过 50 字");
    if (!isModuleKey(a.type)) return bad("模块结构无效");
    addType = a.type;
    if (rows.some((r) => r.label.trim() === addLabel)) {
      return bad(`模块名称「${addLabel}」已存在`);
    }
  }

  let renameKey = "";
  let renameLabel = "";
  if (o.renameModule !== undefined) {
    const r = o.renameModule && typeof o.renameModule === "object" ? (o.renameModule as Record<string, unknown>) : null;
    if (!r) return bad("renameModule 参数无效");
    renameKey = typeof r.key === "string" ? r.key : "";
    renameLabel = typeof r.label === "string" ? r.label.trim() : "";
    if (!keySet.has(renameKey)) return bad("模块不存在");
    if (!renameLabel) return bad("模块名称不能为空");
    if (renameLabel.length > 50) return bad("模块名称不能超过 50 字");
    if (
      rows.some((x) => x.module_key !== renameKey && x.label.trim() === renameLabel)
    ) {
      return bad(`模块名称「${renameLabel}」已存在`);
    }
  }

  let removeKey = "";
  if (o.removeModule !== undefined) {
    if (typeof o.removeModule !== "string" || !keySet.has(o.removeModule)) {
      return bad("模块不存在");
    }
    removeKey = o.removeModule;
  }

  const orderKeys: string[] = [];
  if (o.moduleOrder !== undefined) {
    if (!Array.isArray(o.moduleOrder)) return bad("moduleOrder 参数无效");
    for (const key of o.moduleOrder) {
      if (typeof key === "string" && keySet.has(key)) orderKeys.push(key);
    }
  }

  if (o.template !== undefined && isTemplateRef(o.template) && o.template.startsWith("custom:")) {
    const tplId = Number(o.template.slice("custom:".length));
    const tplExists = db.prepare("SELECT id FROM resume_templates WHERE id = ?").get(tplId);
    if (!tplExists) return bad("引用的自定义模板不存在，可能已被删除");
    loadCustomTemplate(tplId);
  }

  const ts = now();
  let addedKey: string | undefined;
  let conflict = false;
  inTransaction(() => {
    const generation = dataGeneration(db);
    const changesStructure = ["addModule", "renameModule", "removeModule", "moduleOrder", "template", "styleOverrides"]
      .some((key) => o[key] !== undefined);
    if ((changesStructure || Object.hasOwn(o, "dataGeneration")) && o.dataGeneration !== generation) {
      conflict = true;
      return;
    }
    if (o.styleOverrides !== undefined) {
      const current = db.prepare("SELECT style_overrides FROM resumes WHERE id = ?").get(numericId) as { style_overrides: string } | undefined;
      if (!current || revisionOf(current.style_overrides, numericId, "style", generation) !== o.styleRevision) {
        conflict = true;
        return;
      }
    }
    if (typeof o.title === "string" && o.title.trim()) {
      const current = db.prepare("SELECT title FROM resumes WHERE id = ?").get(numericId) as { title: string } | undefined;
      if (!current || revisionOf(current.title, numericId, "title", generation) !== titleRevision) {
        conflict = true;
        return;
      }
    }
    if (updates.length) {
      const currentRows = db
        .prepare("SELECT module_key, content FROM resume_modules WHERE resume_id = ?")
        .all(numericId) as Array<{ module_key: string; content: string }>;
      const currentContentMap = new Map(currentRows.map((r) => [r.module_key, r.content]));

      for (const update of updates) {
        const currentContent = currentContentMap.get(update.key);
        if (currentContent === undefined || revisionOf(currentContent, numericId, `module:${update.key}`, generation) !== update.revision) {
          conflict = true;
          return;
        }
      }
    }
    let touched = false;

    if (typeof o.title === "string" && o.title.trim()) {
      db.prepare("UPDATE resumes SET title = ?, updated_at = ? WHERE id = ?").run(o.title.trim(), ts, numericId);
      touched = true;
    }

    if (isTemplateRef(o.template)) {
      db.prepare("UPDATE resumes SET template = ?, updated_at = ? WHERE id = ?").run(o.template, ts, numericId);
      touched = true;
    }

    if (o.styleOverrides !== undefined) {
      const sanitized = o.styleOverrides === null ? {} : sanitizeStyleOverrides(o.styleOverrides);
      db.prepare("UPDATE resumes SET style_overrides = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify(sanitized),
        ts,
        numericId
      );
      touched = true;
    }

    if (updates.length) {
      const update = db.prepare(
        "UPDATE resume_modules SET content = ?, updated_at = ? WHERE resume_id = ? AND module_key = ?"
      );
      for (const entry of updates) {
        update.run(entry.content, ts, numericId, entry.key);
        touched = true;
      }
    }

    if (addType) {
      const max = db
        .prepare("SELECT COALESCE(MAX(sort), -1) AS s FROM resume_modules WHERE resume_id = ?")
        .get(numericId) as { s: number };
      addedKey = genModuleKey();
      db.prepare(
        `INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(numericId, addedKey, addType, addLabel, max.s + 1, JSON.stringify(defaultContent(addType)), ts);
      touched = true;
    }

    if (renameKey) {
      db.prepare("UPDATE resume_modules SET label = ?, updated_at = ? WHERE resume_id = ? AND module_key = ?").run(
        renameLabel,
        ts,
        numericId,
        renameKey
      );
      touched = true;
    }

    if (removeKey) {
      db.prepare("DELETE FROM resume_modules WHERE resume_id = ? AND module_key = ?").run(numericId, removeKey);
      touched = true;
    }

    if (orderKeys.length) {
      const setSort = db.prepare("UPDATE resume_modules SET sort = ? WHERE resume_id = ? AND module_key = ?");
      orderKeys.forEach((key, index) => setSort.run(index, numericId, key));
      touched = true;
    }

    if (touched) {
      db.prepare("UPDATE resumes SET updated_at = ? WHERE id = ?").run(ts, numericId);
    }
    return touched;
  });

  if (conflict) return NextResponse.json({ error: "简历已在其他页面修改，本页草稿已保留；请在新标签页打开最新简历并手动合并" }, { status: 409 });

  // 提交后再删文件：写新删旧的顺序反过来的话，删文件成功但事务回滚，用户就丢了头像。
  // 只删「更新前存在、更新后不再被本简历引用」的那些，因此不依赖本次请求具体改了什么字段。
  const avatarsAfter = collectAvatarUrls(numericId);
  removeUnreferencedUploadsByUrls([...avatarsBefore].filter((url) => !avatarsAfter.has(url)));

  const data = loadResume(numericId);
  return NextResponse.json({ ...data, addedKey });
}

/** 本简历当前引用的全部头像指针 */
function collectAvatarUrls(resumeId: number): Set<string> {
  const db = getDb();
  const rows = db
    .prepare("SELECT content FROM resume_modules WHERE resume_id = ? AND type = 'basic'")
    .all(resumeId) as { content: string }[];
  const urls = new Set<string>();
  for (const row of rows) {
    const avatar = avatarUrlFromContent(row.content);
    if (avatar) urls.add(avatar);
  }
  return urls;
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  }
  if (!deleteResume(numericId)) return NextResponse.json({ error: "简历不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const GET = withRouteErrorHandling("GET /api/resumes/[id]", handleGet);
export const PATCH = withRouteErrorHandling("PATCH /api/resumes/[id]", handlePatch);
export const DELETE = withRouteErrorHandling("DELETE /api/resumes/[id]", handleDelete);
