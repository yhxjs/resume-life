import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-connection-route-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  vi.stubEnv("RESUME_LIFE_SETTINGS_KEY", "PRIVATE_SENTINEL");
  vi.stubEnv("ARBITRARY_SECRET", "PRIVATE_SENTINEL");
  vi.stubEnv("RESUME_LIFE_MCP_ALLOWED_TOOLS", "get_mcp_status,create_project");
  db = (await import("@/lib/db")).getDb();
});
afterEach(() => {
  db?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-connection-route-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
const request = (body: unknown = { preset: "readonly", format: "json" }, headers: Record<string, string> = {}) => new Request("http://127.0.0.1/api/settings/mcp", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

it("returns allowlisted diagnostics and sanitized shared configuration without changing settings", async () => {
  const { GET, POST } = await import("./route");
  const before = db.prepare("SELECT * FROM settings").all();
  const report = await GET(new Request("http://127.0.0.1/api/settings/mcp"));
  expect(report.headers.get("cache-control")).toBe("no-store");
  const data = await report.json();
  expect(data.nodePath).toBe(process.execPath);
  expect(data.dataDirectory).toBe(directory);
  expect(data.presets).toHaveLength(5);
  expect(data.status.workspaceBinding).toMatch(/^[a-f0-9]{64}$/);
  expect(data.checks.map((item: { id: string }) => item.id)).toEqual(["runtime", "entry", "data", "config", "chromium", "ocr", "status"]);
  expect(JSON.stringify(data)).not.toContain("PRIVATE_SENTINEL");
  const generated = await POST(request());
  expect(generated.status).toBe(200);
  const config = await generated.json();
  expect(config).toMatchObject({ toolCount: 1, writeEnabled: false, firstCallAvailable: true });
  expect(config.text).not.toContain("PRIVATE_SENTINEL");
  expect(db.prepare("SELECT * FROM settings").all()).toEqual(before);
});

it.each(["GET", "POST"])("%s requires a real session outside tests and rejects cross-origin access", async method => {
  const route = await import("./route");
  const { createSession, SESSION_COOKIE_NAME } = await import("@/lib/auth");
  vi.stubEnv("NODE_ENV", "production");
  const anonymous = method === "GET" ? new Request("http://127.0.0.1/api/settings/mcp") : request();
  expect((await route[method as "GET" | "POST"](anonymous)).status).toBe(401);
  const cookie = `${SESSION_COOKIE_NAME}=${createSession().token}`;
  const cross = method === "GET" ? new Request(anonymous.url, { headers: { cookie, origin: "https://evil.invalid" } }) : request(undefined, { cookie, origin: "https://evil.invalid" });
  expect((await route[method as "GET" | "POST"](cross)).status).toBe(403);
});

it.each([null, [], {}, { preset: "__proto__", format: "json" }, { preset: "readonly", format: "xml" }, { preset: "readonly", format: "json", env: { SECRET: "x" } }])("rejects malformed config input %j", async body => {
  const { POST } = await import("./route");
  expect((await POST(request(body))).status).toBe(400);
});

it("caps streaming request size and content type, and never echoes broken env values", async () => {
  const { GET, POST } = await import("./route");
  expect((await POST(request({ preset: "X".repeat(300), format: "json" }))).status).toBe(413);
  expect((await POST(request(undefined, { "content-type": "text/plain" }))).status).toBe(415);
  vi.stubEnv("RESUME_LIFE_MCP_ALLOWED_TOOLS", "PRIVATE_SENTINEL");
  const response = await POST(request());
  expect(response.status).toBe(422); expect(await response.text()).not.toContain("PRIVATE_SENTINEL");
  const report = await (await GET(new Request("http://127.0.0.1/api/settings/mcp"))).json();
  expect(report.canGenerate).toBe(false);
  expect(report.checks.find((item: { id: string }) => item.id === "config").state).toBe("error");
  expect(JSON.stringify(report)).not.toContain("PRIVATE_SENTINEL");
});

it("accepts a same-origin browser request when Next rewrites the URL to its bind address", async () => {
  const { POST } = await import("./route");
  const response = await POST(new Request("http://0.0.0.0:3319/api/settings/mcp", {
    method: "POST", headers: { host: "127.0.0.1:3319", origin: "http://127.0.0.1:3319", "content-type": "application/json" },
    body: JSON.stringify({ preset: "readonly", format: "json" }),
  }));
  expect(response.status).toBe(200);
});

it("missing optional dependencies produce repair advice without blocking basic connection", async () => {
  vi.stubEnv("RESUME_LIFE_OCR_DATA_DIR", path.join(directory, "missing-ocr"));
  const { GET } = await import("./route");
  const report = await (await GET(new Request("http://127.0.0.1/api/settings/mcp"))).json();
  expect(report.checks.find((item: { id: string }) => item.id === "ocr")).toMatchObject({ state: "warning", repair: expect.stringContaining("npm run setup:ocr") });
  expect(report.canGenerate).toBe(true);
});

it("diagnoses unreadable entry and data directory separately without exposing exception contents", async () => {
  const { diagnoseMcpConnection } = await import("@/lib/mcp-connection");
  const originalStat = fs.statSync;
  const originalAccess = fs.accessSync;
  vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike) => {
    if (file === path.join(process.cwd(), "scripts/mcp.mjs")) throw new Error("PRIVATE_SENTINEL");
    return originalStat(file);
  }) as typeof fs.statSync);
  vi.spyOn(fs, "accessSync").mockImplementation((file, mode) => {
    if (file === directory) throw new Error("PRIVATE_SENTINEL");
    originalAccess(file, mode);
  });
  const report = await diagnoseMcpConnection();
  expect(report.canGenerate).toBe(false);
  expect(report.checks.filter(item => item.state === "error").map(item => item.id)).toEqual(["entry", "data"]);
  expect(report.checks.find(item => item.id === "entry")?.repair).toContain("npm ci");
  expect(JSON.stringify(report)).not.toContain("PRIVATE_SENTINEL");
});
