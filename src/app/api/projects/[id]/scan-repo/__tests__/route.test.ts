import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ scan: vi.fn(), relation: vi.fn(), detect: vi.fn() }));
vi.mock("@/lib/db", () => ({ requestDataGeneration: () => null }));
vi.mock("@/lib/projects", () => ({ loadProjectRow: () => ({ id: 1, name: "合成项目" }) }));
vi.mock("@/lib/project-summary-history", () => ({
  captureProjectMaterialSnapshot: () => [],
  projectSummaryRevision: () => null,
  prepareProjectSummaryProposal: () => ({ proposal: "合成草稿" }),
}));
vi.mock("@/lib/repo-scanner/cli-runner", () => ({
  runRepoScan: calls.scan,
  detectInstalledClis: calls.detect,
}));
vi.mock("@/lib/repo-scanner/relation-checker", () => ({ checkPathsRelation: calls.relation }));

import { POST } from "../route";

let directory: string;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-scan-request-"));
  fs.writeFileSync(path.join(directory, "README.md"), "合成代码库");
  calls.scan.mockResolvedValue({ summary: {}, cliUsed: "codex", logs: [] });
  calls.relation.mockResolvedValue({ isRelated: true, reason: "合成研判" });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-scan-request-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

function post(body: unknown, query = "") {
  return POST(new Request(`http://localhost/api/projects/1/scan-repo${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "1" }) });
}

async function expectRejected(body: unknown, query = "") {
  const response = await post(body, query);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.any(String) });
  expect(calls.scan).not.toHaveBeenCalled();
  expect(calls.relation).not.toHaveBeenCalled();
  expect(calls.detect).not.toHaveBeenCalled();
}

describe("扫描请求运行时结构校验", () => {
  it.each([null, [], 42, "synthetic", false])("根 JSON %j 返回 400 且不启动 CLI", async (body) => {
    await expectRejected(body);
  });

  it.each([23, {}, null, ["synthetic"]])("repoPath=%j 返回 400", async (repoPath) => {
    await expectRejected({ repoPath });
  });

  it.each([{}, "synthetic", null, [{}]])("repoPaths=%j 返回 400", async (repoPaths) => {
    await expectRejected({ repoPaths });
  });

  it("路径数组包含对象时不能静默忽略后继续扫描", async () => {
    await expectRejected({ repoPaths: [directory, {}] });
  });

  it.each(["scan", "check-relation"])("%s 拒绝超过 32 个原始路径且不发起外部工作", async (action) => {
    await expectRejected({ repoPaths: Array(33).fill(directory), action });
  });

  it("关联预检保留未知状态和降级来源", async () => {
    calls.relation.mockResolvedValue({ isRelated: null, method: "heuristic", reason: "无法确认关联" });
    const response = await post({ repoPaths: [directory], action: "check-relation" });
    expect(await response.json()).toMatchObject({ isRelated: null, method: "heuristic", reason: "无法确认关联" });
    expect(calls.scan).not.toHaveBeenCalled();
  });

  it.each(["invalid", null, 42, {}])("preferredCli=%j 返回 400", async (preferredCli) => {
    await expectRejected({ repoPath: directory, preferredCli });
  });

  it.each(["invalid", null, 42, {}])("body action=%j 返回 400", async (action) => {
    await expectRejected({ repoPath: directory, action });
  });

  it("query action 枚举无效时返回 400", async () => {
    await expectRejected({ repoPath: directory }, "?action=invalid");
  });

  it.each(["auto", "codex", "claude"])("有效 CLI %s 保持 SSE 扫描行为", async (preferredCli) => {
    const response = await post({ repoPath: directory, preferredCli, action: "scan" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("event: done");
    expect(calls.scan).toHaveBeenCalledWith(expect.objectContaining({ preferredCli, repoPaths: [directory] }));
  });

  it.each(["body", "query"])("%s 中的 check-relation 保持关联研判行为", async (location) => {
    const response = await post({ repoPaths: [directory], ...(location === "body" ? { action: "check-relation" } : {}) },
      location === "query" ? "?action=check-relation" : "");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isRelated: true });
    expect(calls.relation).toHaveBeenCalledOnce();
    expect(calls.scan).not.toHaveBeenCalled();
  });
});
