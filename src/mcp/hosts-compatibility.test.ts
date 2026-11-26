import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { isolatedHostEnv, inspectorResult, toolData, assertToolError, validateArtifactPage, runProcess, supportsInspectorNode } from "../../scripts/check-mcp-hosts.mjs";

it("isolates all Host catalogs and excludes inherited model credentials or unsafe MCP flags", () => {
  const directory = path.join(os.tmpdir(), "synthetic-host-home");
  const env = isolatedHostEnv(directory, { ...process.env, OPENAI_API_KEY: "must-not-copy", ANTHROPIC_API_KEY: "must-not-copy",
    MCP_CATALOG_PATH: "private-catalog.json", RESUME_LIFE_MCP_LLM_ENABLED: "true", NODE_OPTIONS: "--require=private-hook.js" });
  expect(env.HOME).toBe(directory);
  expect(env.USERPROFILE).toBe(directory);
  expect(env.MCP_INSPECTOR_SECRET_STORE).toBe("memory");
  expect(env.RESUME_LIFE_MCP_LLM_ENABLED).toBe("false");
  expect(env.RESUME_LIFE_MCP_WRITE_ENABLED).toBe("false");
  expect(env.RESUME_LIFE_DATA_DIR).toBe(path.join(directory, "data"));
  expect(env).not.toHaveProperty("MCP_CATALOG_PATH");
  expect(env).not.toHaveProperty("NODE_OPTIONS");
  expect(JSON.stringify(env)).not.toContain("must-not-copy");
});

it("keeps Inspector tool failures distinct from CLI connection failures and malformed output", () => {
  const result = { isError: true, structuredContent: { ok: false, error: { code: "NOT_FOUND", message: "missing" }, meta: { requestId: "synthetic" } } };
  const output = { code: 5, stdout: JSON.stringify({ result }), stderr: '{"error":{"code":"tool_is_error"}}' };
  expect(inspectorResult(output, 5)).toEqual(result);
  expect(() => assertToolError(inspectorResult(output, 5), "NOT_FOUND")).not.toThrow();
  expect(() => inspectorResult({ ...output, code: 1 }, 5)).toThrow();
  expect(() => inspectorResult({ code: 0, stdout: "banner\n{}", stderr: "" })).toThrow();
  expect(() => inspectorResult({ code: 0, stdout: '{"tools":[]}', stderr: "" })).toThrow();
  expect(() => assertToolError({ ...result, structuredContent: { ...result.structuredContent, meta: {} } }, "NOT_FOUND")).toThrow();
  expect(() => assertToolError(result, "FORBIDDEN")).toThrow();
});

it("enforces the pinned Inspector engine requirement without changing the server runtime", () => {
  for (const version of ["22.23.4", "22.24.0", "24.22.1", "24.23.0", "26.12.1", "26.13.0", "27.0.0"]) expect(supportsInspectorNode(version)).toBe(true);
  for (const version of ["22.23.3", "23.30.0", "24.21.0", "24.22.0", "25.0.0", "26.12.0", "26.12.1-rc.1", "bad-version"]) expect(supportsInspectorNode(version)).toBe(false);
});

it("checks structured/text result agreement and refuses success without evidence", () => {
  const result = { structuredContent: { ok: true, data: { id: 1 } }, content: [{ type: "text", text: '{"id":1}' }] };
  expect(toolData(result)).toEqual({ id: 1 });
  expect(() => toolData({ ...result, content: [{ type: "text", text: '{"id":2}' }] })).toThrow();
  expect(() => toolData({ content: [{ type: "text", text: "success" }] })).toThrow();
  expect(() => toolData({ ...result, isError: true })).toThrow();
});

it("validates artifact identity, canonical bytes, cursor progress and end-of-file", () => {
  const bytes = Buffer.from("分页兼容验收");
  const artifact = { artifactId: "a".repeat(64), byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const part = { ...artifact, offset: 0, encoding: "base64", data: bytes.toString("base64"), nextOffset: null };
  expect(validateArtifactPage(part, artifact, 0)).toEqual(bytes);
  for (const override of [{ artifactId: "b".repeat(64) }, { offset: 1 }, { byteLength: 999 }, { sha256: "x" }, { data: part.data + "!" },
    { data: "" }, { encoding: "utf8" }, { nextOffset: 0 }]) {
    expect(() => validateArtifactPage({ ...part, ...override }, artifact, 0)).toThrow();
  }
});

it("runs child arguments without a shell and preserves a nonzero result for explicit assertions", async () => {
  const text = "synthetic $() ` & ; argument";
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1]);process.exitCode=5", text], {
    cwd: process.cwd(), env: isolatedHostEnv(os.tmpdir()), timeoutMs: 5000,
  });
  expect(result).toMatchObject({ code: 5, stdout: text });
});

it("bounds a hung subprocess instead of treating silence as success", async () => {
  await expect(runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    cwd: process.cwd(), env: isolatedHostEnv(os.tmpdir()), timeoutMs: 100,
  })).rejects.toThrow("timed out");
});
