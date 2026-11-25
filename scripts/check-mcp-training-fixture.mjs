import { Console } from "node:console";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// No product import/publish tools: seed only the synthetic inputs for the integration example.
const temporary = path.resolve(process.argv[2] ?? "");
if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !/^resume-life-(?:codex-check|mcp-example)-/.test(path.basename(temporary)) ||
    path.resolve(process.env.RESUME_LIFE_DATA_DIR ?? "") !== path.join(temporary, "data")) throw new Error("Unsafe training fixture target");
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
const options = { tsconfig: path.join(root, "tsconfig.json") };
(await import("tsx/esm/api")).register(options);
(await import("tsx/cjs/api")).register(options);
const { getDb, inTransaction, now } = await import(new URL("../src/lib/db.ts", import.meta.url).href);
const { publishResumeVersion } = await import(new URL("../src/lib/resume-versions.ts", import.meta.url).href);
const db = getDb();
try {
  const direction = "MCP 训练示例";
  const fixture = inTransaction(() => {
    const at = now();
    db.prepare("INSERT INTO bank_entries (direction,kind,question,created_at) VALUES (?,'tech','如何复核事务？',?)").run(direction, at);
    db.prepare("INSERT INTO notebook_categories (name,created_at) VALUES ('训练示例分类',?)").run(at);
    const resumeId = Number(db.prepare("INSERT INTO resumes (title,created_at,updated_at) VALUES ('训练示例简历',?,?)").run(at, at).lastInsertRowid);
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,sort,content,updated_at) VALUES (?,'skills','skills','技能',0,?,?)").run(resumeId, JSON.stringify({ items: ["维护本地数据库"] }), at);
    const versionId = publishResumeVersion(resumeId, { name: "训练快照" }).id;
    const introId = Number(db.prepare("INSERT INTO intros (resume_id,resume_version_id,created_at) VALUES (?,?,?)").run(resumeId, versionId, at).lastInsertRowid);
    for (const kind of ["30s", "2min"]) db.prepare("INSERT INTO intro_versions (intro_id,kind,sentences,updated_at) VALUES (?,?,?,?)").run(introId, kind, JSON.stringify([{ text: "我参与项目维护。", comment: "" }]), at);
    return { direction, resumeId, versionId, introId };
  });
  process.stdout.write(JSON.stringify(fixture));
} finally { db.close(); }
