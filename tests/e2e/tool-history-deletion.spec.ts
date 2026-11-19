import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

for (const width of [390, 1280]) {
  for (const kind of ["jd", "decoder"] as const) {
    test(`${kind} 列表删除 ${width}px：核对失败锁住删除，确认后保留另一记录和草稿`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const endpoint = `/api/tools/${kind === "jd" ? "jd-portraits" : "jargon-decodings"}`;
      const source = "弹性工作制，协作时段未说明 <T> &amp;";
      // 新生成画像的岗位上限为 30 字；用全宽长标题保留窄屏确认框的换行覆盖。
      const title = kind === "jd" ? "历史画像_".repeat(6) : "History_".repeat(3);
      const reply = kind === "jd" ? {
        role: title, must_skills: [], followups: [], company_style: { style: "信息不足", signals: [] },
      } : {
        target_summary: title, punchline: "核实具体协作安排", overall_risk_score: 40,
        risk_ratings: { overtime: 3, stability: 3, resources: 3, management: 3 }, items: [],
        company_profile: { team_style: "信息不足", risk_flags: [], culture_summary: "待核实具体安排" },
        golden_questions: [],
      };
      const provider = createServer(async (incoming, outgoing) => {
        for await (const chunk of incoming) void chunk;
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing provider address");
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-history-deletion-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const ids: number[] = [];
        for (let index = 0; index < 2; index++) {
          const text = `${source}\n记录${index}`;
          const response = await request.post(endpoint, { data: kind === "jd" ? { jd: text } : { text } });
          expect(response.status(), await response.text()).toBe(201);
          ids.push((await response.json()).id);
        }
        const firstEndpoint = `${endpoint}/${ids[0]}`;
        const secondEndpoint = `${endpoint}/${ids[1]}`;
        const second = await (await request.get(secondEndpoint)).json();
        let deletes = 0;
        let checks = 0;
        let failList = false;
        await page.route(`**${endpoint}**`, async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === firstEndpoint && route.request().method() === "DELETE") {
            deletes++;
            const response = await route.fetch();
            expect(response.status()).toBe(200);
            return route.fulfill({ status: 200, json: { ok: false } });
          }
          if (url.pathname === firstEndpoint && deletes > 0) {
            checks++;
            if (checks === 1) return route.fulfill({ status: 503, json: { error: "合成读取失败" } });
          }
          if (url.pathname === endpoint && failList) return route.fulfill({ status: 503, json: { error: "合成列表刷新失败" } });
          return route.continue();
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/tools/${kind}`);
        const firstLink = page.locator(`a[href="/tools/${kind}/${ids[0]}"]`).filter({ hasText: kind === "jd" ? "查看画像" : "查看报告" });
        const secondLink = page.locator(`a[href="/tools/${kind}/${ids[1]}"]`).filter({ hasText: kind === "jd" ? "查看画像" : "查看报告" });
        const firstCard = firstLink.locator("..").locator("..");
        // 解码列表操作栏的父级就是整行；画像列表多一层页脚。
        const firstDelete = (kind === "jd" ? firstCard.locator("..") : firstCard).getByRole("button", { name: "删除", exact: true });
        const secondCard = secondLink.locator("..").locator("..");
        const secondDelete = (kind === "jd" ? secondCard.locator("..") : secondCard).getByRole("button", { name: "删除", exact: true });
        await expect(firstDelete).toBeVisible();
        const draft = "未提交草稿 <T> &amp;\n只核实条件。";
        const input = page.getByRole("textbox");
        await input.fill(draft);
        await firstDelete.click();
        const dialog = page.getByRole("dialog", { name: "删除历史记录" });
        await expect(dialog).toContainText(`#${ids[0]}「${title}」`);
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        expect(deletes).toBe(0);
        await firstDelete.click();
        await dialog.getByRole("button", { name: "删除", exact: true }).click();
        await expect(page.getByRole("alert").filter({ hasText: "删除结果尚未确认" })).toBeVisible();
        await expect(firstDelete).toBeDisabled();
        await expect(secondDelete).toBeDisabled();
        await expect(input).toHaveValue(draft);
        expect((await request.get(firstEndpoint)).status()).toBe(404);
        expect(await (await request.get(secondEndpoint)).json()).toEqual(second);
        await page.getByRole("button", { name: "重新读取删除状态", exact: true }).scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${kind}-list-delete-unknown-${width}.png`) });
        failList = true;
        await page.getByRole("button", { name: "重新读取删除状态", exact: true }).click();
        await expect(page.getByRole("alert").filter({ hasText: "合成列表刷新失败" })).toBeVisible();
        await expect(page.getByRole("status").filter({ hasText: `已确认记录 #${ids[0]} 不存在` })).toBeVisible();
        await expect(firstLink).toHaveCount(0);
        await expect(input).toHaveValue(draft);
        failList = false;
        await page.getByRole("button", { name: "重试加载", exact: true }).click();
        await expect(secondLink).toBeVisible();
        await expect(secondDelete).toBeEnabled();
        await expect(firstLink).toHaveCount(0);
        expect(deletes).toBe(1);
        expect(checks).toBe(2);
        expect(await (await request.get(secondEndpoint)).json()).toEqual(second);
        await expect(input).toHaveValue(draft);
      } finally {
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
