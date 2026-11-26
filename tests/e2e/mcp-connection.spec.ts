import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("settings guides a local MCP connection and generates copyable configurations", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/settings");
  const panel = page.getByRole("region", { name: "MCP 接入向导" });
  await expect(panel.getByText(/外部 Host 连接状态：未验证/)).toBeVisible();
  await expect(panel.getByLabel("权限预设")).toBeVisible();
  await expect(panel.getByLabel("权限预设").locator("option")).toHaveCount(5);
  await expect(panel.getByText("数据目录", { exact: true })).toBeVisible();
  await expect(panel.getByRole("status").filter({ hasText: "后台任务：" })).toBeVisible();
  await expect(panel.getByText(/临时缓存：/)).toBeVisible();
  await panel.getByRole("button", { name: "生成 MCP 配置", exact: true }).click();
  const output = panel.getByLabel("生成的 MCP 配置");
  await expect(output).toBeVisible();
  const config = JSON.parse(await output.inputValue()).mcpServers["resume-life"];
  expect(config.env.RESUME_LIFE_MCP_WRITE_ENABLED).toBe("false");
  expect(config.env.RESUME_LIFE_MCP_LLM_ENABLED).toBe("false");
  expect(config.env.RESUME_LIFE_DATA_DIR).toContain("resume-life-e2e-");
  expect(config.env.RESUME_LIFE_SETTINGS_KEY).toBeUndefined();
  await panel.getByRole("button", { name: "复制 MCP 配置", exact: true }).click();
  await expect(panel.getByRole("status").filter({ hasText: "已复制配置" })).toBeVisible();
  // Windows clipboard uses CRLF; verify content after native line-ending normalization.
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(await output.inputValue());
  const report = await (await page.request.get("/api/settings/mcp")).json();
  const client = new Client({ name: "web-connection-acceptance", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ ...config, stderr: "ignore" }));
    expect((await client.listTools()).tools.some(tool => tool.name === "get_mcp_status")).toBe(true);
    const status = await client.callTool({ name: "get_mcp_status", arguments: {} });
    expect(status.isError).not.toBe(true);
    expect(JSON.stringify(status)).toContain(report.status.workspaceBinding);
  } finally { await client.close(); }
  await panel.getByLabel("配置格式").selectOption("codex");
  await expect(output).toHaveCount(0);
  await panel.getByLabel("权限预设").selectOption("authoring");
  await panel.getByRole("button", { name: "生成 MCP 配置", exact: true }).click();
  await expect(output).toHaveValue(/\[mcp_servers.resume-life\]/);
  await expect(output).toHaveValue(/RESUME_LIFE_MCP_WRITE_ENABLED = "true"/);
  await expect(panel.getByText(/让 Agent 调用 get_mcp_status/)).toBeVisible();
});

test("diagnosis failure is recoverable and protected endpoints reject unauthenticated or cross-site requests", async ({ page, playwright }) => {
  await page.route("**/api/settings/mcp", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }), { times: 1 });
  await page.goto("/settings");
  const panel = page.getByRole("region", { name: "MCP 接入向导" });
  await expect(panel.getByRole("alert")).toContainText("诊断未完成");
  await panel.getByRole("button", { name: "刷新诊断" }).click();
  await expect(panel.getByLabel("权限预设")).toBeVisible();
  const crossSite = await page.request.post("/api/settings/mcp", { headers: { Origin: "https://evil.invalid" }, data: { preset: "readonly", format: "json" } });
  expect(crossSite.status()).toBe(403);
  const anonymous = await playwright.request.newContext({ baseURL: "http://127.0.0.1:3319", storageState: { cookies: [], origins: [] } });
  try { expect((await anonymous.get("/api/settings/mcp")).status()).toBe(401); }
  finally { await anonymous.dispose(); }
});
