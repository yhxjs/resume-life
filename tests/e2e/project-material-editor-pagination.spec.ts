import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) test(`续页材料编辑在档案保存刷新后保持可见，重新分页不重复且可继续保存 (${width}px)`, async ({ page, request }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width, height: 900 });
  const created = await request.post("/api/projects", { data: { name: `续页编辑项目 ${width}` } });
  expect(created.status()).toBe(201);
  const root = `/api/projects/${(await created.json()).id}`;
  let materialId = 0;
  let writes = 0;
  try {
    for (let index = 1; index <= 52; index++) {
      const added = await request.post(`${root}/materials`, { data: { title: `分页材料${index}`, content: `原始职责${index}` } });
      expect(added.status()).toBe(201);
      if (index === 1) materialId = (await added.json()).id;
    }
    const detail = `${root}/materials/${materialId}`;
    const baseline = await (await request.get(detail)).json();
    page.on("request", next => { if (next.method() === "PATCH" && next.url().endsWith(detail)) writes++; });
    await page.goto(root.replace("/api/projects/", "/knowledge/"));
    await page.getByRole("button", { name: "加载更多材料", exact: true }).click();
    const olderRow = page.locator(".rounded-xl").filter({ has: page.getByText("分页材料1", { exact: true }) });
    await olderRow.getByRole("button", { name: "编辑", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑「分页材料1」材料正文", exact: true });
    await expect(editor).toBeEnabled();
    await editor.fill("未保存更正：仅参与参数校验，无线上收益。");
    await page.getByRole("textbox", { name: "项目概述", exact: true }).fill("第一次档案保存");
    await page.getByRole("button", { name: "保存总结修改", exact: true }).click();
    const retained = page.getByText("当前编辑材料（未在本页列表中）", { exact: true });
    await expect(page.getByText("分页材料2", { exact: true })).toHaveCount(0);
    await expect(editor).toBeVisible();
    await expect(retained).toBeVisible();
    await expect(editor).toHaveValue("未保存更正：仅参与参数校验，无线上收益。");
    expect(await (await request.get(detail)).json()).toEqual(baseline);
    expect(writes).toBe(0);
    await expect(page.getByText("已沉淀技术文档 (52)", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "加载更多材料", exact: true }).click();
    await expect(retained).toHaveCount(0);
    await expect(page.getByText("分页材料1", { exact: true })).toHaveCount(1);
    await expect(editor).toHaveValue("未保存更正：仅参与参数校验，无线上收益。");
    await page.getByRole("textbox", { name: "项目概述", exact: true }).fill("第二次档案保存");
    await page.getByRole("button", { name: "保存总结修改", exact: true }).click();
    await expect(retained).toBeVisible();
    const saved = page.waitForResponse(next => next.url().endsWith(detail) && next.request().method() === "PATCH");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON().expectedRevision).toBe(baseline.revision);
    await expect(editor).toHaveCount(0);
    await expect(retained).toHaveCount(0);
    expect((await (await request.get(detail)).json()).content).toBe("未保存更正：仅参与参数校验，无线上收益。");
    expect(writes).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await page.goto("/knowledge");
    expect((await request.delete(root)).status()).toBe(200);
  }
});
