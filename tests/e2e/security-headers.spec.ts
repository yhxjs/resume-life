import { createServer } from "node:http";
import { expect, test } from "@playwright/test";

test("生产页面响应禁止被 iframe 嵌入", async ({ request }) => {
  for (const pathname of ["/login", "/settings", "/resumes"]) {
    const response = await request.get(pathname);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(response.headers()["x-frame-options"]).toBe("DENY");
  }
});

test("同站不同源 iframe 不能载入已登录设置页，顶层访问正常", async ({ page, baseURL }) => {
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /frame-ancestors|refused to (?:display|frame)/i.test(message.text())) {
      blocked.push(message.text());
    }
  });
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<iframe src="${baseURL}/settings"></iframe>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有 TCP 端口");
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect.poll(() => blocked.length).toBeGreaterThan(0);
    await expect(page.frameLocator("iframe").getByRole("heading", { name: "系统设置", exact: true })).toHaveCount(0);

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "系统设置", exact: true })).toBeVisible();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
