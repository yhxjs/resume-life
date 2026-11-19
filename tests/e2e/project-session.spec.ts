import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { emptySummary } from "../../src/lib/summary";
import { compareProjectSummaries } from "../../src/lib/project-summary-diff";

async function seed(request: APIRequestContext) {
  const ids: number[] = [];
  const cleanup = async () => { for (const id of ids) expect((await request.delete(`/api/projects/${id}`)).status()).toBe(200); };
  try {
    for (const name of ["会话隔离甲项目", "会话隔离乙项目"]) {
      const response = await request.post("/api/projects", { data: { name } });
      expect(response.status()).toBe(201);
      ids.push((await response.json()).id);
    }
    return { first: ids[0]!, second: ids[1]!, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

async function switchProject(page: Page, name: string) {
  await page.getByRole("link", { name: "← 返回项目知识库", exact: true }).click();
  await expect(page.getByRole("heading", { name: "技术项目知识库", exact: true })).toBeVisible();
  await page.getByRole("link", { name, exact: true }).click();
}

function proposal(text: string) {
  const summary = { ...emptySummary(), overview: text, brief: `${text}介绍` };
  return { summary, comparison: compareProjectSummaries(emptySummary(), summary, {}), materialChanges: [], materialFingerprint: "a".repeat(64), revisionId: 0 };
}

for (const width of [390, 1280]) test.describe(`项目会话 ${width}px`, () => {
  test.use({ viewport: { width, height: 900 } });
  for (const phase of ["pending", "finished"]) test(`甲项目生成${phase}后导航乙项目，旧草稿与人工更正不跨项目，新草稿正常预选`, async ({ page, request }) => {
    const seeded = await seed(request);
    const generation = Promise.withResolvers<void>();
    const newRead = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    let generating = false;
    let reading = false;
    let writes = 0;
    try {
      const rootA = `/api/projects/${seeded.first}`;
      const rootB = `/api/projects/${seeded.second}`;
      const originalA = await (await request.get(rootA)).json();
      const originalB = await (await request.get(rootB)).json();
      page.on("request", req => { if ([rootA, rootB].includes(new URL(req.url()).pathname) && req.method() === "PATCH") writes++; });
      await page.route(`**${rootA}/summarize*`, async route => {
        generating = true;
        if (phase === "pending") await generation.promise;
        try { await route.fulfill({ contentType: "text/event-stream", body: `event: done\ndata: ${JSON.stringify(proposal("甲项目 AI 草稿"))}\n\n` }); }
        finally { delivered.resolve(); }
      });
      await page.route(`**${rootB}`, async route => {
        const response = await route.fetch();
        reading = true;
        await newRead.promise;
        await route.fulfill({ response });
      });
      await page.route(`**${rootB}/summarize*`, route => route.fulfill({ contentType: "text/event-stream", body: `event: done\ndata: ${JSON.stringify(proposal("乙项目 AI 草稿"))}\n\n` }));
      await page.goto(`/knowledge/${seeded.first}`);
      const overview = page.locator("#project-summary-overview");
      await expect(overview).toHaveValue("");
      await overview.fill("甲项目手动更正");
      await overview.fill("");
      await page.getByRole("button", { name: /生成 AI STAR 总结/ }).click();
      await expect.poll(() => generating).toBe(true);
      if (phase === "finished") await expect(page.getByText("AI 草稿待确认：", { exact: true })).toBeVisible();
      await switchProject(page, "会话隔离乙项目");
      await expect.poll(() => reading).toBe(true);
      await expect(overview).toHaveCount(0);
      await expect(page.getByText("AI 草稿待确认：", { exact: true })).toHaveCount(0);
      newRead.resolve();
      await expect(page.getByRole("heading", { name: "会话隔离乙项目", exact: true })).toBeVisible();
      await expect(overview).toHaveValue("");
      await page.locator("#project-summary-responsibilities").fill("乙项目本人职责，未上线 <T> &amp;");
      generation.resolve();
      await delivered.promise;
      await expect(page.getByText("AI 草稿待确认：", { exact: true })).toHaveCount(0);
      await expect(page.locator("#project-summary-responsibilities")).toHaveValue("乙项目本人职责，未上线 <T> &amp;");
      await page.getByRole("button", { name: /生成 AI STAR 总结/ }).click();
      await expect(overview).toHaveValue("乙项目 AI 草稿");
      await expect(page.getByText("AI 草稿待确认：", { exact: true })).toBeVisible();
      expect(writes).toBe(0);
      expect(await (await request.get(rootA)).json()).toEqual(originalA);
      expect(await (await request.get(rootB)).json()).toEqual(originalB);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      generation.resolve(); newRead.resolve();
      await seeded.cleanup();
    }
  });

  for (const outcome of ["success", "failure"]) test(`甲项目保存${outcome}回包晚到，乙项目保存不受旧锁与旧结果影响`, async ({ page, request }) => {
    const seeded = await seed(request);
    const oldReply = Promise.withResolvers<void>();
    const newReply = Promise.withResolvers<void>();
    const oldDelivered = Promise.withResolvers<void>();
    let oldReceived = false;
    let newReceived = false;
    let writes = 0;
    const rootA = `/api/projects/${seeded.first}`;
    const rootB = `/api/projects/${seeded.second}`;
    try {
      page.on("request", req => { if ([rootA, rootB].includes(new URL(req.url()).pathname) && req.method() === "PATCH") writes++; });
      await page.route(`**${rootA}`, async route => {
        if (route.request().method() !== "PATCH") return route.continue();
        const response = outcome === "success" ? await route.fetch() : null;
        oldReceived = true;
        await oldReply.promise;
        try {
          if (response) await route.fulfill({ response });
          else await route.fulfill({ status: 503, json: { error: "甲项目旧保存失败" } });
        } finally { oldDelivered.resolve(); }
      });
      await page.route(`**${rootB}`, async route => {
        if (route.request().method() !== "PATCH") return route.continue();
        const response = await route.fetch();
        newReceived = true;
        await newReply.promise;
        await route.fulfill({ response });
      });
      await page.goto(`/knowledge/${seeded.first}`);
      const overview = page.locator("#project-summary-overview");
      await expect(overview).toHaveValue("");
      await overview.fill("甲项目提交稿");
      await page.getByRole("button", { name: "保存总结修改", exact: true }).click();
      await expect.poll(() => oldReceived).toBe(true);
      await switchProject(page, "会话隔离乙项目");
      await expect(page.getByRole("heading", { name: "会话隔离乙项目", exact: true })).toBeVisible();
      await expect(overview).toHaveValue("");
      await overview.fill("乙项目提交稿 <T> &amp;");
      await page.getByRole("button", { name: "保存总结修改", exact: true }).click();
      await expect.poll(() => newReceived).toBe(true);
      oldReply.resolve();
      await oldDelivered.promise;
      await expect(page.getByRole("button", { name: "保存总结修改", exact: true })).toBeDisabled();
      await expect(overview).toHaveValue("乙项目提交稿 <T> &amp;");
      await expect(page.getByText("总结已保存", { exact: true })).toHaveCount(0);
      await expect(page.getByText(/甲项目旧保存失败/)).toHaveCount(0);
      newReply.resolve();
      await expect(page.getByText("总结已保存", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "保存总结修改", exact: true })).toBeEnabled();
      const savedA = await (await request.get(rootA)).json();
      const savedB = await (await request.get(rootB)).json();
      expect(savedA.summary.overview).toBe(outcome === "success" ? "甲项目提交稿" : "");
      expect(savedB.summary.overview).toBe("乙项目提交稿 <T> &amp;");
      expect(writes).toBe(2);
      expect((await (await request.get(`${rootA}/summary-history`)).json()).items).toHaveLength(outcome === "success" ? 1 : 0);
      expect((await (await request.get(`${rootB}/summary-history`)).json()).items).toHaveLength(1);
    } finally {
      oldReply.resolve(); newReply.resolve();
      await seeded.cleanup();
    }
  });
});
