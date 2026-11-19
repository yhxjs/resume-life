import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { emptySummary } from "../../src/lib/summary";
import { compareProjectSummaries } from "../../src/lib/project-summary-diff";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) for (const scenario of ["manual-bad-response", "proposal-408", "proposal-mismatch"] as const) {
  test(`总结保存恢复 ${width}px ${scenario}：真实写入后核对，保留新编辑并以确认版本再次保存`, async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 900 });
    const name = `保存恢复 ${scenario}`;
    const created = await request.post("/api/projects", { data: { name } });
    expect(created.status()).toBe(201);
    const id = (await created.json()).id as number;
    const root = `/api/projects/${id}`;
    const release = gate();
    const generated = { ...emptySummary(), overview: "已核实的项目定位 <T> &amp;\n尚未上线", achievements: ["参与参数校验，收益尚未统计"] };
    const isProposal = scenario !== "manual-bad-response";
    let writes = 0;
    let reads = 0;
    const submittedVersions: number[] = [];
    let firstRevision = 0;
    try {
      const fingerprint = createHash("sha256").update(JSON.stringify({ projectId: id, projectName: name, materials: [] })).digest("hex");
      await page.route(`**${root}/summarize`, route => route.fulfill({ contentType: "text/event-stream", body: `event: done\ndata: ${JSON.stringify({
        summary: generated, comparison: compareProjectSummaries(emptySummary(), generated, {}), materialChanges: [], materialFingerprint: fingerprint, revisionId: 0,
      })}\n\n` }));
      await page.route(`**${root}`, async route => {
        if (route.request().method() === "PATCH") {
          writes++;
          submittedVersions.push(route.request().postDataJSON().expectedRevisionId);
          const response = await route.fetch();
          expect(response.status(), await response.text()).toBe(200);
          const body = await response.json();
          if (writes > 1) return route.fulfill({ response });
          firstRevision = body.revisionId;
          if (scenario === "proposal-408") return route.fulfill({ status: 408, json: { error: "合成响应超时" } });
          if (scenario === "proposal-mismatch") return route.fulfill({ json: { ...body, summary: { ...body.summary, overview: "错误回包正文，不能覆盖草稿" } } });
          return route.fulfill({ json: {} });
        }
        if (route.request().method() === "GET" && writes === 1) {
          reads++;
          if (reads === 1) return route.fulfill({ status: 503, json: { error: "合成核对读取失败" } });
          const response = await route.fetch();
          if (reads === 2) return route.fulfill({ json: { ...await response.json(), id: id + 100_000 } });
          if (reads === 3) await release.promise;
          return route.fulfill({ response });
        }
        return route.continue();
      });
      await page.goto(`/knowledge/${id}`);
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
      const overview = page.locator("#project-summary-overview");
      if (isProposal) {
        await page.getByRole("button", { name: /生成 AI STAR 总结/ }).click();
        await expect(overview).toHaveValue(generated.overview);
      } else {
        await overview.fill(generated.overview);
        await page.getByRole("button", { name: "+ 添加一项成果", exact: true }).click();
        await page.getByRole("textbox", { name: "项目成果1", exact: true }).fill(generated.achievements[0]!);
      }
      const save = page.getByRole("button", { name: isProposal ? "确认采用入库" : "保存总结修改", exact: true });
      await save.click();
      const alert = page.getByRole("alert", { name: "总结保存状态", exact: true });
      await expect(alert).toContainText("合成核对读取失败");
      await expect(save).toBeDisabled();
      await expect(overview).toHaveValue(generated.overview);
      expect(writes).toBe(1);
      const actual = await (await request.get(root)).json();
      expect(actual.summary).toEqual(generated);
      expect((await (await request.get(`${root}/summary-history`)).json()).items).toHaveLength(1);
      const retry = page.getByRole("button", { name: "重新读取保存状态", exact: true });
      await retry.click();
      await expect(alert).toContainText("总结核对响应不完整或不属于当前项目");
      await expect(save).toBeDisabled();
      expect(writes).toBe(1);
      await alert.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("summary-save-unknown.png") });
      await retry.click();
      await expect.poll(() => reads).toBe(3);
      await page.locator("#resume-brief").fill("核对期间继续编辑，尚未确认 <T> &amp;");
      if (isProposal) await page.getByRole("region", { name: "本次总结差异" }).getByRole("group", { name: "项目概述", exact: true }).getByRole("button", { name: "撤销采纳" }).click();
      release.release();
      await expect(alert).toHaveCount(0);
      await expect(save).toBeEnabled();
      await expect(overview).toHaveValue(isProposal ? "" : generated.overview);
      await expect(page.locator("#resume-brief")).toHaveValue("核对期间继续编辑，尚未确认 <T> &amp;");
      expect(writes).toBe(1);
      expect((await (await request.get(`${root}/summary-history`)).json()).items).toHaveLength(1);
      await save.click();
      await expect(page.getByText(isProposal ? "草稿已确认，总结已写入项目档案" : "总结已保存", { exact: true })).toBeVisible();
      expect(submittedVersions).toEqual([0, firstRevision]);
      const expected = { ...generated, overview: isProposal ? "" : generated.overview, brief: "核对期间继续编辑，尚未确认 <T> &amp;" };
      expect((await (await request.get(root)).json()).summary).toEqual(expected);
      const history = (await (await request.get(`${root}/summary-history`)).json()).items;
      expect(history).toHaveLength(2);
      expect(history[1].summary).toEqual(generated);
      expect(history[0].summary).toEqual(expected);
      await page.reload();
      await expect(overview).toHaveValue(expected.overview);
      await expect(page.locator("#resume-brief")).toHaveValue(expected.brief);
    } finally {
      release.release();
      expect((await request.delete(root)).status()).toBe(200);
    }
  });
}
