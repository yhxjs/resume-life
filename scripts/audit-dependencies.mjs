import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPicomatchSecurity } from "./check-picomatch-security.mjs";
import { sha256, PICOMATCH_VERSION, UPSTREAM_SHA256, PATCHED_SHA256 } from "./patch-picomatch.mjs";

const ADVISORY = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const EXPIRES_AT = "2026-12-18T00:00:00Z";
const REVIEWED_LOCK_SHA256 = "c7560ee1686ca187ffcd511285a6acfac4ec62932765dcf6e817d1f3c520f53f";
const REVIEWED_GRAPH_SHA256 = "2b6f4091938e0bc7fbce07cfe4d1e3b4a2e48d093911474e3e0b3a49ed4b370a";
const SEVERITIES = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
export const reviewedGraphSha256 = graph => sha256(JSON.stringify(canonical(graph)));

function projection(name, node, lock) {
  if (node.name !== name || !Array.isArray(node.nodes) || !Array.isArray(node.via) || !Object.hasOwn(SEVERITIES, node.severity)) {
    throw new Error(`Malformed audit node: ${name}`);
  }
  return {
    name, severity: node.severity,
    locations: node.nodes.map(location => ({ path: location, version: lock.packages[location]?.version, dev: lock.packages[location]?.dev === true })),
    via: node.via.map(via => typeof via === "string" ? via : {
      url: via.url, name: via.name, dependency: via.dependency, range: via.range, severity: via.severity,
    }),
  };
}

function policyErrors(policy, context) {
  const errors = [];
  if (policy.schemaVersion !== 1 || policy.status !== "approved" || policy.advisory !== ADVISORY) errors.push("Unapproved or unreviewed policy");
  if (policy.expiresAt !== EXPIRES_AT || !Number.isFinite(context.now) || context.now >= Date.parse(EXPIRES_AT)) errors.push("Policy expired or expiry changed");
  if (policy.lockfileSha256 !== REVIEWED_LOCK_SHA256 || policy.lockfileSha256 !== context.lockfileSha256) errors.push("Lockfile hash changed");
  if (policy.package?.name !== "picomatch" || policy.package.version !== PICOMATCH_VERSION ||
      policy.package.upstreamParserSha256 !== UPSTREAM_SHA256 || policy.package.patchedParserSha256 !== PATCHED_SHA256) errors.push("Unreviewed patch identity");
  if (context.securityVerified !== true) errors.push("Installed copies and bounded behavior were not verified");
  if (policy.scope !== "development dependencies only" || !Array.isArray(policy.reviewedGraph) || policy.reviewedGraph.length !== 14) errors.push("Unreviewed policy scope");
  if (reviewedGraphSha256(policy.reviewedGraph) !== REVIEWED_GRAPH_SHA256) errors.push("Reviewed dependency graph changed");
  return errors;
}

/**
 * Evaluate raw npm data without mutating or erasing the original report.
 * @param {*} report
 * @param {*} lock
 * @param {*} policy
 * @param {{lockfileSha256: string, securityVerified: boolean, now: number, production?: boolean}} context
 */
export function evaluateAuditReport(report, lock, policy, context) {
  const graph = report?.vulnerabilities;
  if (report?.auditReportVersion !== 2 || graph === null || typeof graph !== "object" || Array.isArray(graph) || report.error) {
    throw new Error("Invalid npm audit report");
  }
  const projected = new Map(Object.entries(graph).map(([name, node]) => [name, projection(name, node, lock)]));
  const threshold = context.production ? "moderate" : "high";
  const errors = context.production ? [] : policyErrors(policy, context);
  const reviewed = new Map((policy.reviewedGraph ?? []).map(node => [node.name, node]));
  const eligible = new Set();
  if (!context.production && errors.length === 0) {
    // Freeze locations, versions and edges, including the observed Vitest cycle.
    // Unknown edges cannot inherit an exception by merely naming picomatch.
    for (const [name, node] of projected) {
      if (!reviewed.has(name) || !equal(node, reviewed.get(name))) errors.push(`Unreviewed audit node or edges: ${name}`);
    }
    for (const name of projected.keys()) {
      const visited = new Set();
      const roots = new Set();
      let valid = true;
      const visit = current => {
        if (visited.has(current)) return;
        visited.add(current);
        const node = projected.get(current);
        if (!node || !equal(node, reviewed.get(current))) { valid = false; return; }
        for (const via of node.via) {
          if (typeof via === "string") visit(via);
          else roots.add(via.url);
        }
      };
      visit(name);
      if (valid && roots.size === 1 && roots.has(ADVISORY)) eligible.add(name);
      else errors.push(`Audit node does not reach the sole reviewed advisory: ${name}`);
    }
  }
  if (errors.length) eligible.clear();
  const blocking = [...projected.values()].filter(node => !eligible.has(node.name) && SEVERITIES[node.severity] >= SEVERITIES[threshold]);
  return {
    threshold, reportedNodeCount: projected.size, mitigatedNodeCount: eligible.size,
    mitigatedNodes: [...eligible].sort(), blockingNodes: blocking.map(node => node.name), policyErrors: [...new Set(errors)],
    passed: blocking.length === 0 && errors.length === 0,
  };
}

function npmCliPath() {
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")];
  const found = candidates.find(file => file && path.basename(file) === "npm-cli.js" && fs.existsSync(file));
  if (!found) throw new Error("Cannot locate npm-cli.js; run npm run audit:dependencies");
  return found;
}

function collectAudit(root, outputDirectory, production) {
  return new Promise((resolve, reject) => {
    // Run npm's JS entrypoint through Node. No .cmd shell or user text in argv.
    const args = [npmCliPath(), "audit", "--json", "--registry=https://registry.npmjs.org"];
    if (production) args.push("--omit=dev");
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let size = 0;
    let exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill(); }, 120000);
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) { exceeded = true; child.kill(); }
      else stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => { if (stderr.length < 32768) stderr += chunk.toString(); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      const label = production ? "production" : "all";
      fs.writeFileSync(path.join(outputDirectory, `npm-audit-${label}.json`), stdout);
      fs.writeFileSync(path.join(outputDirectory, `npm-audit-${label}.stderr.log`), stderr);
      try {
        if (exceeded || (code !== 0 && code !== 1)) throw new Error(`npm audit ${label} failed (${code})`);
        const parsed = JSON.parse(stdout);
        if (parsed.error) throw new Error(`npm audit registry error: ${parsed.error.code ?? "unknown"}`);
        resolve(parsed);
      } catch (error) { reject(error); }
    });
  });
}

export async function auditDependencies(root, outputDirectory) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const policy = readJson(path.join(root, ".github/dependency-audit-policy.json"));
  const lockFile = path.join(root, "package-lock.json");
  const lock = readJson(lockFile);
  const [production, all] = await Promise.all([collectAudit(root, outputDirectory, true), collectAudit(root, outputDirectory, false)]);
  // Raw reports have already been retained even if integrity verification fails.
  const security = await checkPicomatchSecurity(root);
  const context = { lockfileSha256: sha256(fs.readFileSync(lockFile)), securityVerified: true, now: Date.now() };
  const result = {
    checkedAt: new Date(context.now).toISOString(), advisory: ADVISORY, expiresAt: policy.expiresAt,
    production: evaluateAuditReport(production, lock, policy, { ...context, production: true }),
    all: evaluateAuditReport(all, lock, policy, context),
  };
  const relativeSecurity = { ...security, copies: security.copies.map(copy => ({
    ...copy, packageFile: path.relative(root, copy.packageFile).replaceAll("\\", "/"),
    parseFile: path.relative(root, copy.parseFile).replaceAll("\\", "/"),
  })) };
  fs.writeFileSync(path.join(outputDirectory, "picomatch-security.json"), JSON.stringify(relativeSecurity, null, 2) + "\n");
  fs.writeFileSync(path.join(outputDirectory, "assessment.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--output-dir")) throw new Error("Usage: audit-dependencies.mjs [--output-dir directory]");
    const root = process.cwd();
    const result = await auditDependencies(root, path.resolve(root, args[1] ?? ".test-artifacts/dependency-audit"));
    console.log(JSON.stringify(result, null, 2));
    if (!result.production.passed || !result.all.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
