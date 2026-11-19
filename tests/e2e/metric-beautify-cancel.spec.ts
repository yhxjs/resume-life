import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) test(`批量经历美化可点击取消，停止后续条目且重开不受旧回包影响 (${width}px)`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 900 });
  const created = await request.post("/api/resumes", { data: { title: `美化取消 ${width}`, modules: { work: [
    { id: "first", company: "合成甲公司", title: "开发", description: "只参与参数校验，尚未上线" },
    { id: "second", company: "合成乙公司", title: "开发", description: "只维护接口文档，收益未测量" },
  ] } } });
  expect(created.status()).toBe(201);
  const root = `/api/resumes/${(await created.json()).id}`;
  const before = await (await request.get(root)).json();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let calls = 0;
  let writes = 0;
  page.on("request", next => { if (new URL(next.url()).pathname === root && next.method() === "PATCH") writes++; });
  await page.route(`**${root}/polish`, async route => {
    calls++;
    if (calls > 1) return route.fulfill({ json: { result: { draft: `重开后的新草稿${calls}` } } });
    await release.promise;
    try { await route.fulfill({ json: { result: { draft: "关闭前的旧批次草稿" } } }); }
    catch { /* 取消会中止浏览器请求。 */ }
    finally { delivered.resolve(); }
  });
  try {
    await page.goto(root.replace("/api/", "/"));
    await page.getByRole("tab", { name: "工作经历", exact: true }).click();
    const trigger = page.getByRole("button", { name: "✨ AI 美化（2 条）", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "AI 美化", exact: true });
    await dialog.getByRole("button", { name: "开始美化", exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    await dialog.getByRole("button", { name: "取消", exact: true }).click({ timeout: 2500 });
    await expect(dialog).toHaveCount(0);
    await trigger.click();
    await dialog.getByRole("button", { name: "开始美化", exact: true }).click();
    await expect(dialog.getByText("重开后的新草稿2", { exact: true })).toBeVisible();
    await expect(dialog.getByText("重开后的新草稿3", { exact: true })).toBeVisible();
    release.resolve();
    await delivered.promise;
    await expect(dialog.getByText("关闭前的旧批次草稿", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "写入选中 2 条", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    expect(calls).toBe(3);
    expect(writes).toBe(0);
    expect(await (await request.get(root)).json()).toEqual(before);
  } finally {
    release.resolve();
    await page.goto("/resumes");
    expect((await request.delete(root)).status()).toBe(200);
  }
});
