import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(process.cwd(), ".github", "workflows", "check.yml");

function actionReferences(source: string): { reference: string; line: string }[] {
  return source
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*-\s+uses:\s*([^\s#]+)(?:\s+#.*)?$/);
      return match ? [{ reference: match[1]!, line }] : [];
    });
}

describe("GitHub Actions workflow contract", () => {
  it("pins every third-party action to a full commit SHA with a release comment", () => {
    const source = fs.readFileSync(workflowPath, "utf8");
    const references = actionReferences(source);

    expect(references.length).toBeGreaterThan(0);
    for (const { reference, line } of references) {
      expect(reference, line).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(line, line).toMatch(/#\s*v\d+(?:\.\d+){0,2}\s*$/i);
    }
  });

  it("Windows 用覆盖率执行单测一次，并核验构建追踪和真实后端冒烟", () => {
    const source = fs.readFileSync(workflowPath, "utf8");
    const windowsJob = source.split(/\r?\n  windows:\r?\n/u)[1];
    expect(windowsJob).toBeDefined();
    expect(windowsJob).not.toMatch(/- run: npm test(?:\r?\n|$)/u);
    expect(windowsJob).toContain("- run: npm run test:coverage");
    expect(windowsJob).toContain("- run: npm run build");
    expect(windowsJob).toContain("- run: npm run check:build-trace");
    expect(windowsJob).toContain("real-backend-pagination.spec.ts");
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
