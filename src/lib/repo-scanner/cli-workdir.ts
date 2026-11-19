import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentRequestId, logServerError } from "../server-errors";

/** 仅清理本次 CLI 创建的临时目录；清理故障不覆盖已得到的结果或原始错误。 */
export async function cleanupCliWorkdir(workdir: string, kind: "scan" | "relation"): Promise<void> {
  const target = path.resolve(workdir);
  const prefix = kind === "scan" ? "resume-life-cli-" : "resume-life-relation-";
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith(prefix)) {
    throw new Error("CLI 临时目录边界无效");
  }
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    logServerError("cli.workdir.cleanup", error, { requestId: currentRequestId(), context: { resource: kind } });
  }
}
