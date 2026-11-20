import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mockApi } from "./synthetic-api";

const observations = new WeakMap<Page, { writes: string[]; errors: string[] }>();
test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/intros?**", route => route.fulfill({ json: { items: [], nextCursor: null, total: 0 } }));
  const state = { writes: [] as string[], errors: [] as string[] }; observations.set(page, state);
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) state.writes.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  page.on("pageerror", error => state.errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(observations.get(page)?.writes).toEqual([]); expect(observations.get(page)?.errors).toEqual([]);
});
async function capture(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(name), animations: "disabled" });
}
const group = (page: Page, name = "面试演练") => page.locator(`[data-nav-dropdown="${name}"]`);
async function findSafeMainPoint(page: Page) {
  const point = await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return null;
    const rect = main.getBoundingClientRect();
    for (let y = Math.max(1, Math.ceil(rect.top) + 4); y < Math.min(innerHeight, rect.bottom) - 4; y += 16) {
      for (let x = Math.max(1, Math.ceil(rect.left) + 4); x < Math.min(innerWidth, rect.right) - 4; x += 16) {
        const target = document.elementFromPoint(x, y);
        if (target && main.contains(target) && !target.closest("a,button,input,select,textarea,[role='button']")) return { x, y };
      }
    }
    return null;
  });
  expect(point, "main should have a non-interactive point outside the open dropdown").not.toBeNull();
  return point!;
}

for (const reducedMotion of ["no-preference", "reduce"] as const) test.describe(`导航指针 ${reducedMotion}`, () => {
  test.use({ viewport: { width: 1280, height: 900 }, reducedMotion });
  test("悬停后首次点击保持展开，再次点击与外部点击关闭，链接仍能正常跳转", async ({ page }, info) => {
    await page.goto("/tools"); await page.clock.install();
    for (const name of ["简历中心", "面试演练", "题库复盘"]) {
      const trigger = page.getByRole("button", { name, exact: true });
      await trigger.hover(); await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await trigger.click(); await expect(trigger).toHaveAttribute("aria-expanded", "true");
      const outside = await findSafeMainPoint(page);
      await page.mouse.move(outside.x, outside.y); await page.clock.runFor(200);
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await trigger.click(); await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await page.mouse.move(1, 300); await trigger.hover(); await trigger.click();
      await page.mouse.click(outside.x, outside.y); await expect(trigger).toHaveAttribute("aria-expanded", "false");
    }
    const trigger = page.getByRole("button", { name: "面试演练", exact: true }); await trigger.click();
    await capture(page, info, "nav-click-open.png");
    await group(page).getByRole("link", { name: /^自我介绍/ }).click(); await expect(page).toHaveURL(/\/intros$/);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("仅悬停会关闭，鼠标移开不能隐藏键盘链接，Tab 离开与 Escape 正确收起", async ({ page }, info) => {
    await page.goto("/tools"); await page.clock.install(); const trigger = page.getByRole("button", { name: "面试演练", exact: true });
    await trigger.hover(); await page.mouse.move(1, 300); await page.clock.runFor(200); await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.hover(); const link = group(page).getByRole("link", { name: /^自我介绍/ }); await link.focus();
    await page.mouse.move(1, 300); await page.clock.runFor(200); await expect(link).toBeVisible(); await expect(link).toBeFocused();
    await page.getByRole("button", { name: "简历中心", exact: true }).hover(); await expect(link).toBeVisible(); await expect(link).toBeFocused();
    await capture(page, info, "nav-keyboard-focus.png");
    await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "题库复盘", exact: true })).toBeFocused(); await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.focus(); await trigger.press("Enter"); await link.focus(); await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused(); await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.press("Space"); await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await trigger.press("Space"); await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("旧菜单关闭计时不能关闭键盘新开的菜单，普通 Tab 顺序保留", async ({ page }) => {
    await page.goto("/tools"); await page.clock.install();
    const first = page.getByRole("button", { name: "简历中心", exact: true }); const next = page.getByRole("button", { name: "面试演练", exact: true });
    await first.hover(); await page.mouse.move(1, 300); await next.focus(); await next.press("Enter"); await page.clock.runFor(200);
    await expect(first).toHaveAttribute("aria-expanded", "false"); await expect(next).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("menu")).toHaveCount(0); await expect(page.getByRole("menuitem")).toHaveCount(0);
    await page.keyboard.press("Tab"); await expect(group(page).getByRole("link", { name: /^模拟面试/ })).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(next).toBeFocused(); await page.keyboard.press("Escape");
    await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "题库复盘", exact: true })).toBeFocused();
  });

  test("展开动画的起始帧即可通过 Tab 进入链接", async ({ page }) => {
    await page.goto("/tools");
    const trigger = page.getByRole("button", { name: "面试演练", exact: true });
    await trigger.focus();
    await trigger.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const visibility = await trigger.evaluate(async button => {
      const panel = document.getElementById(button.getAttribute("aria-controls")!)!;
      // 停在展开动画的起始帧，稳定覆盖慢帧下的键盘操作。
      const animations = panel.getAnimations();
      for (const animation of animations) animation.pause();
      await Promise.all(animations.map(animation => animation.ready));
      for (const animation of animations) animation.currentTime = 0;
      return getComputedStyle(panel).visibility;
    });
    expect(visibility).toBe("visible");
    await page.keyboard.press("Tab");
    await expect(group(page).getByRole("link", { name: /^模拟面试/ })).toBeFocused();
  });

  test("从已点击的另一组移入并点击子链接，旧按钮失焦不会吞掉导航", async ({ page }) => {
    await page.goto("/tools"); const first = page.getByRole("button", { name: "简历中心", exact: true });
    await first.click(); await expect(first).toBeFocused();
    await page.getByRole("button", { name: "面试演练", exact: true }).hover();
    await group(page).getByRole("link", { name: /^自我介绍/ }).click(); await expect(page).toHaveURL(/\/intros$/);
  });
});

test.describe("宽屏触屏导航", () => {
  test.use({ viewport: { width: 1280, height: 900 }, hasTouch: true });
  test("首次轻触展开，再次轻触关闭；轻触子链接完成导航", async ({ page }) => {
    await page.goto("/tools"); const trigger = page.getByRole("button", { name: "面试演练", exact: true });
    await trigger.tap(); await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await trigger.tap(); await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.tap(); await group(page).getByRole("link", { name: /^自我介绍/ }).tap(); await expect(page).toHaveURL(/\/intros$/);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});

for (const reducedMotion of ["no-preference", "reduce"] as const) test.describe(`导航断点 ${reducedMotion}`, () => {
  test.use({ viewport: { width: 390, height: 900 }, reducedMotion });
  test("抽屉打开后切宽屏释放焦点与滚动，切回窄屏不复活，取消仍归还焦点", async ({ page }, info) => {
    await page.goto("/tools"); const initialOverflow = await page.locator("body").evaluate(body => body.style.overflow);
    const open = page.getByRole("button", { name: "打开导航菜单", exact: true }); const dialog = page.getByRole("dialog", { name: "导航菜单", exact: true });
    await open.click(); await expect(dialog).toBeVisible(); await expect(dialog.getByRole("button", { name: "关闭菜单", exact: true })).toBeFocused();
    expect(await page.locator("body").evaluate(body => body.style.overflow)).toBe("hidden"); await capture(page, info, "nav-mobile-drawer.png");
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(dialog).toHaveCount(0); await expect.poll(() => page.locator("body").evaluate(body => body.style.overflow)).toBe(initialOverflow);
    const trigger = page.getByRole("button", { name: "面试演练", exact: true }); await trigger.focus(); await trigger.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true"); await capture(page, info, "nav-after-resize.png");
    await page.setViewportSize({ width: 390, height: 900 }); await expect(dialog).toHaveCount(0);
    await open.click(); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(open).toBeFocused();
    await open.click(); await dialog.getByRole("link", { name: /^自我介绍/ }).click(); await expect(page).toHaveURL(/\/intros$/); await expect(dialog).toHaveCount(0);
    await expect.poll(() => page.locator("body").evaluate(body => body.style.overflow)).toBe(initialOverflow);
  });
});

test("导航在手机、平板、桌面及断点前后均无横向溢出", async ({ page }, info) => {
  await page.goto("/tools"); const sizes: { width: number; scrollWidth: number }[] = [];
  const invalidControls: { width: number; controls: string[] }[] = [];
  for (const width of [390, 767, 768, 1023, 1024, 1279, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    sizes.push(await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })));
    const invalid = await page.locator("header nav").evaluate(nav => {
      const toolbar = nav.getBoundingClientRect();
      const controls = Array.from(nav.querySelectorAll<HTMLAnchorElement | HTMLButtonElement>("a,button"))
        .filter(node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden")
        .map(node => ({ name: node.getAttribute("aria-label") ?? node.textContent?.trim() ?? "", rect: node.getBoundingClientRect() }));
      return controls.filter(({ rect }, index) => rect.top < toolbar.top - 1 || rect.bottom > toolbar.bottom + 1 || controls.some((other, otherIndex) =>
        index !== otherIndex && Math.min(rect.right, other.rect.right) - Math.max(rect.left, other.rect.left) > 1 && Math.min(rect.bottom, other.rect.bottom) - Math.max(rect.top, other.rect.top) > 1))
        .map(control => control.name);
    });
    if (invalid.length) invalidControls.push({ width, controls: invalid });
    if ([768, 1024, 1280].includes(width)) await page.screenshot({ path: info.outputPath(`nav-width-${width}.png`), animations: "disabled" });
  }
  expect({ overflow: sizes.filter(size => size.scrollWidth > size.width), invalidControls }).toEqual({ overflow: [], invalidControls: [] });
  await capture(page, info, "nav-desktop-layout.png");
});
