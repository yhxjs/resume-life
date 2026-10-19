import { expect, test } from "@playwright/test";
import { gate, mockApi, syntheticResume } from "./synthetic-api";

test("富文本用 Enter 和 Space 操作颜色与加粗并保留选区", async ({ page }) => {
  await mockApi(page);
  await page.goto("/resumes/9001");
  await page.getByRole("tab", { name: "个人简介", exact: true }).click();
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible();
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Tab");
  const colors = page.getByRole("button", { name: "设置文字颜色" }).first();
  await colors.focus();
  await page.keyboard.press("Enter");
  await expect(colors).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "商务蓝" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(editor).toContainText("合成简历正文");
  await expect.poll(() => editor.innerHTML()).toMatch(/color:\s*(?:rgb\(29, 78, 216\)|#1d4ed8)/);
  const bold = page.getByRole("button", { name: "加粗文本" }).first();
  await bold.focus();
  await page.keyboard.press("Space");
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => editor.innerHTML()).toMatch(/<(?:b|strong)[ >]|font-weight:\s*(?:bold|700)/);
});

test("跨标签页修改同一简历模块时保留先保存内容和后一个页面的草稿", async ({ page, request }) => {
  const created = await request.post("/api/resumes", { data: { title: `并发简历 ${Date.now()}` } });
  expect(created.status()).toBe(201);
  const id = (await created.json() as { id: number }).id;
  const other = await page.context().newPage();
  try {
    await Promise.all([page.goto(`/resumes/${id}`), other.goto(`/resumes/${id}`)]);
    const firstName = page.getByLabel("姓名", { exact: true });
    const secondEmail = other.getByLabel("邮箱", { exact: true });
    await expect(firstName).toBeVisible();
    await expect(secondEmail).toBeVisible();

    await firstName.fill("先保存的姓名");
    await expect.poll(async () => {
      const response = await request.get(`/api/resumes/${id}`);
      const document = await response.json() as { modules: { key: string; content: { name: string } }[] };
      return document.modules.find((module) => module.key === "basic")?.content.name;
    }).toBe("先保存的姓名");

    await secondEmail.fill("second@example.com");
    await expect(other.getByRole("alert").filter({ hasText: "简历已在其他页面修改" })).toBeVisible();
    const final = await (await request.get(`/api/resumes/${id}`)).json() as {
      modules: { key: string; content: { name: string; email: string } }[];
    };
    const basic = final.modules.find((module) => module.key === "basic")!.content;
    expect(basic.name).toBe("先保存的姓名");
    expect(basic.email).toBe("");
    await expect.poll(() => other.evaluate((key) => sessionStorage.getItem(key), `resume-life:draft:${id}`))
      .toContain("second@example.com");
  } finally {
    await other.close();
  }
});

test("immediate Next Link navigation preserves the latest edit on return", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/resumes/9001");
  await page.getByLabel("姓名", { exact: true }).fill("离页最新姓名");
  await page.getByRole("link", { name: "工具箱", exact: true }).click();
  await expect(page).toHaveURL(/\/tools$/);
  await expect.poll(() => api.resume().modules[0]!.content).toMatchObject({ name: "离页最新姓名" });
  await page.goBack();
  await expect(page.getByLabel("姓名", { exact: true })).toHaveValue("离页最新姓名");
});

test("failed saves survive a full reload and recover when the server is available", async ({ page }) => {
  const api = await mockApi(page);
  api.failSaves = true;
  await page.goto("/resumes/9001");
  await page.getByLabel("姓名", { exact: true }).fill("失败后恢复姓名");
  await expect(page.getByRole("alert").filter({ hasText: "保存失败" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByLabel("姓名", { exact: true })).toHaveValue("失败后恢复姓名");
  api.failSaves = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => api.resume().modules[0]!.content).toMatchObject({ name: "失败后恢复姓名" });
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("resume-life:draft:9001"))).toBeNull();
});

test("failed template and spacing changes return to the saved preview", async ({ page }) => {
  const api = await mockApi(page);
  api.failSaves = true;
  await page.goto("/resumes/9001");

  const template = page.getByTitle("点击切换简历模板");
  await template.click();
  const picker = page.getByRole("dialog", { name: "选择简历模板" });
  await picker.getByRole("button").filter({ hasText: "现代简约" }).first().click();
  await expect(page.getByRole("dialog", { name: "模板保存失败" })).toBeVisible();
  await expect(template).toContainText("经典单栏");
  await page.getByRole("dialog", { name: "模板保存失败" }).getByRole("button", { name: "确定" }).click();
  await picker.getByRole("button", { name: "完成" }).click();

  await page.getByRole("button", { name: /排版微调/ }).click();
  const spacing = page.getByRole("slider").first();
  const savedValue = await spacing.inputValue();
  await spacing.fill(savedValue === "4" ? "5" : "4");
  await expect(page.getByRole("dialog", { name: "排版微调保存失败" })).toBeVisible();
  await expect(spacing).toHaveValue(savedValue);
  expect(api.resume().resume.template).toBe("classic");
  expect(api.resume().resume.style_overrides).toEqual({});
});

test("a later failed template choice returns to the last successfully saved choice", async ({ page }) => {
  const api = await mockApi(page);
  const firstSave = gate();
  api.beforePatch = async (body) => {
    if (body.template === "modern") await firstSave.promise;
    api.failSaves = body.template === "classic";
  };
  await page.goto("/resumes/9001");

  const template = page.getByTitle("点击切换简历模板");
  try {
    await template.click();
    const picker = page.getByRole("dialog", { name: "选择简历模板" });
    await picker.getByRole("button").filter({ hasText: "现代简约" }).first().click();
    await expect.poll(() => api.writes.length).toBe(1);
    await picker.getByRole("button").filter({ hasText: "经典单栏" }).first().click();
    firstSave.release();
    await expect(page.getByRole("dialog", { name: "模板保存失败" })).toBeVisible();
    await expect(template).toContainText("现代简约");
    expect(api.resume().resume.template).toBe("modern");
  } finally {
    firstSave.release();
  }
});

test("failed order save restores the saved order without discarding a concurrent edit", async ({ page }) => {
  const api = await mockApi(page);
  const pendingOrder = gate();
  api.beforePatch = async (body) => {
    if (body.moduleOrder) await pendingOrder.promise;
    api.failSaves = Boolean(body.moduleOrder);
  };
  await page.goto("/resumes/9001");

  const source = page.getByRole("tab", { name: "基本信息", exact: true }).locator("..");
  const target = page.getByRole("tab", { name: "个人简介", exact: true }).locator("..");
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await source.dispatchEvent("dragstart", { dataTransfer });
    await target.dispatchEvent("dragover", { dataTransfer });
    await source.dispatchEvent("dragend", { dataTransfer });
    await expect(page.getByRole("tab").first()).toHaveText("个人简介");
    await expect.poll(() => api.writes.length).toBe(1);
    await page.getByLabel("姓名", { exact: true }).fill("排序失败期间的新姓名");
    pendingOrder.release();
    await expect(page.getByRole("dialog", { name: "排序保存失败" })).toBeVisible();
    await expect(page.getByRole("tab").first()).toHaveText("基本信息");
    await expect(page.getByLabel("姓名", { exact: true })).toHaveValue("排序失败期间的新姓名");
    await expect.poll(() => api.resume().modules[0]?.content).toMatchObject({ name: "排序失败期间的新姓名" });
  } finally {
    pendingOrder.release();
  }
});

for (const operation of ["rename", "order"] as const) {
  test(`slow save followed by ${operation} preserves edits made during the structure request`, async ({ page }) => {
    const api = await mockApi(page);
    const saving = gate();
    const structure = gate();
    api.beforePatch = async (body) => {
      if (api.writes.length === 1) await saving.promise;
      else if (body.renameModule || body.moduleOrder) await structure.promise;
    };
    await page.goto("/resumes/9001");
    const name = page.getByLabel("姓名", { exact: true });
    await name.fill("慢保存姓名");
    await expect.poll(() => api.writes.length).toBe(1);
    if (operation === "rename") {
      await page.getByRole("tab", { name: "基本信息", exact: true }).dblclick();
      await page.getByRole("textbox", { name: "模块重命名" }).fill("联系方式");
      await page.getByRole("textbox", { name: "模块重命名" }).press("Enter");
    } else {
      const source = page.getByRole("tab", { name: "基本信息", exact: true }).locator("..");
      const target = page.getByRole("tab", { name: "个人简介", exact: true }).locator("..");
      const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
      await source.dispatchEvent("dragstart", { dataTransfer });
      await target.dispatchEvent("dragover", { dataTransfer });
      await source.dispatchEvent("dragend", { dataTransfer });
    }
    expect(api.writes).toHaveLength(1);
    saving.release();
    await expect.poll(() => api.writes.length).toBe(2);
    await name.fill("结构请求期间姓名");
    structure.release();
    await expect(name).toHaveValue("结构请求期间姓名");
    await expect.poll(() => api.resume().modules.find((m) => m.key === "basic")?.content)
      .toMatchObject({ name: "结构请求期间姓名" });
    if (operation === "rename") await expect(page.getByRole("tab", { name: "联系方式", exact: true })).toBeVisible();
    else await expect(page.getByRole("tab").first()).toHaveText("个人简介");
  });
}

test("print output shows resume content and hides global navigation and branding", async ({ page }) => {
  await mockApi(page);
  await page.goto("/resumes/9001/print");
  await expect(page.locator(".paper")).toContainText("合成姓名");

  // 验证屏幕预览状态下缩放控件可用且能切换缩放比例
  const zoomTrigger = page.getByRole("button", { name: "选择缩放比例" });
  await expect(zoomTrigger).toBeVisible();
  await expect(zoomTrigger).toContainText("100%");
  await page.getByRole("button", { name: "放大预览" }).click();
  await expect(zoomTrigger).toContainText("125%");

  // 模拟真实打印场景，验证缩放包装层不影响打印输出
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("header")).toBeHidden();
  await expect(page.locator("body > footer")).toBeHidden();
  await expect(page.locator(".paper")).toBeVisible();
  await expect(page.locator(".paper")).toContainText("合成简历正文");
});

test("editor preview supports zoom in, zoom out and auto-fit reset", async ({ page }) => {
  await mockApi(page);
  await page.goto("/resumes/9001");
  const zoomTrigger = page.getByRole("button", { name: "选择缩放比例" });
  await expect(zoomTrigger).toBeVisible();
  await expect(zoomTrigger).toContainText("自适应");

  // 点击放大按钮切换为手动模式
  await page.getByRole("button", { name: "放大预览" }).click();
  await expect(zoomTrigger).not.toContainText("自适应");

  // 点击下拉菜单选择适应宽度复位
  await zoomTrigger.click();
  await page.getByRole("option", { name: "适应宽度 (默认)" }).click();
  await expect(zoomTrigger).toContainText("自适应");
});

test("zoom button can be activated with Space despite preview panning shortcut", async ({ page }) => {
  await mockApi(page);
  await page.goto("/resumes/9001");
  const trigger = page.getByRole("button", { name: "选择缩放比例" });
  await expect(trigger).toContainText("自适应");
  await page.getByRole("button", { name: "放大预览" }).focus();
  await page.keyboard.press("Space");
  await expect(trigger).not.toContainText("自适应");
});

test("editor preview supports Ctrl + wheel zoom and mouse panning", async ({ page }) => {
  await mockApi(page);
  await page.goto("/resumes/9001");
  const viewport = page.locator(".zoom-viewport");
  await expect(viewport).toBeVisible();

  const zoomTrigger = page.getByRole("button", { name: "选择缩放比例" });
  await expect(zoomTrigger).toBeVisible();

  const box = await viewport.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // 模拟按住 Control 并向上滚轮
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -150);
    await page.keyboard.up("Control");

    // 比例应当发生变化且脱离自适应模式
    await expect(zoomTrigger).not.toContainText("自适应");
  }

  await page.getByRole("button", { name: "选择缩放比例" }).click();
  await page.getByRole("option", { name: "150%" }).click();

  if (box) {
    // 按住空格键触发抓手平移
    await page.keyboard.down("Space");
    await expect(viewport).toHaveClass(/cursor-grab/);

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 100, startY - 100);
    await page.mouse.up();
    await page.keyboard.up("Space");

    // 验证视口 scrollLeft / scrollTop 发生平移 (水平方向因放大必定溢出)
    const scrollPos = await viewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
    expect(scrollPos.left).toBeGreaterThan(0);

    await viewport.evaluate((el) => { el.scrollLeft = 0; el.scrollTop = 0; });
    await page.keyboard.down("Control");
    await expect(viewport).toHaveClass(/cursor-grab/);

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 80, startY - 80);
    await page.mouse.up();
    await page.keyboard.up("Control");

    const scrollPosAfterCtrl = await viewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
    expect(scrollPosAfterCtrl.left).toBeGreaterThan(0);
  }
});

test("a late response from one resume cannot replace a different resume after client navigation", async ({ page }) => {
  const api = await mockApi(page);
  const oldResponse = gate();
  api.beforePatch = async () => { await oldResponse.promise; };
  const second = syntheticResume();
  second.resume.id = 9003;
  second.resume.title = "第二份合成简历";
  second.modules[0]!.content = { name: "第二份姓名" };
  await page.route("**/api/resumes/9003", (route) => route.fulfill({ json: second }));
  await page.route("**/api/search?**", (route) => route.fulfill({ json: {
    resumes: [second.resume], projects: [], questions: [], interviews: [], applications: [],
  } }));
  await page.goto("/resumes/9001");
  await page.getByRole("tab", { name: "基本信息", exact: true }).dblclick();
  await page.getByRole("textbox", { name: "模块重命名" }).fill("旧页延迟响应");
  await page.getByRole("textbox", { name: "模块重命名" }).press("Enter");
  await expect.poll(() => api.writes.length).toBe(1);
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog").getByRole("combobox", { name: "搜索关键词", exact: true }).fill("第二份");
  await page.getByRole("dialog").getByRole("option").first().click();
  await expect(page).toHaveURL(/\/resumes\/9003$/);
  await expect(page.getByLabel("姓名", { exact: true })).toHaveValue("第二份姓名");
  oldResponse.release();
  await expect.poll(() => api.resume().modules[0]!.label).toBe("旧页延迟响应");
  await expect(page.getByLabel("姓名", { exact: true })).toHaveValue("第二份姓名");
  await expect(page.getByRole("tab", { name: "基本信息", exact: true })).toBeVisible();
});
