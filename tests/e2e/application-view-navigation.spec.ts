import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  for (const [view, label] of [["calendar", "日程日历"], ["funnel", "全周期漏斗"]] as const) {
    test(`投递视图直达 ${width}px ${view}：首屏与刷新后的选中项一致`, async ({ page }, testInfo) => {
      const writes: string[] = [], errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", req => { if (new URL(req.url()).pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method())) writes.push(req.method()); });
      await page.setViewportSize({ width, height: 900 });
      const response = await page.goto(`/applications?view=${view}`);
      const initialHtml = await response!.text();
      const serverSelected = await page.evaluate(html => new DOMParser().parseFromString(html, "text/html").querySelector('[role="tab"][aria-selected="true"]')?.textContent, initialHtml);
      await testInfo.attach("server-selected.txt", { body: serverSelected ?? "", contentType: "text/plain" });
      if (view === "funnel") await expect(page.getByRole("region", { name: "投递统计概览" })).toBeVisible();
      else await expect(page.getByRole("button", { name: /导出日历/ })).toBeVisible();
      const tabs = page.getByRole("tablist", { name: "求职看板视图切换" });
      await testInfo.attach("initial-tabs.json", { body: JSON.stringify(await tabs.getByRole("tab").evaluateAll(elements => elements.map(el => ({ name: el.textContent, selected: el.getAttribute("aria-selected"), tabIndex: el.tabIndex })))), contentType: "application/json" });
      await page.screenshot({ path: testInfo.outputPath(`application-${view}-${width}.png`) });
      await expect(tabs.getByRole("tab", { name: new RegExp(label) })).toHaveAttribute("aria-selected", "true");
      expect(serverSelected).toContain(label);
      await expect(tabs.getByRole("tab", { selected: true })).toHaveCount(1);
      await expect(page.getByRole("tabpanel", { name: new RegExp(label) })).toBeVisible();
      await page.reload();
      await expect(tabs.getByRole("tab", { name: new RegExp(label) })).toHaveAttribute("aria-selected", "true");
      expect(errors).toEqual([]);
      expect(writes).toEqual([]);
    });
  }
  test(`投递视图键盘 ${width}px：方向键、Home/End 与 URL 同步`, async ({ page }) => {
    const writes: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", req => { if (new URL(req.url()).pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method())) writes.push(req.method()); });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/applications?view=unknown&keep=original#position");
    const tabs = page.getByRole("tablist", { name: "求职看板视图切换" });
    const kanban = tabs.getByRole("tab", { name: /看板模式/ });
    const calendar = tabs.getByRole("tab", { name: /日程日历/ });
    const funnel = tabs.getByRole("tab", { name: /全周期漏斗/ });
    await expect(kanban).toHaveAttribute("aria-selected", "true");
    await kanban.focus(); await kanban.press("ArrowRight");
    await expect(calendar).toBeFocused();
    await expect(calendar).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/view=calendar&keep=original#position$/);
    await calendar.press("End");
    await expect(funnel).toBeFocused();
    await expect(funnel).toHaveAttribute("aria-selected", "true");
    await funnel.press("ArrowRight");
    await expect(kanban).toBeFocused();
    await expect(page).toHaveURL(/applications\?keep=original#position$/);
    await kanban.press("ArrowLeft");
    await expect(funnel).toBeFocused();
    await funnel.press("Home");
    await expect(kanban).toBeFocused();
    await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
    await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set("view", "calendar"); history.pushState(null, "", url); });
    await expect(calendar).toHaveAttribute("aria-selected", "true");
    await page.goBack();
    await expect(kanban).toHaveAttribute("aria-selected", "true");
    await page.goForward();
    await expect(calendar).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    expect(writes).toEqual([]);
  });
}
