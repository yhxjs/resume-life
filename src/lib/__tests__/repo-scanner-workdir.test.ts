import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import io from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupCliWorkdir } from "../repo-scanner/cli-workdir";
import { withRequestIdScope } from "../server-errors";

const fixtures: string[] = [];
function directory(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(root);
  return root;
}
beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of fixtures.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !/^resume-life-(?:cli|relation|keep)-/.test(path.basename(root))) throw new Error("Unsafe cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("CLI 临时目录回收边界", () => {
  it.each(["scan", "relation"] as const)("%s 只删除指定临时目录，保留相邻目录", async kind => {
    const target = directory(kind === "scan" ? "resume-life-cli-" : "resume-life-relation-");
    const sibling = directory("resume-life-keep-");
    fs.writeFileSync(path.join(target, "temporary.txt"), "SYNTHETIC_TEMP_CONTENT");
    fs.writeFileSync(path.join(sibling, "keep.txt"), "SYNTHETIC_KEEP_CONTENT");
    await cleanupCliWorkdir(target, kind);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(path.join(sibling, "keep.txt"), "utf8")).toBe("SYNTHETIC_KEEP_CONTENT");
  });

  it("拒绝临时根、错误前缀、嵌套路径及不同用途的目录，拒绝前零删除", async () => {
    const unrelated = directory("resume-life-keep-");
    const relation = directory("resume-life-relation-");
    const rm = vi.spyOn(io, "rm");
    for (const target of [os.tmpdir(), unrelated, relation, path.join(unrelated, "resume-life-cli-nested"), path.join(unrelated, "..")]) {
      await expect(cleanupCliWorkdir(target, "scan")).rejects.toThrow("CLI 临时目录边界无效");
    }
    expect(rm).not.toHaveBeenCalled();
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(relation)).toBe(true);
  });

  it("最终清理失败使用所属请求 ID 记录脱敏诊断，不把本地路径或正文写入日志", async () => {
    const target = directory("resume-life-cli-");
    vi.spyOn(io, "rm").mockRejectedValue(Object.assign(new Error(`SYNTHETIC_PRIVATE_BODY ${target}`), { code: "EPERM" }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await withRequestIdScope(new Request("http://localhost", { headers: { "x-request-id": "cleanup-correlation" } }), () => cleanupCliWorkdir(target, "scan"));
    expect(errors).toHaveBeenCalledOnce();
    const log = JSON.parse(String(errors.mock.calls[0]![0]).replace("[server-error] ", ""));
    expect(log).toMatchObject({ operation: "cli.workdir.cleanup", requestId: "cleanup-correlation", errorCode: "EPERM", context: { resource: "scan" } });
    expect(JSON.stringify(log)).not.toContain(target);
    expect(JSON.stringify(log)).not.toContain("SYNTHETIC_PRIVATE_BODY");
  });
});
