import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectPicomatchCopies, locatePicomatchCopies, patchPicomatch,
  PATCH_GUARD, PATCH_HELPER, PATCHED_SHA256, UPSTREAM_SHA256, sha256,
} from "../../../scripts/patch-picomatch.mjs";
import { runPicomatchCases } from "../../../scripts/check-picomatch-security.mjs";

const temporaryDirectories: string[] = [];
const installed = locatePicomatchCopies(process.cwd())[0]!;
const current = fs.readFileSync(installed.parseFile, "utf8");
const upstream = current.replace(PATCH_HELPER, "").replace(PATCH_GUARD, "");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-picomatch-"));
  temporaryDirectories.push(root);
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"patch-test","private":true}');
  const packageDir = path.join(root, "node_modules/picomatch");
  fs.cpSync(path.dirname(installed.packageFile), packageDir, { recursive: true });
  const parseFile = path.join(packageDir, "lib/parse.js");
  fs.writeFileSync(parseFile, upstream);
  const lock = { lockfileVersion: 3, packages: { "node_modules/picomatch": { version: "4.0.7", dev: true } } };
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
  return { root, packageDir, parseFile, lock };
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) {
    const resolved = fs.realpathSync(root);
    expect(path.dirname(resolved).toLowerCase()).toBe(fs.realpathSync(os.tmpdir()).toLowerCase());
    expect(path.basename(resolved)).toMatch(/^resume-life-picomatch-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe("picomatch 安装期补丁", () => {
  it("上游源文件与审查哈希一致；未打补丁时发布检查拒绝通过", () => {
    expect(sha256(upstream)).toBe(UPSTREAM_SHA256);
    const { root } = fixture();
    expect(() => inspectPicomatchCopies(root)).toThrow(/Unpatched/);
  });

  it("原始危险匹配会超时；同一副本修补后安全结束", async () => {
    const { root, packageDir } = fixture();
    const packageFile = path.join(packageDir, "package.json");
    const cases = [{ pattern: "+(*a)", input: "a".repeat(32) + "b", expected: false }];
    await expect(runPicomatchCases(packageFile, cases)).rejects.toThrow(/1500 ms deadline/);
    patchPicomatch(root);
    await expect(runPicomatchCases(packageFile, cases)).resolves.toHaveLength(1);
  });

  it("修补幂等且保留上游名称、版本、许可证", () => {
    const { root, packageDir, parseFile } = fixture();
    const metadataBefore = fs.readFileSync(path.join(packageDir, "package.json"));
    const licenseBefore = fs.readFileSync(path.join(packageDir, "LICENSE"));
    const first = patchPicomatch(root);
    const firstMtime = fs.statSync(parseFile).mtimeMs;
    expect(first[0]?.sha256).toBe(PATCHED_SHA256);
    expect(patchPicomatch(root)).toEqual(first);
    expect(fs.statSync(parseFile).mtimeMs).toBe(firstMtime);
    expect(fs.readFileSync(path.join(packageDir, "package.json"))).toEqual(metadataBefore);
    expect(fs.readFileSync(path.join(packageDir, "LICENSE"))).toEqual(licenseBefore);
  });

  it.each(["4.0.8", "2.3.2"])("拒绝未审查的实际版本 %s", version => {
    const { root, packageDir, parseFile } = fixture();
    const packageFile = path.join(packageDir, "package.json");
    const metadata = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    fs.writeFileSync(packageFile, JSON.stringify({ ...metadata, version }));
    expect(() => patchPicomatch(root)).toThrow(/Unreviewed/);
    expect(sha256(fs.readFileSync(parseFile))).toBe(UPSTREAM_SHA256);
  });

  it("拒绝锁文件版本与实际版本不一致", () => {
    const { root, lock } = fixture();
    lock.packages["node_modules/picomatch"].version = "4.0.8";
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
    expect(() => patchPicomatch(root)).toThrow(/lockfile version/);
  });

  it("拒绝原始与已修补源文件的内容漂移", () => {
    const { root, parseFile } = fixture();
    fs.appendFileSync(parseFile, "\n// unexpected change\n");
    expect(() => patchPicomatch(root)).toThrow(/source hash/);
    fs.writeFileSync(parseFile, current);
    fs.appendFileSync(parseFile, "\n// unexpected change\n");
    expect(() => inspectPicomatchCopies(root)).toThrow(/changed/);
  });

  it("覆盖嵌套副本和消费者实际解析的副本", () => {
    const { root, packageDir, lock } = fixture();
    const consumer = path.join(root, "node_modules/consumer");
    fs.mkdirSync(consumer, { recursive: true });
    fs.writeFileSync(path.join(consumer, "package.json"), '{"name":"consumer","dependencies":{"picomatch":"4.0.7"}}');
    fs.cpSync(packageDir, path.join(consumer, "node_modules/picomatch"), { recursive: true });
    const packages = lock.packages as Record<string, { version: string; dependencies?: Record<string, string>; dev?: boolean }>;
    packages["node_modules/consumer"] = { version: "1.0.0", dependencies: { picomatch: "4.0.7" } };
    packages["node_modules/consumer/node_modules/picomatch"] = { version: "4.0.7" };
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
    expect(patchPicomatch(root)).toHaveLength(2);
    expect(inspectPicomatchCopies(root).flatMap(copy => copy.consumers)).toContain("resolve:node_modules/consumer");
  });

  it("发现未审查的嵌套副本时不先修改其他副本", () => {
    const { root, packageDir, parseFile, lock } = fixture();
    const nested = path.join(root, "node_modules/consumer/node_modules/picomatch");
    fs.cpSync(packageDir, nested, { recursive: true });
    fs.appendFileSync(path.join(nested, "lib/parse.js"), "\n// drift\n");
    const packages = lock.packages as Record<string, { version: string; dev?: boolean }>;
    packages["node_modules/consumer/node_modules/picomatch"] = { version: "4.0.7" };
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
    expect(() => patchPicomatch(root)).toThrow(/source hash/);
    expect(sha256(fs.readFileSync(parseFile))).toBe(UPSTREAM_SHA256);
  });

  it("消费者解析到锁文件未列出的旧副本时失败", () => {
    const { root, packageDir, parseFile, lock } = fixture();
    const consumer = path.join(root, "node_modules/consumer");
    fs.mkdirSync(consumer, { recursive: true });
    fs.writeFileSync(path.join(consumer, "package.json"), '{"name":"consumer"}');
    const nested = path.join(consumer, "node_modules/picomatch");
    fs.cpSync(packageDir, nested, { recursive: true });
    const packageFile = path.join(nested, "package.json");
    const metadata = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    fs.writeFileSync(packageFile, JSON.stringify({ ...metadata, version: "2.3.2" }));
    const packages = lock.packages as Record<string, { version: string; dependencies?: Record<string, string>; dev?: boolean }>;
    packages["node_modules/consumer"] = { version: "1.0.0", dependencies: { picomatch: "4.0.7" } };
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
    expect(() => patchPicomatch(root)).toThrow(/Unreviewed/);
    expect(sha256(fs.readFileSync(parseFile))).toBe(UPSTREAM_SHA256);
  });

  it("仅生产安装可省略锁定的开发副本及未链接的本地开发依赖", () => {
    const { root, packageDir, lock } = fixture();
    fs.renameSync(packageDir, path.join(root, "unused-fixture-copy"));
    const consumer = { dev: true, dependencies: { picomatch: "4.0.7" } };
    Object.assign(lock.packages, {
      "node_modules/dev-consumer": consumer,
      "node_modules/local-consumer": { link: true, resolved: "vendor/local" },
      "vendor/local": consumer,
    });
    fs.mkdirSync(path.join(root, "vendor/local"), { recursive: true });
    fs.writeFileSync(path.join(root, "vendor/local/package.json"), JSON.stringify(consumer));
    const lockFile = path.join(root, "package-lock.json");
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    expect(patchPicomatch(root, { omitDev: true })).toEqual([]);
    expect(() => patchPicomatch(root)).toThrow();
    lock.packages["node_modules/picomatch"].dev = false;
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    expect(() => patchPicomatch(root, { omitDev: true })).toThrow();
  });

  it("仅生产安装仍修补实际存在的开发副本", () => {
    const { root, parseFile } = fixture();
    expect(patchPicomatch(root, { omitDev: true })).toHaveLength(1);
    expect(sha256(fs.readFileSync(parseFile))).toBe(PATCHED_SHA256);
  });

  it("缺失必需消费者时失败", () => {
    const { root, lock } = fixture();
    const packages = lock.packages as Record<string, { version: string; dependencies?: Record<string, string>; dev?: boolean }>;
    packages["node_modules/missing-consumer"] = { version: "1.0.0", dependencies: { picomatch: "4.0.7" } };
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
    expect(() => patchPicomatch(root)).toThrow(/Missing picomatch consumer/);
    expect(() => patchPicomatch(root, { omitDev: true })).toThrow(/Missing picomatch consumer/);
  });

  it("锁文件列出缺失副本时失败", () => {
    const { root, lock } = fixture();
    const packages = lock.packages as Record<string, { version: string; dev?: boolean }>;
    packages["node_modules/missing/node_modules/picomatch"] = { version: "4.0.7" };
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
    expect(() => patchPicomatch(root)).toThrow();
  });

  it("拒绝锁文件中的目录逃逸", () => {
    const { root, lock } = fixture();
    const packages = lock.packages as Record<string, { version: string; dev?: boolean }>;
    packages["../escape/node_modules/picomatch"] = { version: "4.0.7" };
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
    expect(() => patchPicomatch(root)).toThrow(/escapes/);
  });
});
