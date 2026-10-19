import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupStaleRestoreDirectories, RESTORE_DIRECTORY_PREFIX } from "../backup-staging-storage";

const directories: string[] = [];

function restoreDirectory(pid: number | null, ageMs: number): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), RESTORE_DIRECTORY_PREFIX));
  directories.push(directory);
  if (pid !== null) {
    fs.writeFileSync(path.join(directory, ".owner"), JSON.stringify({ pid, createdAt: Date.now() - ageMs }));
  }
  fs.writeFileSync(path.join(directory, "staging.db"), "synthetic private data");
  const modifiedAt = new Date(Date.now() - ageMs);
  fs.utimesSync(directory, modifiedAt, modifiedAt);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith(RESTORE_DIRECTORY_PREFIX)) {
      throw new Error("Unsafe test cleanup path");
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("只清扫过期且所属进程已退出的明文暂存目录", () => {
  const oldDead = restoreDirectory(999_999_999, 48 * 60 * 60 * 1000);
  const oldLive = restoreDirectory(process.pid, 48 * 60 * 60 * 1000);
  const recentDead = restoreDirectory(999_999_999, 60 * 60 * 1000);
  const unknownOwner = restoreDirectory(null, 48 * 60 * 60 * 1000);

  cleanupStaleRestoreDirectories();

  expect(fs.existsSync(oldDead)).toBe(false);
  expect(fs.existsSync(oldLive)).toBe(true);
  expect(fs.existsSync(recentDead)).toBe(true);
  expect(fs.existsSync(unknownOwner)).toBe(true);
});
