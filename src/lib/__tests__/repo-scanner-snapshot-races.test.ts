import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectRepoSourceSnapshot } from "../repo-scanner/source-snapshot";
import { snapshotFiles } from "./helpers/repo-snapshot";

let fixture: string;
beforeEach(() => { fixture = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-snapshot-race-")); });
afterEach(() => {
  vi.restoreAllMocks();
  if (path.dirname(fixture) !== os.tmpdir() || !path.basename(fixture).startsWith("resume-life-snapshot-race-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(fixture, { recursive: true, force: true });
});

function createSource() {
  const root = path.join(fixture, "repo");
  const source = path.join(root, "src");
  const outside = path.join(fixture, "outside");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "README.md"), "SYNTHETIC_SAFE_README");
  fs.writeFileSync(path.join(source, "index.ts"), "export const safeAnswer = 42;");
  fs.writeFileSync(path.join(outside, "index.ts"), "SYNTHETIC_OUTSIDE_FILE_MUST_NOT_LEAVE_HOST");
  return { root, source, outside, filename: path.join(source, "index.ts") };
}

function isTargetPath(candidate: unknown, targetRealPath: string): boolean {
  if (typeof candidate !== "string") return false;
  try {
    const candidateRealPath = fs.realpathSync.native(candidate);
    return process.platform === "win32"
      ? candidateRealPath.toLowerCase() === targetRealPath.toLowerCase()
      : candidateRealPath === targetRealPath;
  } catch {
    return false;
  }
}

describe("源码快照读取期间文件身份变化", () => {
  it.each(["父目录变为外部链接", "同名普通文件替换"])("路径检查后%s，不读取替换文件并关闭句柄", async replacement => {
    const { root, source, outside, filename } = createSource();
    const targetRealPath = fs.realpathSync.native(filename);
    const open = fsPromises.open.bind(fsPromises);
    const handles: Awaited<ReturnType<typeof fsPromises.open>>[] = [];
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      if (!isTargetPath(args[0], targetRealPath)) return open(...args);
      if (replacement === "父目录变为外部链接") {
        fs.renameSync(source, path.join(root, "original-src"));
        fs.symlinkSync(outside, source, process.platform === "win32" ? "junction" : "dir");
      } else {
        fs.renameSync(filename, path.join(source, "original-index.log"));
        fs.writeFileSync(filename, "SYNTHETIC_OUTSIDE_FILE_MUST_NOT_LEAVE_HOST");
      }
      const handle = await open(...args);
      vi.spyOn(handle, "read");
      vi.spyOn(handle, "close");
      handles.push(handle);
      return handle;
    });
    const snapshot = await collectRepoSourceSnapshot([{ path: root }]);
    expect(snapshot).toContain("SYNTHETIC_SAFE_README");
    expect(snapshot).not.toContain("SYNTHETIC_OUTSIDE_FILE_MUST_NOT_LEAVE_HOST");
    expect(snapshotFiles(snapshot).map(file => file.path)).not.toContain("src/index.ts");
    expect(handles).toHaveLength(1);
    expect(handles[0]!.read).not.toHaveBeenCalled();
    expect(handles[0]!.close).toHaveBeenCalledOnce();
  });

  it("未变化的普通源码仍被读取，成功后关闭句柄", async () => {
    const { root, filename } = createSource();
    const targetRealPath = fs.realpathSync.native(filename);
    const open = fsPromises.open.bind(fsPromises);
    const handles: Awaited<ReturnType<typeof fsPromises.open>>[] = [];
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (isTargetPath(args[0], targetRealPath)) {
        vi.spyOn(handle, "read");
        vi.spyOn(handle, "close");
        handles.push(handle);
      }
      return handle;
    });
    const snapshot = await collectRepoSourceSnapshot([{ path: root }]);
    expect(snapshot).toContain("export const safeAnswer = 42;");
    expect(snapshotFiles(snapshot).map(file => file.path)).toContain("src/index.ts");
    expect(snapshot).not.toContain("SYNTHETIC_OUTSIDE_FILE_MUST_NOT_LEAVE_HOST");
    expect(handles).toHaveLength(1);
    expect(handles[0]!.read).toHaveBeenCalledOnce();
    expect(handles[0]!.close).toHaveBeenCalledOnce();
  });
});
