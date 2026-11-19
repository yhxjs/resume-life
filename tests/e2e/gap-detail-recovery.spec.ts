import { expect, test } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import type { RowRecord } from "../../src/lib/backup-records";

const root = "/api/tools/career-gap-remedies";
const rawStory = "Original_".repeat(35) + " <T> &amp;\n休整两个月，没有学习或项目；到岗时间未确认。";
const role = "Role_".repeat(45) + " C++ / C# <T> &amp;";
const script = { label: "历史详细版本", applicableScene: "核对后练习", script: "History_".repeat(140) + " <T> &amp;\n未确认到岗，不虚构项目。", keyPoints: Array.from({ length: 9 }, (_, index) => `历史限定_${index}`) };
const result = {
  title: "LongHistory_".repeat(10), punchline: "只按真实经历说明休整，不补写学习成果或到岗承诺。",
  hrMindsetAnalysis: { coreConcerns: [], riskPoints: [], whatHrWantsToHear: "只说明岗位相关安排，未知条件保留待核实。" },
  reframeFormula: { factAcknowledgment: "休整两个月", positiveAttribution: "个人选择休息", growthAndValue: "没有学习或项目", motivationAlignment: "尚未确认" },
  scripts: { concise: { ...script, script: " \n " }, detailed: script, pivoting: { ...script, script: "" } },
  drills: [{ question: "旧报告缺少回答的追问", hrConcern: "原关注点", bestResponse: " \n " },
    { question: "到岗时间何时确定？", hrConcern: "可能核实岗位相关安排", bestResponse: "<T> &amp;\n到岗时间尚未确认。" }],
  forbiddenList: ["不补写学习或项目"], closingTips: Array.from({ length: 8 }, (_, index) => `保留历史建议_${index}`),
};

for (const width of [390, 1280]) {
  for (const { removed, timeout } of [true, false].flatMap(removed => [false, true].map(timeout => ({ removed, timeout })))) {
    test(`空窗详情 ${width}px：长历史原稿与空白复制边界，${removed ? "真实删除" : "未执行删除"}，${timeout ? "408 超时" : "异常响应"}后核对`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
      let firstId = 0; const expectedRows: RowRecord[] = [];
      const seeded = await rewriteEncryptedBackup(baseline.bytes, records => {
        firstId = Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === "resignation_gap_remedies" ? [Number(row.data.id)] : [])) + 1;
        for (let index = 0; index < 2; index++) {
          const row: RowRecord = { kind: "row", table: "resignation_gap_remedies", data: {
            id: firstId + index, scenario_type: "gap", raw_story: `${rawStory}\n报告${index}`, target_role: role, persona_style: "composed",
            result: JSON.stringify({ ...result, title: `${result.title}_${index}` }), created_at: "2026-10-29T00:00:00.000Z",
          } };
          records.splice(records.findIndex(entry => entry.kind === "end"), 0, row); expectedRows.push(structuredClone(row));
        }
        const manifest = records.find(entry => entry.kind === "manifest"); const end = records.find(entry => entry.kind === "end");
        if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
        end.stats = Object.fromEntries(manifest.tables.map(table => [table, records.filter(row => row.kind === "row" && row.table === table).length]));
        end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
        manifest.sequences = { ...manifest.sequences, resignation_gap_remedies: firstId + 1 };
      });
      try {
        const restored = await postEncryptedBackup(request, "/api/backup/restore", seeded); expect(restored.status(), await restored.text()).toBe(200);
        const endpoint = `${root}/${firstId}`; const otherEndpoint = `${root}/${firstId + 1}`;
        const other = await (await request.get(otherEndpoint)).json(); let deletes = 0; let checks = 0; let posts = 0;
        page.on("request", incoming => { if (new URL(incoming.url()).pathname === root && incoming.method() === "POST") posts++; });
        await page.route(`**${endpoint}`, async route => {
          if (route.request().method() === "DELETE") {
            deletes++;
            if (!removed && deletes === 1) return route.fulfill({ status: timeout ? 408 : 200, json: timeout ? { error: "合成删除等待超时" } : { ok: false } });
            const response = await route.fetch(); expect(response.status()).toBe(200);
            if (removed) return timeout ? route.fulfill({ status: 408, json: { error: "合成删除已执行，等待超时" } }) : route.fulfill({ status: 200, body: "{broken" });
            return route.fulfill({ response });
          }
          if (deletes > 0) {
            checks++;
            if (checks === 1) return route.fulfill({ status: 503, json: { error: "合成核对读取失败" } });
            if (checks === 2) return route.fulfill({ json: other });
          }
          return route.continue();
        });
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.setViewportSize({ width, height: 900 }); await page.goto(`/tools/gap/${firstId}`);
        await expect(page.getByRole("heading", { level: 1 })).toContainText(`${result.title}_0`);
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        await page.getByText("查看您输入的原始经历与痛点", { exact: true }).click();
        expect(await page.getByRole("region", { name: "原始经历", exact: true }).textContent()).toBe(`${rawStory}\n报告0`);
        expect(await page.getByRole("region", { name: "当前话术原文", exact: true }).textContent()).toBe(`“${script.script}”`);
        const roleLabel = page.getByText("📌 目标岗位：", { exact: true });
        await expect(roleLabel.locator("..")).toContainText(role);
        const labelSize = await roleLabel.evaluate(element => ({ height: element.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight) }));
        expect(labelSize.height).toBeLessThanOrEqual(labelSize.lineHeight + 1);
        await roleLabel.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`gap-detail-metadata-${removed}-${width}.png`) });
        await expect(page.getByText("历史限定_8", { exact: true })).toBeVisible();
        await expect(page.getByText("保留历史建议_7", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: /一键复制此话术/ }).click();
        await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"))).toBe(script.script);
        const replies = page.getByRole("button", { name: "复制", exact: true }); await expect(replies).toHaveCount(2);
        await expect(replies.first()).toBeDisabled();
        await expect(page.getByText(/此追问未保存回答参考/)).toBeVisible();
        await replies.last().click();
        await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"))).toBe(result.drills[1]!.bestResponse);
        expect(deletes).toBe(0); expect(posts).toBe(0);
        const exported = await exportEncryptedBackup(request); expect(exported.response.ok()).toBe(true);
        await rewriteEncryptedBackup(exported.bytes, records => {
          const stored = records.filter(row => row.kind === "row" && row.table === "resignation_gap_remedies" && expectedRows.some(expected => expected.data.id === row.data.id));
          expect(stored).toEqual(expectedRows);
        });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: testInfo.outputPath(`gap-detail-history-${removed}-${width}.png`) });
        const remove = page.getByRole("button", { name: "删除报告", exact: true }); await remove.click();
        const dialog = page.getByRole("dialog", { name: "删除报告", exact: true });
        await expect(dialog).toContainText(`#${firstId}「${result.title}_0」`);
        await dialog.getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(0);
        await page.getByRole("button", { name: "删除本份报告", exact: true }).click(); await dialog.getByRole("button", { name: "删除", exact: true }).click();
        const error = page.getByRole("alert").filter({ hasText: "删除结果尚未确认" }); await expect(error).toContainText("合成核对读取失败");
        for (const name of ["删除报告", "删除本份报告"]) await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
        await page.getByRole("button", { name: "重新读取删除状态", exact: true }).click(); await expect(error).toContainText("记录不符");
        await expect(page).toHaveURL(new RegExp(`/tools/gap/${firstId}$`)); expect(deletes).toBe(1);
        expect((await request.get(endpoint)).status()).toBe(removed ? 404 : 200);
        expect(await (await request.get(otherEndpoint)).json()).toEqual(other);
        await error.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`gap-detail-delete-unknown-${removed}-${width}.png`) });
        await page.getByRole("button", { name: "重新读取删除状态", exact: true }).click();
        if (!removed) {
          await expect(page.getByRole("alert").filter({ hasText: "记录目前仍存在" })).toBeVisible(); await expect(remove).toBeEnabled();
          expect(await page.getByRole("region", { name: "原始经历", exact: true }).textContent()).toBe(`${rawStory}\n报告0`);
          await remove.click(); await dialog.getByRole("button", { name: "删除", exact: true }).click();
        }
        await expect(page).toHaveURL(/\/tools\/gap$/); expect(deletes).toBe(removed ? 1 : 2); expect(checks).toBe(3); expect(posts).toBe(0);
        expect((await request.get(endpoint)).status()).toBe(404); expect(await (await request.get(otherEndpoint)).json()).toEqual(other);
      } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
    });
  }

  test(`空窗详情 ${width}px：初始串记录不展示原稿或开放删除，只读重试后恢复`, async ({ page, request }) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const seeded = await rewriteEncryptedBackup(baseline.bytes, records => {
      const old = records.filter(row => row.kind === "row" && row.table === "resignation_gap_remedies");
      for (const row of old) records.splice(records.indexOf(row), 1);
      records.splice(records.findIndex(entry => entry.kind === "end"), 0, { kind: "row", table: "resignation_gap_remedies", data: {
        id: 9012, scenario_type: "gap", raw_story: rawStory, target_role: role, persona_style: "composed", result: JSON.stringify(result), created_at: "2026-10-29T00:00:00.000Z",
      } });
      const manifest = records.find(entry => entry.kind === "manifest"); const end = records.find(entry => entry.kind === "end");
      if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
      end.stats.resignation_gap_remedies = 1; end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
      manifest.sequences = { ...manifest.sequences, resignation_gap_remedies: 9012 };
    });
    try {
      const restored = await postEncryptedBackup(request, "/api/backup/restore", seeded); expect(restored.status(), await restored.text()).toBe(200);
      let reads = 0; let writes = 0;
      await page.route(`**${root}/9012`, async route => {
        if (route.request().method() !== "GET") { writes++; return route.continue(); }
        reads++; const response = await route.fetch();
        if (reads === 1) return route.fulfill({ json: { ...await response.json(), id: 9013 } });
        return route.fulfill({ response });
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/tools/gap/9012");
      await expect(page.getByRole("main").getByRole("alert")).toContainText("报告响应不完整或记录不符");
      await expect(page.getByRole("button", { name: "删除报告", exact: true })).toHaveCount(0);
      await expect(page.getByText("查看您输入的原始经历与痛点", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "重试加载", exact: true }).click(); await expect(page.getByText("报告 #9012", { exact: true })).toBeVisible();
      expect(reads).toBe(2); expect(writes).toBe(0);
      expect((await (await request.get(`${root}/9012`)).json()).raw_story).toBe(rawStory);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });
}
