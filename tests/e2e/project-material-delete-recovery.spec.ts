import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  for (const outcome of ["still-present", "deleted-408"] as const) {
    test(`材料删除 ${outcome} 核对与旧列表保护 ${width}px`, async ({ page, request }) => {
      await page.setViewportSize({ width, height: 900 });
      const created = await request.post("/api/projects", { data: { name: `删除核对 ${width}` } });
      expect(created.status()).toBe(201);
      const root = `/api/projects/${(await created.json()).id}`;
      const added = await request.post(`${root}/materials`, { data: { title: "保留到确认的材料", content: "完整原文 <T> &amp;\n删除前核对" } });
      expect(added.status()).toBe(201);
      const mid = (await added.json()).id;
      const endpoint = `${root}/materials/${mid}`;
      const before = await (await request.get(root)).json();
      const detail = await (await request.get(endpoint)).json();
      let deletes = 0;
      let checks = 0;
      let staleList = false;
      await page.route(`**${root}`, route => staleList ? route.fulfill({ json: before }) : route.continue());
      await page.route(`**${endpoint}`, async route => {
        if (route.request().method() === "DELETE") {
          deletes++;
          if (outcome === "still-present" && deletes === 1) return route.fulfill({ json: {} });
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          staleList = true;
          return outcome === "deleted-408" ? route.fulfill({ status: 408, json: { error: "合成响应超时" } }) : route.fulfill({ response });
        }
        if (route.request().method() === "GET" && deletes > 0 && outcome === "deleted-408") {
          checks++;
          if (checks === 1) return route.fulfill({ status: 503, json: { error: "合成读取失败" } });
          if (checks === 2) return route.fulfill({ json: { ...detail, id: mid + 100_000 } });
        }
        return route.continue();
      });
      try {
        await page.goto(root.replace("/api/projects/", "/knowledge/"));
        const remove = page.getByRole("button", { name: "删除", exact: true });
        await remove.click();
        await page.getByRole("dialog", { name: "删除材料", exact: true }).getByRole("button", { name: "删除", exact: true }).click();
        const status = page.getByRole("alert", { name: "材料删除状态", exact: true });
        if (outcome === "still-present") {
          await expect(status).toContainText("仍存在");
          expect((await request.get(endpoint)).status()).toBe(200);
          await expect(page.getByText(detail.title, { exact: true })).toBeVisible();
          expect(deletes).toBe(1);
          await remove.click();
          await page.getByRole("dialog", { name: "删除材料", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
          expect(deletes).toBe(1);
          await remove.click();
          await page.getByRole("dialog", { name: "删除材料", exact: true }).getByRole("button", { name: "删除", exact: true }).click();
        } else {
          await expect(status).toContainText("合成读取失败");
          await expect(page.getByText(detail.title, { exact: true })).toBeVisible();
          await expect(remove).toBeDisabled();
          const retry = page.getByRole("button", { name: "重新读取材料删除状态", exact: true });
          await retry.click();
          await expect(status).toContainText("材料核对响应不完整或不属于当前材料");
          await expect(remove).toBeDisabled();
          await retry.click();
        }
        await expect(page.getByText(detail.title, { exact: true })).toHaveCount(0);
        await expect(page.getByText("已沉淀技术文档 (0)", { exact: true })).toBeVisible();
        expect(deletes).toBe(outcome === "still-present" ? 2 : 1);
        expect((await request.get(endpoint)).status()).toBe(404);
        expect((await (await request.get(root)).json()).materials_total).toBe(0);
        staleList = false;
        await page.reload();
        await expect(page.getByText("已沉淀技术文档 (0)", { exact: true })).toBeVisible();
      } finally {
        staleList = false;
        await page.goto("/knowledge");
        expect((await request.delete(root)).status()).toBe(200);
      }
    });
  }

  test(`材料删除确认离页后移除旧弹窗，返回可重新取消 ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const name = `删除确认离页 ${width}`;
    const created = await request.post("/api/projects", { data: { name } });
    expect(created.status()).toBe(201);
    const root = `/api/projects/${(await created.json()).id}`;
    expect((await request.post(`${root}/materials`, { data: { title: "离页前的材料", content: "尚未删除原文" } })).status()).toBe(201);
    let deletes = 0;
    page.on("request", next => { if (next.method() === "DELETE" && next.url().includes(`${root}/materials/`)) deletes++; });
    try {
      await page.goto("/knowledge");
      await page.getByRole("link", { name, exact: true }).click();
      await page.getByRole("button", { name: "删除", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "删除材料", exact: true });
      await expect(dialog).toContainText("离页前的材料");
      await page.goBack();
      await expect(page).toHaveURL(/\/knowledge$/);
      await expect(dialog).toHaveCount(0);
      await page.goForward();
      await page.getByRole("button", { name: "删除", exact: true }).click();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      expect(deletes).toBe(0);
      expect((await (await request.get(root)).json()).materials_total).toBe(1);
    } finally {
      await page.goto("/knowledge");
      expect((await request.delete(root)).status()).toBe(200);
    }
  });
}
