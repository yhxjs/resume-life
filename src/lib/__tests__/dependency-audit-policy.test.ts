import fs from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateAuditReport } from "../../../scripts/audit-dependencies.mjs";

const policy = JSON.parse(fs.readFileSync(".github/dependency-audit-policy.json", "utf8"));
const lockBytes = fs.readFileSync("package-lock.json");
const lock = JSON.parse(lockBytes.toString("utf8"));
const context = { now: Date.parse("2026-11-18T05:00:00Z"), lockfileSha256: createHash("sha256").update(lockBytes).digest("hex"), securityVerified: true };
const clone = <T,>(value: T): T => structuredClone(value);
function rawReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(policy.reviewedGraph.map((node: {
      name: string; severity: string; locations: { path: string }[]; via: unknown[];
    }) => [node.name, { name: node.name, severity: node.severity, nodes: node.locations.map(location => location.path), via: clone(node.via) }])),
  };
}

describe("限时精确依赖审计政策", () => {
  it("保留 14 个原始报告节点，只有已审查图与已验证补丁可以通过", () => {
    const raw = rawReport();
    const original = clone(raw);
    expect(evaluateAuditReport(raw, lock, policy, context)).toMatchObject({
      passed: true, threshold: "high", reportedNodeCount: 14, mitigatedNodeCount: 14, blockingNodes: [], policyErrors: [],
    });
    expect(raw).toEqual(original);
  });

  it("生产 moderate 门槛不适用开发补丁例外", () => {
    expect(evaluateAuditReport(rawReport(), lock, policy, { ...context, production: true })).toMatchObject({
      passed: false, threshold: "moderate", mitigatedNodeCount: 0,
    });
    expect(evaluateAuditReport({ auditReportVersion: 2, vulnerabilities: {} }, lock, policy, { ...context, production: true }).passed).toBe(true);
  });

  it.each([
    { now: Date.parse("2026-12-18T00:00:00Z") },
    { now: NaN },
    { lockfileSha256: "unexpected-lockfile" },
    { securityVerified: false },
  ])("缺少必要条件时阻断：%j", change => {
    expect(evaluateAuditReport(rawReport(), lock, policy, { ...context, ...change }).passed).toBe(false);
  });

  it.each([
    { status: "pending" }, { expiresAt: "2030-01-01T00:00:00Z" },
    { advisory: "https://github.com/advisories/another-advisory" },
    { package: { ...policy.package, patchedParserSha256: "unexpected-hash" } },
    { package: { ...policy.package, version: "4.0.8" } },
  ])("政策身份、期限或补丁漂移时阻断：%j", change => {
    expect(evaluateAuditReport(rawReport(), lock, { ...policy, ...change }, context).passed).toBe(false);
  });

  it("同一个 picomatch 包出现另一条公告仍阻断", () => {
    const raw = rawReport();
    raw.vulnerabilities.picomatch.via.push({ url: "https://github.com/advisories/GHSA-new", name: "picomatch", dependency: "picomatch", range: "*", severity: "high" });
    const result = evaluateAuditReport(raw, lock, policy, context);
    expect(result.passed).toBe(false);
    expect(result.blockingNodes).toContain("picomatch");
    expect(result.mitigatedNodeCount).toBe(0);
  });

  it("另一个包的新漏洞不能继承该例外", () => {
    const raw = rawReport();
    raw.vulnerabilities.unreviewed = { name: "unreviewed", severity: "high", nodes: ["node_modules/unreviewed"], via: [{ url: "https://github.com/advisories/GHSA-new", name: "unreviewed", dependency: "unreviewed", severity: "high", range: "*" }] };
    const result = evaluateAuditReport(raw, lock, policy, context);
    expect(result.passed).toBe(false);
    expect(result.blockingNodes).toContain("unreviewed");
  });

  it("未知副本或版本漂移时不认定覆盖", () => {
    const raw = rawReport();
    raw.vulnerabilities.picomatch.nodes.push("node_modules/unknown/node_modules/picomatch");
    expect(evaluateAuditReport(raw, lock, policy, context).passed).toBe(false);
    const changedLock = clone(lock);
    changedLock.packages["node_modules/picomatch"].version = "4.0.8";
    expect(evaluateAuditReport(rawReport(), changedLock, policy, context).passed).toBe(false);
  });

  it("非开发依赖节点不适用开发补丁范围", () => {
    const changedLock = clone(lock);
    changedLock.packages["node_modules/picomatch"].dev = false;
    expect(evaluateAuditReport(rawReport(), changedLock, policy, context).passed).toBe(false);
  });

  it("保留已审查的 Vitest 传播环，拒绝新增环和断边", () => {
    const raw = rawReport();
    raw.vulnerabilities.vite.via = ["vitest"];
    expect(evaluateAuditReport(raw, lock, policy, context).passed).toBe(false);
    raw.vulnerabilities.vite.via = ["missing-parent"];
    expect(evaluateAuditReport(raw, lock, policy, context).passed).toBe(false);
  });

  it("没有真实公告根的传播图不能通过", () => {
    const raw = rawReport();
    raw.vulnerabilities.picomatch.via = ["vitest"];
    expect(evaluateAuditReport(raw, lock, policy, context).passed).toBe(false);
  });

  it("直接改写政策中的依赖边也不能扩展已批准范围", () => {
    const changedPolicy = clone(policy);
    changedPolicy.reviewedGraph.find((node: { name: string }) => node.name === "vite").via = ["vitest"];
    const raw = rawReport();
    raw.vulnerabilities.vite.via = ["vitest"];
    expect(evaluateAuditReport(raw, lock, changedPolicy, context).passed).toBe(false);
  });

  it("未知注册表错误和损坏报告不能表示零漏洞", () => {
    expect(() => evaluateAuditReport({ error: { code: "E404" } }, lock, policy, context)).toThrow(/Invalid/);
    for (const production of [true, false]) {
      for (const vulnerabilities of [undefined, null, [], true, false, 0, 1, "invalid"]) {
        expect(() => evaluateAuditReport({ auditReportVersion: 2, vulnerabilities }, lock, policy, { ...context, production })).toThrow(/Invalid/);
      }
    }
  });
});
