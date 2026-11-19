import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  test(`登录连接 ${width}px：坏状态只读重试，等待不误开初始化表单`, async ({ page }, testInfo) => {
    await page.context().clearCookies();
    await page.setViewportSize({ width, height: 900 });
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let reads = 0;
    let writes = 0;
    page.on("request", incoming => { if (incoming.method() === "POST" && new URL(incoming.url()).pathname.startsWith("/api/auth/")) writes++; });
    await page.route("**/api/auth/status", async route => {
      reads++;
      if (reads === 1) return route.fulfill({ json: { initialized: "false", allowReinit: false } });
      started.resolve();
      await release.promise;
      return route.continue();
    });
    try {
      await page.goto("/login");
      const alert = page.getByRole("main").getByRole("alert");
      await expect(alert).toContainText("登录状态响应不完整");
      await expect(page.getByLabel("用户名", { exact: true })).toHaveCount(0);
      await expect(page.getByText("暂时无法连接", { exact: true })).toBeVisible();
      await alert.getByRole("button", { name: "重新连接", exact: true }).click();
      await started.promise;
      await expect(page.getByTestId("login-loading")).toBeVisible();
      await expect(page.getByLabel("用户名", { exact: true })).toHaveCount(0);
      expect(reads).toBe(2);
      expect(writes).toBe(0);
      release.resolve();
      await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
      await expect(page.getByLabel("确认密码", { exact: true })).toHaveCount(0);
      await expect(alert).toHaveCount(0);
      expect(reads).toBe(2);
      expect(writes).toBe(0);
      await page.screenshot({ path: testInfo.outputPath(`login-reconnected-${width}.png`), animations: "disabled" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      release.resolve();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  test(`登录提交 ${width}px：同事件只发一次，明确拒绝保留凭证后真实登录回跳`, async ({ page }, testInfo) => {
    await page.context().clearCookies();
    await page.setViewportSize({ width, height: 900 });
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const writes: { username: string; password: string }[] = [];
    let allowRealLogin = false;
    await page.route("**/api/auth/login", async route => {
      writes.push(route.request().postDataJSON());
      if (!allowRealLogin) {
        started.resolve();
        await release.promise;
        return route.fulfill({ status: 400, json: { error: "本次凭证明确拒绝，尚未登录" } });
      }
      return route.continue();
    });
    try {
      await page.goto("/login?next=%2Ftools%3Ffrom%3Dlogin-recovery");
      await page.getByLabel("用户名", { exact: true }).fill("e2e");
      await page.getByLabel("密码", { exact: true }).fill("e2e-password-123");
      await page.getByTestId("login-form").evaluate(form => {
        for (let i = 0; i < 3; i++) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await started.promise;
      await expect(page.getByLabel("用户名", { exact: true })).toBeDisabled();
      await expect(page.getByLabel("密码", { exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "请稍候…", exact: true })).toBeDisabled();
      expect(writes).toEqual([{ username: "e2e", password: "e2e-password-123" }]);
      release.resolve();
      const alert = page.getByRole("main").getByRole("alert");
      await expect(alert).toHaveText("本次凭证明确拒绝，尚未登录");
      await expect(alert).toBeFocused();
      await expect(alert).toBeInViewport();
      await expect(page.getByLabel("用户名", { exact: true })).toHaveValue("e2e");
      await expect(page.getByLabel("密码", { exact: true })).toHaveValue("e2e-password-123");
      await expect(page.getByRole("button", { name: "登录", exact: true })).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath(`login-rejected-${width}.png`), animations: "disabled" });
      expect((await page.request.get("/api/resumes")).status()).toBe(401);
      allowRealLogin = true;
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(page).toHaveURL("http://127.0.0.1:3319/tools?from=login-recovery");
      expect(writes).toEqual(Array(2).fill({ username: "e2e", password: "e2e-password-123" }));
      expect((await page.request.get("/api/resumes")).status()).toBe(200);
    } finally {
      release.resolve();
      await page.unrouteAll({ behavior: "wait" });
      // 每个用例使用独立登录会话；不撤销其他测试共用的初始化会话。
      await page.request.post("/api/auth/logout");
    }
  });
}
