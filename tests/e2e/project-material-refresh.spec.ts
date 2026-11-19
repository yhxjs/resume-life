import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  for (const kind of ["paste", "file"]) {
  test(`${kind} 材料导入成功但刷新失败，清空已提交输入且重试只读取列表 (${width}px)`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/projects", { data: { name: `材料刷新项目 ${width}` } });
    expect(created.status()).toBe(201);
    const root = `/api/projects/${(await created.json()).id}`;
    let failRead = false;
    let writes = 0;
    await page.route(`**${root}`, async route => {
      if (route.request().method() === "GET" && failRead) {
        await route.fulfill({ status: 503, json: { error: "列表暂不可用" } });
      } else await route.continue();
    });
    page.on("request", next => { if (next.method() === "POST" && next.url().endsWith(`${root}/materials`)) writes++; });
    try {
      await page.goto(root.replace("/api/projects/", "/knowledge/"));
      if (kind === "paste") {
        await page.getByRole("textbox", { name: "材料标题", exact: true }).fill("已提交材料");
        await page.getByRole("textbox", { name: "粘贴材料正文", exact: true }).fill("参与接口联调，仅测试环境，无收益指标。");
      } else await page.getByLabel("上传材料文件", { exact: true }).setInputFiles({ name: "已提交材料.txt", mimeType: "text/plain", buffer: Buffer.from("参与接口联调，仅测试环境，无收益指标。") });
      failRead = true;
      await page.getByRole("button", { name: kind === "paste" ? "+ 导入粘贴材料" : "上传并解析文件", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "材料已导入" })).toContainText("材料已导入，列表刷新失败：列表暂不可用");
      await expect(page.getByRole("textbox", { name: "材料标题", exact: true })).toHaveValue("");
      await expect(page.getByRole("textbox", { name: "粘贴材料正文", exact: true })).toHaveValue("");
      await expect(page.getByLabel("上传材料文件", { exact: true })).toHaveValue("");
      expect(writes).toBe(1);
      const before = await (await request.get(root)).json();
      expect(before.materials_total).toBe(1);
      failRead = false;
      await page.getByRole("button", { name: "重试刷新材料", exact: true }).click();
      await expect(page.getByText(kind === "paste" ? "已提交材料" : "已提交材料.txt", { exact: true })).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: "列表刷新失败" })).toHaveCount(0);
      expect(writes).toBe(1);
      expect(await (await request.get(root)).json()).toEqual(before);
    } finally {
      failRead = false;
      await page.goto("/knowledge");
      expect((await request.delete(root)).status()).toBe(200);
    }
  });
  }

  test(`材料编辑与删除成功后刷新失败，重试只读且写入结果保留 (${width}px)`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/projects", { data: { name: `材料更新项目 ${width}` } });
    expect(created.status()).toBe(201);
    const root = `/api/projects/${(await created.json()).id}`;
    const material = await request.post(`${root}/materials`, { data: { title: "待编辑材料", content: "初始正文" } });
    expect(material.status()).toBe(201);
    const mid = (await material.json()).id;
    let failRead = false;
    let edits = 0;
    let deletes = 0;
    await page.route(`**${root}`, async route => {
      if (route.request().method() === "GET" && failRead) await route.fulfill({ status: 503, json: { error: "列表暂不可用" } });
      else await route.continue();
    });
    page.on("request", next => {
      if (!next.url().endsWith(`${root}/materials/${mid}`)) return;
      if (next.method() === "PATCH") edits++;
      if (next.method() === "DELETE") deletes++;
    });
    try {
      await page.goto(root.replace("/api/projects/", "/knowledge/"));
      await page.getByRole("button", { name: "编辑", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "编辑「待编辑材料」材料正文", exact: true })).toBeEnabled();
      await page.getByRole("textbox", { name: "编辑材料标题", exact: true }).fill("已更新材料");
      await page.getByRole("textbox", { name: "编辑「待编辑材料」材料正文", exact: true }).fill("已更正职责，仅测试环境。");
      failRead = true;
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "材料已保存" })).toContainText("列表刷新失败");
      await expect(page.getByText("已更新材料", { exact: true })).toBeVisible();
      expect((await (await request.get(`${root}/materials/${mid}`)).json()).content).toBe("已更正职责，仅测试环境。");
      expect(edits).toBe(1);
      failRead = false;
      await page.getByRole("button", { name: "重试刷新材料", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "列表刷新失败" })).toHaveCount(0);
      expect(edits).toBe(1);
      failRead = true;
      await page.getByRole("button", { name: "删除", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "材料已删除" })).toContainText("列表刷新失败");
      await expect(page.getByText("已更新材料", { exact: true })).toHaveCount(0);
      expect((await request.get(`${root}/materials/${mid}`)).status()).toBe(404);
      failRead = false;
      await page.getByRole("button", { name: "重试刷新材料", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "列表刷新失败" })).toHaveCount(0);
      expect({ edits, deletes }).toEqual({ edits: 1, deletes: 1 });
    } finally {
      failRead = false;
      await page.goto("/knowledge");
      expect((await request.delete(root)).status()).toBe(200);
    }
  });
}
