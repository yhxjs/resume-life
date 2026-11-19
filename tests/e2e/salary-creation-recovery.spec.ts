import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { gate } from "./synthetic-api";

const output = { initial_offer: "模拟开价，保证薪数未确认", hr_response: "模拟 HR：请先核对薪数与奖金", hr_tactics: "核对条件",
  hr_mindset: { looseness: 20, current_attitude: "模拟态度", estimated_package: "模拟方案，待审批", tactics_label: "模拟澄清", internal_pressure: "模拟预算" },
  mentor_analysis: { user_argument_score: 5, strengths: ["已说明期望"], vulnerabilities: ["薪数待确认"], tactical_tips: "先确认保证现金",
    suggested_replies: [{ title: "核对", content: "请确认保证薪数", rationale: "区分保证收入与浮动" }] } };

for (const width of [390, 1280]) {
  for (const mode of ["known-id", "missing-id", "model-error", "refresh", "wrong-id", "receipt-id", "timeout", "storage-replaced", "storage-changed"] as const) {
    test(`谈薪创建 ${width}px：${mode}，锁定快照并核对存档，不自动重建`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
      const pending = gate(); const detailGate = gate(); let calls = 0;
      const storageMode = mode === "storage-replaced" || mode === "storage-changed";
      const provider = createServer(async (incoming, outgoing) => {
        let body = ""; for await (const chunk of incoming) body += chunk;
        const call = ++calls;
        if (call === 2) await pending.promise;
        const reply = call === 2 && mode === "model-error" ? { initial_offer: "缺少评估的开局不能入库" } : output;
        if (JSON.parse(body).stream) {
          outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
          outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
        } else {
          outgoing.writeHead(200, { "Content-Type": "application/json" });
          outgoing.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(reply) } }] }));
        }
      });
      await listenForFetch(provider);
      const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
      try {
        expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-salary-creation-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic" } })).ok()).toBe(true);
        const endpoint = "/api/tools/salary-negotiations";
        const role = "Role_".repeat(24) + "仅负责接口校验";
        const tier = "Company_".repeat(15) + "具体预算未知";
        const salary = "税前 CNY 30k，保证薪数与奖金均未确认";
        const offer = "Offer_".repeat(25) + " <T> &amp;\n只是口头询价，没有书面承诺";
        const background = { target_company_tier: tier, target_role: role, expected_salary: salary, current_or_competing_offer: offer, hr_style: "pressure" };
        const seed = await request.post(endpoint, { data: mode === "wrong-id" ? background : { target_role: "另一份演练", expected_salary: "20k，薪数待确认" } });
        expect(seed.status()).toBe(201); const otherId = (await seed.json()).id;
        const other = await (await request.get(`${endpoint}/${otherId}`)).json();
        const before = await (await request.get(endpoint)).json();
        let posts = 0; let savedId = 0; let detailReads = 0; let historyReads = 0; let requestId = ""; let receiptReads = 0; let otherReads = 0;
        let originalRecovery = ""; let changedRecovery = "";
        await page.route(`**${endpoint}**`, async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path === endpoint && route.request().method() === "POST") {
            posts++;
            requestId = route.request().headers()["idempotency-key"]!;
            expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
            expect(route.request().postDataJSON()).toEqual({ target_company_tier: tier, target_role: role, expected_salary: salary, current_or_competing_offer: offer, hr_style: "pressure" });
            const response = await route.fetch();
            if (response.status() === 201) {
              savedId = (await response.json()).id;
              if (mode === "timeout") return route.fulfill({ status: 408, json: { error: "合成超时，服务端实际已保存" } });
              if (mode === "missing-id" || mode === "refresh") return route.fulfill({ status: 201, json: { id: "lost-id" } });
              if (mode === "wrong-id" || mode === "receipt-id") return route.fulfill({ status: 201, json: { id: otherId } });
            }
            return route.fulfill({ response });
          }
          if (path === `${endpoint}/requests/${requestId}`) {
            const read = ++receiptReads;
            if (mode === "refresh") {
              if (read === 1) return route.fulfill({ status: 503, json: { error: "合成请求回执读取失败" } });
              if (read === 2) return route.fulfill({ json: { request_id: randomUUID(), status: "succeeded", id: otherId } });
              if (read === 3) return route.fulfill({ json: { request_id: requestId, status: "pending" } });
            }
            if (mode === "receipt-id" && read === 1) return route.fulfill({ json: { request_id: requestId, status: "succeeded", id: otherId } });
          }
          if (path === endpoint && posts > 0 && mode !== "known-id") {
            historyReads++;
            if (historyReads === 1) return route.fulfill({ status: 503, json: { error: "合成历史读取失败" } });
          }
          if (savedId && path === `${endpoint}/${savedId}` && mode === "known-id") {
            const read = ++detailReads;
            if (read === 1) return route.fulfill({ status: 503, json: { error: "合成创建详情读取失败" } });
            if (read === 2) return route.fulfill({ json: other });
          }
          if (savedId && path === `${endpoint}/${savedId}` && storageMode) {
            if (++detailReads === 1) {
              const response = await route.fetch();
              await detailGate.promise;
              return route.fulfill({ response });
            }
          }
          if (path === `${endpoint}/${otherId}`) otherReads++;
          return route.continue();
        });
        await page.setViewportSize({ width, height: 900 }); await page.goto("/tools/salary");
        await page.getByRole("button", { name: /^自定义企业/ }).click();
        const company = page.getByRole("textbox", { name: "自定义公司类型或特点", exact: true });
        const target = page.getByRole("textbox", { name: "目标岗位与职级（必填）", exact: true });
        const expected = page.getByRole("textbox", { name: "期望薪资目标（必填）", exact: true });
        const competing = page.getByRole("textbox", { name: "已有竞品 Offer 或当前薪资（谈判底牌 / 筹码）", exact: true });
        await company.fill(`  ${tier}  `); await target.fill(`  ${role}  `); await expected.fill(`  ${salary}  `); await competing.fill(`  ${offer}\n `);
        await page.getByText("施压挑刺型", { exact: true }).click();
        await expect(page.getByRole("radio", { name: "施压挑刺型", exact: true })).toBeChecked();
        await page.getByRole("button", { name: "开局！进入薪资博弈对决", exact: true }).click();
        await expect.poll(() => calls).toBe(2);
        for (const field of [company, target, expected, competing]) await expect(field).toBeDisabled();
        await expect(target).toHaveValue(`  ${role}  `); await expect(competing).toHaveValue(`  ${offer}\n `);
        await expect(page.getByRole("radio", { name: "职业规范型", exact: true })).toBeDisabled();
        await expect(page.getByRole("group", { name: `谈薪演练 #${otherId}`, exact: true }).getByRole("button", { name: "删除", exact: true })).toBeDisabled();
        expect(posts).toBe(1); pending.release();
        if (storageMode) {
          await expect.poll(() => detailReads).toBe(1);
          originalRecovery = await page.evaluate(() => sessionStorage.getItem("resume-life:salary-creation:v1")!);
          changedRecovery = await page.evaluate(({ replaced, requestId }) => {
            const key = "resume-life:salary-creation:v1";
            const value = JSON.parse(sessionStorage.getItem(key)!);
            if (replaced) value.requestId = requestId;
            else value.snapshot.current_or_competing_offer += " 新稿尚未提交，必须保留";
            const raw = JSON.stringify(value); sessionStorage.setItem(key, raw); return raw;
          }, { replaced: mode === "storage-replaced", requestId: randomUUID() });
          detailGate.release();
        }
        const feedback = page.getByRole("alert", { name: "谈薪创建状态", exact: true });
        await expect(feedback).toContainText("创建结果尚未确认"); await expect(page).toHaveURL(/\/tools\/salary$/);
        if (storageMode) {
          await expect(feedback).toContainText("创建恢复信息已改变");
          await expect(target).toBeDisabled(); expect(posts).toBe(1); expect(calls).toBe(2);
          expect(await page.evaluate(() => sessionStorage.getItem("resume-life:salary-creation:v1"))).toBe(changedRecovery);
          await page.getByRole("button", { name: "核对历史后另建演练", exact: true }).click();
          const allow = page.getByRole("button", { name: "已核对历史，允许再次创建", exact: true });
          await expect(allow).toBeDisabled();
          await expect(page.getByRole("alert").filter({ hasText: "谈判历史加载失败" })).toBeVisible();
          await page.getByRole("button", { name: "重试加载", exact: true }).click(); await expect(allow).toBeEnabled();
          await allow.click(); await expect(feedback).toContainText("无法移除创建恢复信息");
          await expect(target).toBeDisabled();
          await expect(page.getByRole("button", { name: "开局！进入薪资博弈对决", exact: true })).toBeDisabled();
          expect(await page.evaluate(() => sessionStorage.getItem("resume-life:salary-creation:v1"))).toBe(changedRecovery);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await feedback.scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath(`salary-create-${mode}-${width}.png`) });
          // 恢复原命令记录后仅主动读取；不以旧结果覆盖被替换的暂存。
          await page.evaluate(raw => sessionStorage.setItem("resume-life:salary-creation:v1", raw), originalRecovery);
          await page.getByRole("button", { name: "按请求编号核对结果", exact: true }).click();
        } else if (mode === "timeout") {
          await expect(feedback).toContainText("仍可能已经保存");
          for (const field of [company, target, expected, competing]) await expect(field).toBeDisabled();
          const storedRequest = await page.evaluate(() => JSON.parse(sessionStorage.getItem("resume-life:salary-creation:v1")!));
          expect(storedRequest.requestId).toBe(requestId); expect(storedRequest.snapshot).toEqual(background);
          expect(savedId).toBeGreaterThan(0); expect(receiptReads).toBe(0);
          await page.reload();
          await expect(feedback).toContainText("已恢复上次创建请求");
          await expect(company).toHaveValue(tier); await expect(target).toHaveValue(role);
          await expect(expected).toHaveValue(salary); await expect(competing).toHaveValue(offer);
          await expect(page.getByRole("radio", { name: "施压挑刺型", exact: true })).toBeChecked();
          await expect(target).toBeDisabled();
          expect(posts).toBe(1); expect(calls).toBe(2); expect(receiptReads).toBe(0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await feedback.scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath(`salary-create-timeout-${width}.png`) });
          const retry = page.getByRole("button", { name: "重新读取创建结果", exact: true });
          await retry.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
        } else if (mode === "refresh") {
          const replay = await request.post(endpoint, { headers: { "Idempotency-Key": requestId }, data: {
            target_company_tier: tier, target_role: role, expected_salary: salary, current_or_competing_offer: offer, hr_style: "pressure",
          } });
          expect(replay.status()).toBe(200); expect(await replay.json()).toEqual({ id: savedId });
          expect((await request.post(endpoint, { headers: { "Idempotency-Key": requestId }, data: {
            target_company_tier: tier, target_role: "不同岗位不能复用编号", expected_salary: salary, current_or_competing_offer: offer, hr_style: "pressure",
          } })).status()).toBe(409);
          expect(calls).toBe(2);
          await page.reload(); await expect(feedback).toContainText("已恢复上次创建请求");
          await expect(company).toHaveValue(tier); await expect(target).toHaveValue(role); await expect(expected).toHaveValue(salary); await expect(competing).toHaveValue(offer);
          await expect(target).toBeDisabled(); expect(posts).toBe(1);
          const retry = page.getByRole("button", { name: "重新读取创建结果", exact: true });
          for (const message of ["合成请求回执读取失败", "创建请求回执编号不符", "仍在处理中"]) {
            await retry.click(); await expect(feedback).toContainText(message); expect(posts).toBe(1); expect(calls).toBe(2);
          }
          await page.screenshot({ path: testInfo.outputPath(`salary-create-refresh-${width}.png`), fullPage: true });
          await retry.click();
        } else if (mode === "wrong-id" || mode === "receipt-id") {
          await expect(feedback).toContainText(mode === "wrong-id" ? "创建响应与请求回执记录不符" : "背景不符");
          expect(receiptReads).toBe(1); expect(otherReads).toBe(mode === "receipt-id" ? 1 : 0);
          await expect(target).toBeDisabled(); await expect(competing).toHaveValue(`  ${offer}\n `);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`salary-create-${mode}-${width}.png`), fullPage: true });
          await page.getByRole("button", { name: "重新读取创建结果", exact: true }).click();
        } else if (mode === "known-id") {
          const retry = page.getByRole("button", { name: "重新读取创建结果", exact: true });
          await retry.click(); await expect(feedback).toContainText("历史记录结构异常");
          expect(posts).toBe(1); expect(calls).toBe(2); await expect(target).toBeDisabled();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`salary-create-check-${width}.png`), fullPage: true });
          await retry.click();
        } else {
          const acknowledge = page.getByRole("button", { name: "已核对历史，允许再次创建", exact: true });
          await expect(acknowledge).toBeDisabled(); await expect(page.getByRole("alert").filter({ hasText: "谈判历史加载失败" })).toBeVisible();
          await page.getByRole("button", { name: "重试加载", exact: true }).click(); await expect(acknowledge).toBeEnabled();
          await expect(page.getByRole("button", { name: "开局！进入薪资博弈对决", exact: true })).toBeDisabled();
          expect(posts).toBe(1); expect(calls).toBe(2); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`salary-create-review-${width}-${mode}.png`), fullPage: true });
          if (mode === "missing-id") {
            await page.getByRole("group", { name: `谈薪演练 #${savedId}`, exact: true }).getByRole("link", { name: "继续谈判", exact: true }).click();
          } else {
            expect((await (await request.get(endpoint)).json()).total).toBe(before.total);
            await acknowledge.click(); await expect(target).toBeEnabled(); await expect(competing).toHaveValue(`  ${offer}\n `);
            await page.getByRole("button", { name: "开局！进入薪资博弈对决", exact: true }).click();
            await expect.poll(() => savedId).toBeGreaterThan(0);
          }
        }
        await expect(page).toHaveURL(new RegExp(`/tools/salary/${savedId}$`));
        const stored = await (await request.get(`${endpoint}/${savedId}`)).json();
        expect(stored).toMatchObject({ target_company_tier: tier, target_role: role, expected_salary: salary, current_or_competing_offer: offer, hr_style: "pressure" });
        expect(stored.turns).toHaveLength(1); expect(stored.turns[0]).toMatchObject({ turn_no: 1, user_message: "", mentor_analysis: { user_argument_score: 5 } });
        expect((await (await request.get(endpoint)).json()).total).toBe(before.total + 1);
        expect(await (await request.get(`${endpoint}/${otherId}`)).json()).toEqual(other);
        expect(posts).toBe(mode === "model-error" ? 2 : 1); expect(calls).toBe(mode === "model-error" ? 3 : 2);
        if (mode === "wrong-id" || mode === "receipt-id") { expect(receiptReads).toBe(2); expect(otherReads).toBe(mode === "receipt-id" ? 1 : 0); }
        if (mode === "timeout") {
          expect(receiptReads).toBe(1);
          expect(await page.evaluate(() => sessionStorage.getItem("resume-life:salary-creation:v1"))).toBeNull();
        }
        if (storageMode) {
          expect(receiptReads).toBe(2);
          expect(await page.evaluate(() => sessionStorage.getItem("resume-life:salary-creation:v1"))).toBeNull();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } finally {
        pending.release(); detailGate.release(); provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
