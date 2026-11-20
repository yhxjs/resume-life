import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import baseConfig from "../../../vitest.config.mjs";
import shardConfig from "../../../vitest.shard.config.mjs";

const workflowPath = path.join(process.cwd(), ".github", "workflows", "check.yml");

function job(source: string, name: string): string {
  return source.split(new RegExp(`\\r?\\n  ${name}:\\r?\\n`, "u"))[1]?.split(/\r?\n  [\w-]+:\r?\n/u)[0] ?? "";
}

function actionReferences(source: string): { reference: string; line: string }[] {
  return source
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*-\s+uses:\s*([^\s#]+)(?:\s+#.*)?$/);
      return match ? [{ reference: match[1]!, line }] : [];
    });
}

describe("GitHub Actions workflow contract", () => {
  it("分片配置继承完整用例、worker 和覆盖范围，完整配置仍执行原有门槛", () => {
    expect(shardConfig.test).toEqual({
      ...baseConfig.test,
      coverage: { ...baseConfig.test?.coverage, reporter: [], thresholds: undefined },
    });
    expect(baseConfig.test?.coverage?.thresholds).toMatchObject({ lines: 85, functions: 78, branches: 77 });
  });

  it("pins every third-party action to a full commit SHA with a release comment", () => {
    const source = fs.readFileSync(workflowPath, "utf8");
    const references = actionReferences(source);

    expect(references.length).toBeGreaterThan(0);
    for (const { reference, line } of references) {
      expect(reference, line).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(line, line).toMatch(/#\s*v\d+(?:\.\d+){0,2}\s*$/i);
    }
  });

  it("Windows 分片执行完整单测并合并覆盖率，保留构建追踪和真实后端冒烟", () => {
    const source = fs.readFileSync(workflowPath, "utf8");
    const windowsJob = job(source, "windows");
    const unitJob = job(source, "windows-unit");
    const coverageJob = job(source, "windows-coverage");
    expect(windowsJob).not.toMatch(/- run: npm test(?:\r?\n|$)/u);
    expect(unitJob).toContain("npm run test:coverage -- --config vitest.shard.config.mts --shard=${{ matrix.shard }}/4");
    expect(unitJob).toContain("shard: [1, 2, 3, 4]");
    expect(unitJob).toContain("fail-fast: false");
    expect(unitJob).toContain("if-no-files-found: error");
    expect(coverageJob).toContain("needs: windows-unit");
    expect(coverageJob).toContain('assert.deepEqual(readdirSync(".vitest-reports").sort(), [1, 2, 3, 4].map');
    expect(coverageJob).toContain("npm run test:coverage -- --merge-reports=.vitest-reports");
    expect(coverageJob).not.toContain("--config vitest.shard");
    expect(coverageJob).toContain("npm run check:page-coverage");
    expect(windowsJob).toContain("- run: npm run build");
    expect(windowsJob).toContain("- run: npm run check:build-trace");
    expect(windowsJob).toContain("real-backend-pagination.spec.ts");
  });

  it("所有发布检查均由总门禁收口，浏览器分片不改变用例筛选或重试", () => {
    const source = fs.readFileSync(workflowPath, "utf8");
    const linuxJob = job(source, "linux");
    const browserJob = job(source, "e2e");
    const checkJob = job(source, "check");
    for (const command of ["check:public-assets", "lint", "typecheck", "build", "check:build-trace", "test:coverage", "check:page-coverage"]) {
      expect(linuxJob).toContain(`npm run ${command}`);
    }
    expect(linuxJob).not.toMatch(/- run: npm (?:test|run check:release)(?:\r?\n|$)/u);
    expect(browserJob).toContain("npm run test:e2e -- --shard=${{ matrix.shard }}/4");
    expect(browserJob).toContain("shard: [1, 2, 3, 4]");
    expect(browserJob).not.toMatch(/--(?:grep|retries|workers|test-ignore)/u);
    expect(checkJob).toContain("if: always()");
    expect(checkJob).toContain("needs: [linux, e2e, windows, windows-coverage]");
    expect(checkJob).toContain('job.result !== "success"');
    expect(source).not.toContain("continue-on-error");
  });

  it("普通 PR 检查不请求制品证明写权限，证明仅在 push job 中执行", () => {
    const source = fs.readFileSync(workflowPath, "utf8");
    expect(source).toMatch(/permissions:\r?\n  contents: read\r?\n/u);
    expect(source).not.toMatch(/^  id-token: write\s*$/mu);
    expect(source).not.toMatch(/^  attestations: write\s*$/mu);

    const checkJob = source.split(/\r?\n  check:\r?\n/u)[1]?.split(/\r?\n  attest:\r?\n/u)[0] ?? "";
    expect(checkJob).not.toContain("attest-build-provenance");

    const attestJob = source.split(/\r?\n  attest:\r?\n/u)[1] ?? "";
    expect(attestJob).toContain("if: github.event_name == 'push'");
    expect(attestJob).toContain("id-token: write");
    expect(attestJob).toContain("attestations: write");
    expect(attestJob).toContain("attest-build-provenance");
  });
});
