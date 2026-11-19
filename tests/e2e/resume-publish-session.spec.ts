import { expect, test, type Page } from "@playwright/test";
import { gate } from "./synthetic-api";

test.use({ actionTimeout: 10_000 });
async function openPublisher(page: Page, name: string) {
  await page.getByRole("button", { name: "发布新版本", exact: true }).click();
  await page.getByRole("textbox", { name: "版本名称" }).fill(name);
}
async function prepareHistory(page: Page, url: string) {
  await page.goto(url); await expect(page.getByRole("button", { name: "发布新版本", exact: true })).toBeVisible();
  await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack();
}
for (const width of [390, 1280]) {
  test(`版本发布 ${width}px：排空草稿期间离页不发布，共享自动保存继续完成`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/resumes", { data: { title: `发布保存 ${width}` } }); expect(created.status()).toBe(201);
    const id = (await created.json()).id; const endpoint = `/api/resumes/${id}`;
    const started = gate(); const saveGate = gate(); const delivered = gate(); let posts = 0;
    await page.route(`**${endpoint}`, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      started.release(); await saveGate.promise; const response = await route.fetch(); expect(response.status()).toBe(200);
      await route.fulfill({ response }); delivered.release();
    });
    await page.route(`**${endpoint}/versions`, route => { if (route.request().method() === "POST") posts++; return route.continue(); });
    try {
      await prepareHistory(page, `/resumes/${id}`); await page.getByLabel("姓名", { exact: true }).fill("离页前待保存姓名"); await started.promise;
      await openPublisher(page, "离页前不应发布"); await page.getByRole("button", { name: "确认发布", exact: true }).click();
      await expect(page.getByRole("button", { name: "正在保存并发布…", exact: true })).toBeDisabled(); expect(posts).toBe(0);
      await page.goForward(); await expect(page).toHaveURL(/\/$/); saveGate.release(); await delivered.promise;
      await expect.poll(async () => (await (await request.get(endpoint)).json()).modules.find((module: { key: string }) => module.key === "basic").content.name).toBe("离页前待保存姓名");
      await page.waitForTimeout(300); expect(posts).toBe(0); await expect(page).toHaveURL(/\/$/);
      expect((await (await request.get(`${endpoint}/versions`)).json()).versions).toHaveLength(0);
      await page.goto(`/resumes/${id}`); await expect(page.getByLabel("姓名", { exact: true })).toHaveValue("离页前待保存姓名");
    } finally { saveGate.release(); await page.goto("/resumes"); expect((await request.delete(endpoint)).status()).toBe(200); }
  });

  test(`版本发布 ${width}px：读取草稿校验期间离页，迟到读取不新增版本`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/resumes", { data: { title: `发布读取 ${width}` } }); expect(created.status()).toBe(201);
    const id = (await created.json()).id; const endpoint = `/api/resumes/${id}`;
    const started = gate(); const readGate = gate(); const delivered = gate(); let posts = 0;
    await page.route(`**${endpoint}/versions`, async route => {
      if (route.request().method() !== "GET") { posts++; return route.continue(); }
      const response = await route.fetch(); expect(response.status()).toBe(200); started.release(); await readGate.promise;
      try { await route.fulfill({ response }); } catch { /* 离页可中止本地接收。 */ } finally { delivered.release(); }
    });
    try {
      await prepareHistory(page, `/resumes/${id}`); await openPublisher(page, "读取后不应发布");
      await page.getByRole("button", { name: "确认发布", exact: true }).click(); await started.promise;
      await page.goForward(); await expect(page).toHaveURL(/\/$/); readGate.release(); await delivered.promise;
      await page.waitForTimeout(300); expect(posts).toBe(0); await expect(page).toHaveURL(/\/$/);
      expect((await (await request.get(`${endpoint}/versions`)).json()).versions).toHaveLength(0);
    } finally { readGate.release(); await page.goto("/resumes"); expect((await request.delete(endpoint)).status()).toBe(200); }
  });

  for (const origin of ["编辑器", "版本树"]) test(`版本发布 ${width}px：${origin}已发布后的迟到回复不改写离页后的地址`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/resumes", { data: { title: `发布回复 ${origin} ${width}` } }); expect(created.status()).toBe(201);
    const id = (await created.json()).id; const endpoint = `/api/resumes/${id}`;
    const written = gate(); const responseGate = gate(); const delivered = gate(); let posts = 0;
    await page.route(`**${endpoint}/versions`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      posts++; const response = await route.fetch(); expect(response.status()).toBe(201); written.release(); await responseGate.promise;
      try { await route.fulfill({ response }); } catch { /* 本地取消不撤销已完成的服务端事务。 */ } finally { delivered.release(); }
    });
    try {
      await prepareHistory(page, `/resumes/${id}${origin === "版本树" ? "/versions" : ""}`);
      await openPublisher(page, "真实已发布"); await page.getByRole("button", { name: "确认发布", exact: true }).click(); await written.promise;
      await page.goForward(); await expect(page).toHaveURL(/\/$/); responseGate.release(); await delivered.promise;
      await page.waitForTimeout(300); await expect(page).toHaveURL(/\/$/); expect(posts).toBe(1);
      const versions = (await (await request.get(`${endpoint}/versions`)).json()).versions; expect(versions).toHaveLength(1); expect(versions[0].name).toBe("真实已发布");
      await page.goto(`/resumes/${id}/versions`); await expect(page.getByRole("heading", { name: "v1 · 真实已发布", exact: true })).toBeVisible();
    } finally { responseGate.release(); await page.goto("/resumes"); expect((await request.delete(endpoint)).status()).toBe(200); }
  });

  test(`版本发布 ${width}px：同一事件多次提交只有一个 POST、一个新版本`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/resumes", { data: { title: `发布互斥 ${width}` } }); expect(created.status()).toBe(201);
    const id = (await created.json()).id; const endpoint = `/api/resumes/${id}`; let posts = 0;
    const readGate = gate(); const started = gate();
    await page.route(`**${endpoint}/versions`, async route => {
      if (route.request().method() !== "GET") { posts++; return route.continue(); }
      const response = await route.fetch(); started.release(); await readGate.promise; return route.fulfill({ response });
    });
    try {
      await page.goto(`/resumes/${id}`); await openPublisher(page, "仅发布一次");
      await page.getByRole("button", { name: "确认发布", exact: true }).evaluate(button => {
        const form = (button as HTMLButtonElement).form!; form.requestSubmit(); form.requestSubmit(); form.requestSubmit();
      });
      await started.promise; await page.waitForTimeout(150); readGate.release();
      await expect(page.getByRole("heading", { name: "v1 · 仅发布一次", exact: true })).toBeVisible(); expect(posts).toBe(1);
      expect((await (await request.get(`${endpoint}/versions`)).json()).versions).toHaveLength(1);
    } finally { readGate.release(); await page.goto("/resumes"); expect((await request.delete(endpoint)).status()).toBe(200); }
  });
}
