import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-file-read-"));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});

it("头像只从私有存储读取，拒绝其他路径与路径穿越", async () => {
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(root, "data"));
  vi.resetModules();
  const archive = path.join(root, "data", "legacy-uploads");
  fs.mkdirSync(archive, { recursive: true });
  fs.writeFileSync(path.join(archive, "historical.png"), "preserved-photo");
  const { readUploadFile, uploadPathFromUrl } = await import("../upload-storage");

  expect(readUploadFile("historical.png")).toBeNull();
  expect(uploadPathFromUrl("/uploads/historical.png")).toBeNull();
  expect(readUploadFile("../historical.png")).toBeNull();
  const versioned = "/api/uploads/historical.png?v=8f130bae-f339-493b-a69b-b41d9f471323";
  expect(uploadPathFromUrl(versioned)).toBe(path.join(root, "data", "uploads", "historical.png"));
  expect(uploadPathFromUrl("/api/uploads/nested/../historical.png")).toBeNull();
  expect(uploadPathFromUrl("/api/uploads/historical.png?redirect=other.png")).toBeNull();
  expect(uploadPathFromUrl("https://example.com/api/uploads/historical.png")).toBeNull();
});

it.each(["lstatSync", "readFileSync"] as const)("主存储 %s 发生 I/O 故障时保留原始错误", async (operation) => {
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(root, "data"));
  vi.resetModules();
  const { readUploadFile, UPLOADS_DIR } = await import("../upload-storage");
  const name = "avatar.png";
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, name), "current-photo");
  const archive = path.join(root, "data", "legacy-uploads");
  fs.mkdirSync(archive, { recursive: true });
  fs.writeFileSync(path.join(archive, name), "stale-photo");
  const original = fs[operation].bind(fs);
  const failure = Object.assign(new Error("synthetic I/O failure"), { code: "EACCES" });
  const spy = vi.spyOn(fs, operation).mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
    if (String(target) === path.join(UPLOADS_DIR, name)) throw failure;
    return (original as (...args: unknown[]) => unknown)(target, ...args);
  }) as never);
  try {
    expect(() => readUploadFile(name)).toThrow(failure);
  } finally {
    spy.mockRestore();
  }
});
