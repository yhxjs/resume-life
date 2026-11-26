import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Agent-owned local journal. Contains private inputs/results; never use an untrusted shared path. */
export function openWorkflowStore(filename) {
  if (!path.isAbsolute(filename)) throw new Error("工作流日志必须使用绝对路径");
  const parent = path.dirname(filename);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(parent).isSymbolicLink() || fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error("工作流日志不能使用符号链接");
  const db = new DatabaseSync(filename);
  if (process.platform !== "win32") fs.chmodSync(filename, 0o600);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
  db.exec(`CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document)), revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ownership(id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, expires INTEGER NOT NULL)`);
  let closed = false;
  const transaction = run => {
    if (closed) throw new Error("工作流日志已关闭");
    db.exec("BEGIN IMMEDIATE");
    try { const value = run(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
  return {
    acquire(id) {
      const token = randomUUID();
      transaction(() => {
        const row = db.prepare("SELECT * FROM ownership WHERE id=?").get(id);
        // A suspended live owner cannot be safely stolen: it might still submit a write.
        if (row && alive(row.pid)) throw Object.assign(new Error("此工作流正在其他进程执行"), { code: "BUSY" });
        db.prepare("INSERT OR REPLACE INTO ownership VALUES(?,?,?,?)").run(id, token, process.pid, Date.now() + 30_000);
      });
      const assertOwner = () => {
        if (!db.prepare("SELECT 1 FROM ownership WHERE id=? AND token=?").get(id, token)) throw new Error("工作流执行权已失效");
      };
      return {
        load() { assertOwner(); const row = db.prepare("SELECT document FROM workflows WHERE id=?").get(id); return row ? JSON.parse(row.document) : null; },
        save(value) {
          const text = JSON.stringify(value);
          if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("工作流检查点超过 32 MiB，请拆分流程");
          transaction(() => {
            assertOwner();
            db.prepare("INSERT INTO workflows VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET document=excluded.document,revision=revision+1").run(id, text);
            db.prepare("UPDATE ownership SET expires=? WHERE id=? AND token=?").run(Date.now() + 30_000, id, token);
          });
        },
        release() { if (!closed) transaction(() => db.prepare("DELETE FROM ownership WHERE id=? AND token=?").run(id, token)); },
      };
    },
    list() { return db.prepare("SELECT id,revision,json_extract(document,'$.status') AS status,json_extract(document,'$.updatedAt') AS updatedAt FROM workflows ORDER BY updatedAt DESC").all(); },
    close() { db.close(); closed = true; },
  };
}
