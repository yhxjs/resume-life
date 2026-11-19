import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  for (const kind of ["paste", "file"]) {
    test(`${kind} 材料已落库但回复丢失，只读核对和显式解锁前不能重复导入 (${width}px)`, async ({ page, request }) => {
      await page.setViewportSize({ width, height: 900 });
      const created = await request.post("/api/projects", { data: { name: `材料导入恢复 ${width}` } });
      expect(created.status()).toBe(201);
      const root = `/api/projects/${(await created.json()).id}`;
      let writes = 0;
      let checks = 0;
      const release = Promise.withResolvers<void>();
      await page.route(`**${root}/materials`, async route => {
        if (route.request().method() !== "POST" || ++writes !== 1) return route.continue();
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        await route.fulfill({ status: kind === "paste" ? 503 : 408, json: { error: "保存后连接中断" } });
      });
      await page.route(`**${root}?limit=50`, async route => {
        checks++;
        if (checks === 1) return route.fulfill({ status: 503, json: { error: "列表暂不可用" } });
        const response = await route.fetch();
        if (checks === 2) return route.fulfill({ response, json: { ...await response.json(), id: 0 } });
        await release.promise;
        await route.fulfill({ response });
      });
      try {
        await page.goto(root.replace("/api/projects/", "/knowledge/"));
        const editor = page.getByRole("textbox", { name: "粘贴材料正文", exact: true });
        const fileInput = page.getByLabel("上传材料文件", { exact: true });
        const title = page.getByRole("textbox", { name: "材料标题", exact: true });
        if (kind === "paste") { await title.fill("待导入材料"); await editor.fill("仅完成联调，没有线上指标。"); }
        else await fileInput.setInputFiles({ name: "待导入材料.txt", mimeType: "text/plain", buffer: Buffer.from("仅完成联调，没有线上指标。") });
        const submit = page.getByRole("button", { name: kind === "paste" ? "+ 导入粘贴材料" : "上传并解析文件", exact: true });
        await submit.click();
        const notice = page.getByRole("alert", { name: "材料导入状态" });
        await expect(notice).toContainText("读取材料列表失败：列表暂不可用");
        await expect(submit).toBeDisabled();
        if (kind === "paste") await expect(editor).toHaveValue("仅完成联调，没有线上指标。");
        else await expect(fileInput).toHaveValue(/待导入材料\.txt$/);
        const unlock = notice.getByRole("button", { name: "核对后解除导入锁定", exact: true });
        await expect(unlock).toBeDisabled();
        await notice.getByRole("button", { name: "重新读取材料导入状态", exact: true }).click();
        await expect(notice).toContainText("不完整或不属于当前项目");
        await expect(unlock).toBeDisabled();
        await notice.getByRole("button", { name: "重新读取材料导入状态", exact: true }).click();
        await expect.poll(() => checks).toBe(3);
        await expect(unlock).toBeDisabled();
        if (kind === "paste") { await title.fill("下一份材料"); await editor.fill("新输入，只完成测试验证。"); }
        else await fileInput.setInputFiles({ name: "下一份材料.txt", mimeType: "text/plain", buffer: Buffer.from("新输入，只完成测试验证。") });
        release.resolve();
        await expect(notice).toContainText("同名材料不能确认本次导入");
        await notice.locator("summary").click();
        await expect(notice).toContainText("待导入材料");
        await expect(notice).toContainText("共 1 份");
        await expect(submit).toBeDisabled();
        expect(writes).toBe(1);
        expect((await (await request.get(root)).json()).materials_total).toBe(1);
        await unlock.click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText("再次导入可能产生重复");
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        await expect(submit).toBeDisabled();
        await unlock.click();
        await dialog.getByRole("button", { name: "保留原稿并解除锁定", exact: true }).click();
        await expect(submit).toBeEnabled();
        expect(writes).toBe(1);
        if (kind === "paste") await expect(editor).toHaveValue("新输入，只完成测试验证。");
        else await expect(fileInput).toHaveValue(/下一份材料\.txt$/);
        await page.screenshot({ path: `test-results/material-import-${kind}-${width}.png`, fullPage: true });
        await submit.click();
        await expect(submit).toBeDisabled();
        await expect.poll(async () => (await (await request.get(root)).json()).materials_total).toBe(2);
        expect(writes).toBe(2);
        const detail = await (await request.get(root)).json();
        expect((await (await request.get(`${root}/materials/${detail.materials[0].id}`)).json()).content).toBe("新输入，只完成测试验证。");
        await page.reload();
        await expect(page.getByText(kind === "paste" ? "下一份材料" : "下一份材料.txt", { exact: true })).toBeVisible();
      } finally { release.resolve(); await page.goto("/knowledge"); await request.delete(root); }
    });
  }

  test(`材料空成功回复保留原稿，空列表不确认成功，离页关闭解锁确认 (${width}px)`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/projects", { data: { name: "材料坏确认" } });
    expect(created.status()).toBe(201);
    const root = `/api/projects/${(await created.json()).id}`;
    let writes = 0;
    await page.route(`**${root}/materials`, route => { writes++; return route.fulfill({ status: 201, json: {} }); });
    try {
      await page.goto("/knowledge");
      await page.getByRole("link", { name: "材料坏确认", exact: true }).click();
      const editor = page.getByRole("textbox", { name: "粘贴材料正文" });
      await editor.fill("需要保留的材料原稿");
      await page.getByRole("button", { name: "+ 导入粘贴材料", exact: true }).click();
      const notice = page.getByRole("alert", { name: "材料导入状态" });
      await expect(notice).toContainText("空列表也不代表在途请求不会随后完成");
      await expect(editor).toHaveValue("需要保留的材料原稿");
      await expect(page.getByRole("button", { name: "+ 导入粘贴材料", exact: true })).toBeDisabled();
      await notice.getByRole("button", { name: "核对后解除导入锁定", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/\/knowledge$/);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect((await (await request.get(root)).json()).materials_total).toBe(0);
      expect(writes).toBe(1);
    } finally { await page.goto("/knowledge"); await request.delete(root); }
  });
}
