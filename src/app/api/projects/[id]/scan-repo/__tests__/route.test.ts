import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ scan: vi.fn(), relation: vi.fn(), detect: vi.fn() }));
vi.mock("@/lib/db", () => ({ requestDataGeneration: () => null }));
vi.mock("@/lib/projects", () => ({ loadProjectRow: () => ({ id: 1, name: "合成项目", summary: "{}" }) }));
vi.mock("@/lib/project-summary-history", async original => ({
  ...await original<typeof import("@/lib/project-summary-history")>(),
  captureProjectSummarySource: () => ({ project: { id: 1, name: "合成项目", summary: "{}" }, materials: [], revisionId: 0 }),
  prepareProjectSummaryProposal: () => ({ proposal: "合成草稿" }),
}));
vi.mock("@/lib/repo-scanner/cli-runner", () => ({
  runRepoScan: calls.scan,
  detectInstalledClis: calls.detect,
}));
vi.mock("@/lib/repo-scanner/relation-checker", () => ({ checkPathsRelation: calls.relation }));

import { GET, POST } from "../route";

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

describe("CLI 环境检测请求取消", () => {
  it("开始前取消不启动探测，也不记录 500", async () => {
    const controller = new AbortController();
    controller.abort(new Error("PRIVATE_DETECTION_ABORT"));
    const response = await GET(new Request("http://localhost/api/projects/1/scan-repo", { signal: controller.signal }), { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: "CLI 环境检测已取消" });
    expect(calls.detect).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("传递请求信号，中途取消返回 499 且不暴露取消原因", async () => {
    const controller = new AbortController();
    const req = new Request("http://localhost/api/projects/1/scan-repo", { signal: controller.signal });
    calls.detect.mockImplementation(async () => {
      controller.abort(new Error("PRIVATE_DETECTION_ABORT"));
      req.signal.throwIfAborted();
    });
    const response = await GET(req, { params: Promise.resolve({ id: "1" }) });
    expect(calls.detect).toHaveBeenCalledWith(req.signal);
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: "CLI 环境检测已取消" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("普通探测异常仍经过统一 500 脱敏", async () => {
    calls.detect.mockRejectedValue(new Error("PRIVATE_DETECTION_FAILURE"));
    const response = await GET(new Request("http://localhost/api/projects/1/scan-repo"), { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "服务器内部错误，请稍后重试" });
    expect(console.error).toHaveBeenCalled();
  });
});

async function expectRejected(body: unknown, query = "") {
  const response = await post(body, query);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.any(String) });
  expect(calls.scan).not.toHaveBeenCalled();
  expect(calls.relation).not.toHaveBeenCalled();
  expect(calls.detect).not.toHaveBeenCalled();
}

describe("扫描请求运行时结构校验", () => {
  it.each(["scan", "check-relation"])("%s 将自定义命令和参数传递到所选客户端", async action => {
    const customCli = { command: "node", args: ["D:/tools/SDK client.mjs", "--text"] };
    const response = await post({ repoPaths: [directory], action, preferredCli: "custom", customCli });
    expect(response.status).toBe(200);
    await response.text();
    if (action === "scan") expect(calls.scan).toHaveBeenCalledWith(expect.objectContaining({ preferredCli: "custom", customCli }));
    else expect(calls.relation).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ preferredCli: "custom", customCli }));
    expect(calls.detect).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, { command: "" }, { command: "node --eval dangerous" },
    { command: "node", args: "--text" }, { command: "node", args: [42] },
    { command: "D:/client.cmd", args: ["%PATH%"] },
    { command: "D:/client.cmd", args: ["--config-dir", "C:\\SDK config\\", "--text"] },
  ])("拒绝无效自定义配置 %j，预检与扫描都不开始", async customCli => {
    for (const action of ["scan", "check-relation"]) {
      await expectRejected({ repoPaths: [directory], preferredCli: "custom", customCli, action });
    }
  });

  it("内置客户端不能夹带自定义命令", async () => {
    await expectRejected({ repoPaths: [directory], preferredCli: "auto", customCli: { command: "node", args: [] } });
  });

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
