import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptySummary } from "../../src/lib/summary";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

test("源码扫描 HTTP 档案预算：原文和转义超限均在启动 CLI 前返回413，存档不变", async ({ request }) => {
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const prefix = "resume-life-e2e-scan-archive-";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(directory, "README.md"), "Synthetic source fixture.");
  try {
    const created = await request.post("/api/projects", { data: { name: "源码扫描档案预算" } });
    expect(created.status()).toBe(201);
    const root = `/api/projects/${(await created.json()).id}`;
    for (const responsibilities of ["文".repeat(40_001), "<".repeat(10_000)]) {
      const updated = await request.patch(root, { data: { summary: { ...emptySummary(), responsibilities } } });
      expect(updated.status()).toBe(200);
      const before = await (await request.get(root)).json();
      const history = await (await request.get(`${root}/summary-history`)).json();
      const rejected = await request.post(`${root}/scan-repo`, { data: { repoPath: directory, preferredCli: "codex" } });
      expect(rejected.status()).toBe(413);
      expect(rejected.headers()["content-type"]).toContain("application/json");
      expect(await rejected.json()).toEqual({ error: expect.stringContaining("未截断档案或启动 CLI") });
      expect(await (await request.get(root)).json()).toEqual(before);
      expect(await (await request.get(`${root}/summary-history`)).json()).toEqual(history);
    }
  } finally {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error("Unsafe cleanup path");
    fs.rmSync(resolved, { recursive: true, force: true });
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
