import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { gate } from "./synthetic-api";
import { PRESET_REMEDIES } from "../../src/lib/career-gap-remedy";

const endpoint = "/api/tools/career-gap-remedies";
const report = {
  title: "Gap_".repeat(10), punchline: "只按真实经历说明休整，未知安排保留待补充。",
  hr_mindset_analysis: { core_concerns: [], risk_points: [], what_hr_wants_to_hear: "没有材料证明真实招聘方心理。" },
  reframe_formula: { fact_acknowledgment: "休整两个月", positive_attribution: "个人选择休息", growth_and_value: "没有学习或项目", motivation_alignment: "真实岗位方向待补充" },
  scripts: {
    concise: { label: "精炼说明", applicable_scene: "初步沟通", script: "我休整了两个月，没有学习或项目；到岗时间尚未确认。", key_points: ["只说明事实"] },
    detailed: { label: "详细说明", applicable_scene: "进一步沟通", script: "两个月用于休息，没有学习或项目。<T> &amp;\n到岗时间尚未确认。", key_points: ["保留未知"] },
    pivoting: { label: "岗位衔接", applicable_scene: "讨论岗位", script: "可以继续沟通 C++ / C# 岗位职责；未承诺到岗时间。", key_points: ["不虚构承诺"] },
  },
  drills: [{ question: "哪些安排已确定？", hr_concern: "可能核实岗位相关时间安排", best_response: "到岗时间尚未确认。" }],
  forbidden_list: ["不虚构学习与项目"], closing_tips: ["保留未知和隐私边界"],
};
const originalStory = "  我休整了两个月，没有学习或项目。<T> &amp;\n到岗时间尚未确认。  ";
const originalRole = "Role_".repeat(40) + " C++ / C# <T>";

for (const width of [390, 1280]) {
  for (const loseResponse of [false, true]) {
    test(`空窗入口 ${width}px：等待保护四项材料，${loseResponse ? "已保存但完成 ID 损坏后核对历史" : "无效模型输出零存档后显式重试"}`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
      const release = gate(); let calls = 0;
      const provider = createServer(async (incoming, outgoing) => {
        for await (const chunk of incoming) void chunk;
        const current = ++calls; if (current === 1) await release.promise;
        const reply = !loseResponse && current === 1 ? { title: "不应保存的残缺方案" } : report;
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
      });
      await listenForFetch(provider);
      const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
      try {
        expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-gap-entry-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic" } })).ok()).toBe(true);
        const before = await (await request.get(endpoint)).json(); let writes = 0; let savedId = 0;
        await page.route(`**${endpoint}`, async route => {
          if (route.request().method() !== "POST") return route.continue();
          writes++;
          expect(route.request().postDataJSON()).toEqual({ scenarioType: "gap", rawStory: originalStory.trim(), targetRole: originalRole, personaStyle: "composed" });
          const response = await route.fetch();
          if (response.status() === 201) { savedId = (await response.json()).id; if (loseResponse) return route.fulfill({ status: 201, json: { id: "invalid" } }); }
          return route.fulfill({ response });
        });
        await page.setViewportSize({ width, height: 900 }); await page.goto("/tools/gap");
        await page.getByRole("button", { name: new RegExp(PRESET_REMEDIES[0]!.title) }).click();
        const input = page.getByRole("textbox", { name: "真实经历与希望说明的问题", exact: true });
        const role = page.getByRole("textbox", { name: "目标应聘岗位 / 业务方向（选填）", exact: true });
        await input.fill(originalStory); await role.fill(`  ${originalRole}  `);
        await page.getByRole("group", { name: "沟通场景", exact: true }).getByRole("button", { name: /仅空窗期 Gap/ }).click();
        await page.getByRole("group", { name: "表达风格（仅调整语气与组织）", exact: true }).getByRole("button", { name: /从容睿智型/ }).click();
        await page.getByRole("button", { name: "生成沟通方案 →", exact: true }).click();
        await expect.poll(() => calls).toBe(1); await expect(input).toBeDisabled(); await expect(role).toBeDisabled();
        await expect(input).toHaveValue(originalStory); await expect(role).toHaveValue(`  ${originalRole}  `);
        for (const name of ["加班内耗", "休整学习4个月", "业务被裁+待业", "清空内容", "+ 填入示例后修改"]) {
          await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
        }
        for (const name of ["沟通场景", "表达风格（仅调整语气与组织）"]) {
          for (const button of await page.getByRole("group", { name, exact: true }).getByRole("button").all()) await expect(button).toBeDisabled();
        }
        await expect(page.getByRole("button", { name: /仅空窗期 Gap/ })).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByRole("button", { name: /从容睿智型/ })).toHaveAttribute("aria-pressed", "true");
        expect(writes).toBe(1);
        const waiting = page.getByRole("status").filter({ hasText: "正在整理沟通方案" }); await waiting.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`gap-generation-wait-${loseResponse}-${width}.png`) });
        release.release();
        const error = page.getByRole("alert", { name: "空窗方案生成状态", exact: true });
        await expect(error).toContainText(loseResponse ? "生成响应不完整" : "沟通方案解析失败");
        await expect(error).toContainText("核对历史记录"); await expect(input).toHaveValue(originalStory); await expect(input).toBeEnabled();
        if (loseResponse) {
          const history = page.getByRole("group", { name: `空窗沟通报告 #${savedId}`, exact: true });
          await expect(history).toContainText(originalRole); await expect(history).toContainText(report.title);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await error.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`gap-generation-history-${width}.png`) });
          await history.getByRole("link", { name: "查看报告", exact: true }).click();
        } else {
          expect(await (await request.get(endpoint)).json()).toEqual(before);
          await page.getByRole("button", { name: "生成沟通方案 →", exact: true }).click();
        }
        await expect.poll(() => savedId).toBeGreaterThan(0); await expect(page).toHaveURL(new RegExp(`/tools/gap/${savedId}$`));
        await expect(page.getByRole("heading", { level: 1 })).toContainText(report.title);
        const stored = await (await request.get(`${endpoint}/${savedId}`)).json();
        expect(stored).toMatchObject({ raw_story: originalStory.trim(), target_role: originalRole, scenario_type: "gap", persona_style: "composed" });
        expect(stored.result.scripts.detailed.script).toBe(report.scripts.detailed.script);
        await page.getByText("查看您输入的原始经历与痛点", { exact: true }).click();
        await expect(page.getByRole("region", { name: "原始经历", exact: true })).toHaveText(originalStory.trim());
        expect(writes).toBe(loseResponse ? 1 : 2); expect(calls).toBe(loseResponse ? 1 : 2);
      } finally {
        release.release(); provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }

  test(`空窗列表删除 ${width}px：取消零写入，实际删除后坏响应与串记录只能只读核对，旧列表不能复活`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    let calls = 0;
    const provider = createServer(async (incoming, outgoing) => {
      for await (const chunk of incoming) void chunk; calls++;
      outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(report) } }] })}\n\ndata: [DONE]\n\n`);
    });
    await listenForFetch(provider);
    const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
    try {
      expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-gap-delete-key",
        api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic" } })).ok()).toBe(true);
      const ids: number[] = [];
      for (let index = 0; index < 2; index++) {
        const response = await request.post(endpoint, { data: { rawStory: `${originalStory}\n${index}`, targetRole: originalRole, scenarioType: "gap" } });
        expect(response.status(), await response.text()).toBe(201); ids.push((await response.json()).id);
      }
      const savedList = await (await request.get(endpoint)).json();
      const second = await (await request.get(`${endpoint}/${ids[1]}`)).json();
      let deletes = 0; let checks = 0; let writes = 0; let failList = false; let staleList = false;
      await page.route(`**${endpoint}**`, async route => {
        const url = new URL(route.request().url()); const method = route.request().method();
        if (method === "POST") writes++;
        if (url.pathname === `${endpoint}/${ids[0]}` && method === "DELETE") {
          deletes++; const response = await route.fetch(); expect(response.status()).toBe(200);
          return route.fulfill({ status: 200, json: { ok: false } });
        }
        if (url.pathname === `${endpoint}/${ids[0]}` && method === "GET" && deletes > 0) {
          checks++;
          if (checks === 1) return route.fulfill({ status: 503, json: { error: "合成核对失败" } });
          if (checks === 2) return route.fulfill({ json: second });
        }
        if (url.pathname === endpoint && method === "GET") {
          if (failList) return route.fulfill({ status: 503, json: { error: "合成列表失败" } });
          if (staleList) return route.fulfill({ json: savedList });
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/tools/gap");
      const first = page.getByRole("group", { name: `空窗沟通报告 #${ids[0]}`, exact: true });
      const other = page.getByRole("group", { name: `空窗沟通报告 #${ids[1]}`, exact: true });
      const draft = "未提交经历 <T> &amp;\n暂不披露家庭细节";
      const input = page.getByRole("textbox", { name: "真实经历与希望说明的问题", exact: true }); await input.fill(draft);
      await first.getByRole("button", { name: "删除", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "删除历史记录" });
      await expect(dialog).toContainText(`#${ids[0]}「${report.title}」`);
      await expect(page.getByRole("button", { name: "生成沟通方案 →", exact: true })).toBeDisabled();
      await dialog.getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(0);
      await first.getByRole("button", { name: "删除", exact: true }).click(); await dialog.getByRole("button", { name: "删除", exact: true }).click();
      const error = page.getByRole("alert").filter({ hasText: "删除结果尚未确认" }); await expect(error).toContainText("合成核对失败");
      await expect(first.getByRole("button", { name: "删除", exact: true })).toBeDisabled();
      await expect(other.getByRole("button", { name: "删除", exact: true })).toBeDisabled(); await expect(input).toHaveValue(draft);
      await page.getByRole("button", { name: "重新读取删除状态", exact: true }).click(); await expect(error).toContainText("记录不符");
      expect((await request.get(`${endpoint}/${ids[0]}`)).status()).toBe(404);
      expect(await (await request.get(`${endpoint}/${ids[1]}`)).json()).toEqual(second);
      await error.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`gap-delete-unknown-${width}.png`) });
      failList = true; await page.getByRole("button", { name: "重新读取删除状态", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "合成列表失败" })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: `已确认记录 #${ids[0]} 不存在` })).toBeVisible(); await expect(first).toHaveCount(0);
      failList = false; staleList = true; await page.getByRole("button", { name: "重试加载", exact: true }).click();
      await expect(other).toBeVisible(); await expect(first).toHaveCount(0); await expect(other.getByRole("button", { name: "删除", exact: true })).toBeEnabled();
      expect(deletes).toBe(1); expect(checks).toBe(3); expect(writes).toBe(0); expect(calls).toBe(2);
      await expect(input).toHaveValue(draft); expect(await (await request.get(`${endpoint}/${ids[1]}`)).json()).toEqual(second);
    } finally {
      provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
