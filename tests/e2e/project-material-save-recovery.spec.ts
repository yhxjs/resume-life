import { expect, test } from "@playwright/test";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) for (const outcome of ["empty", "408"] as const) {
  test(`材料编辑响应 ${outcome} 后只读核对并保留新编辑 ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/projects", { data: { name: `材料保存核对 ${width}` } });
    expect(created.status()).toBe(201);
    const root = `/api/projects/${(await created.json()).id}`;
    const material = await request.post(`${root}/materials`, { data: { title: "原材料", content: "原始职责" } });
    expect(material.status()).toBe(201);
    const mid = (await material.json()).id;
    const endpoint = `${root}/materials/${mid}`;
    const release = gate();
    let writes = 0;
    let checks = 0;
    let firstRevision = "";
    const versions: string[] = [];
    await page.route(`**${endpoint}`, async route => {
      if (route.request().method() === "PATCH") {
        writes++;
        versions.push(route.request().postDataJSON().expectedRevision);
        const response = await route.fetch();
        expect(response.status(), await response.text()).toBe(200);
        if (writes > 1) return route.fulfill({ response });
        firstRevision = (await response.json()).revision;
        return outcome === "empty" ? route.fulfill({ json: {} }) : route.fulfill({ status: 408, json: { error: "合成响应超时" } });
      }
      if (route.request().method() === "GET" && writes === 1) {
        checks++;
        if (checks === 1) return route.fulfill({ status: 503, json: { error: "合成核对失败" } });
        const response = await route.fetch();
        if (checks === 2) return route.fulfill({ json: { ...await response.json(), id: mid + 100_000 } });
        if (checks === 3) await release.promise;
        return route.fulfill({ response });
      }
      return route.continue();
    });
    try {
      await page.goto(root.replace("/api/projects/", "/knowledge/"));
      await page.getByRole("button", { name: "编辑", exact: true }).click();
      const title = page.getByRole("textbox", { name: "编辑材料标题", exact: true });
      const content = page.getByRole("textbox", { name: /^编辑「.*」材料正文$/ });
      await expect(content).toHaveValue("原始职责");
      await title.fill("核实后的标题");
      await content.fill("已保存的更正 <T> &amp;\n未统计收益");
      const save = page.getByRole("button", { name: "保存", exact: true });
      await save.click();
      await expect(content).toHaveValue("已保存的更正 <T> &amp;\n未统计收益");
      const status = page.getByRole("alert", { name: "材料保存状态", exact: true });
      await expect(status).toContainText("合成核对失败");
      await expect(content).toHaveValue("已保存的更正 <T> &amp;\n未统计收益");
      await expect(save).toBeDisabled();
      expect(writes).toBe(1);
      const retry = page.getByRole("button", { name: "重新读取材料保存状态", exact: true });
      await retry.click();
      await expect(status).toContainText("材料核对响应不完整或不属于当前材料");
      await retry.click();
      await expect.poll(() => checks).toBe(3);
      await title.fill("核对期间的新标题");
      await content.fill("核对期间继续更正，仍待保存");
      await status.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("material-save-check.png") });
      release.release();
      await expect(status).toHaveCount(0);
      await expect(save).toBeEnabled();
      await expect(title).toHaveValue("核对期间的新标题");
      await expect(content).toHaveValue("核对期间继续更正，仍待保存");
      expect(writes).toBe(1);
      expect((await (await request.get(endpoint)).json()).content).toBe("已保存的更正 <T> &amp;\n未统计收益");
      await save.click();
      await expect(content).toHaveCount(0);
      expect(writes).toBe(2);
      expect(versions[1]).toBe(firstRevision);
      expect(await (await request.get(endpoint)).json()).toMatchObject({ title: "核对期间的新标题", content: "核对期间继续更正，仍待保存" });
      expect((await (await request.get(root)).json()).materials_total).toBe(1);
      await page.reload();
      await page.getByRole("button", { name: "编辑", exact: true }).click();
      await expect(content).toHaveValue("核对期间继续更正，仍待保存");
    } finally {
      release.release();
      await page.goto("/knowledge");
      expect((await request.delete(root)).status()).toBe(200);
    }
  });
}
