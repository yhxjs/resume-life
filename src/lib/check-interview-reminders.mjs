// 离线只读维护入口：SQL 随 applications 域留在 lib，不自动纠正用户的提醒时间。
import "../../scripts/check-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const configuredDirectory = process.env.RESUME_LIFE_DATA_DIR;
if (configuredDirectory && !path.isAbsolute(configuredDirectory)) {
  throw new Error("RESUME_LIFE_DATA_DIR 必须是绝对路径");
}
const databasePath = path.join(configuredDirectory || path.join(process.cwd(), "data"), "resume-life.db");
if (!fs.existsSync(databasePath)) {
  console.log("指定目录中数据库不存在，未创建或修改任何文件。");
} else {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const statement = database.prepare(`
      SELECT id, application_id, typeof(reminder_minutes) AS storage_type
      FROM application_interviews
      WHERE typeof(reminder_minutes) != 'integer'
         OR reminder_minutes < 0 OR reminder_minutes > 9007199254740991
      ORDER BY id
    `);
    statement.setReadBigInts(true);
    const rows = statement.all();
    console.log(`检测到 ${rows.length} 条异常提醒；本次检查未修改数据库。`);
    for (const row of rows) {
      console.log(`轮次 ID ${row.id}，投递 ID ${row.application_id}，存储类型 ${row.storage_type}`);
    }
    if (rows.length > 0) process.exitCode = 1;
  } finally {
    database.close();
  }
}
