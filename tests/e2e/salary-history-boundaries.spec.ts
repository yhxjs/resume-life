import { expect, test } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import type { RowRecord } from "../../src/lib/backup-records";

const condition = "Condition_".repeat(24) + " <T> &amp;\n奖金需审批，尚未书面确认。";
const timestamp = "2026-10-29T00:00:00.000Z";

for (const width of [390, 1280]) {
  test(`谈薪历史 ${width}px：完整条件与小数评分回读，旧空对象不生成默认评价`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    let firstId = 0;
    let expectedRows: RowRecord[] = [];
    const mindset = { looseness: 20.5, current_attitude: `历史态势：${condition}`, estimated_package: `历史模拟方案：${condition}`, tactics_label: "历史标签", internal_pressure: condition };
    const mentor = { user_argument_score: 7.5, strengths: Array.from({ length: 6 }, (_, i) => `历史观察${i}：${condition}`), vulnerabilities: [], tactical_tips: condition,
      suggested_replies: Array.from({ length: 4 }, (_, i) => ({ title: `历史方案_${i}`, content: `历史回复_${i}：${condition}`, rationale: condition })) };
    const report = { final_package_summary: "旧结果：尚未达成，奖金与薪数需核实。", score: 70.5, persuasion_grade: "A", leverage_efficiency: "",
      mentor_summary: condition, turn_critiques: [{ turn_no: 4, gain_or_loss: "neutral", summary: `原点评：${condition}`, key_point: `原要点：${condition}` }],
      real_world_tips: Array.from({ length: 7 }, (_, i) => `历史建议_${i}：${condition}`) };
    const seeded = await rewriteEncryptedBackup(baseline.bytes, (records) => {
      const nextId = (table: string) => Math.max(0, ...records.flatMap((row) => row.kind === "row" && row.table === table ? [Number(row.data.id)] : [])) + 1;
      firstId = nextId("salary_negotiations");
      const firstTurn = nextId("salary_negotiation_turns");
      const add = (table: string, data: Record<string, unknown>) => {
        const row: RowRecord = { kind: "row", table, data };
        records.splice(records.findIndex((entry) => entry.kind === "end"), 0, row); expectedRows.push(structuredClone(row));
      };
      for (let index = 0; index < 3; index++) {
        const finished = index === 1;
        add("salary_negotiations", { id: firstId + index, target_company_tier: "custom", target_role: `历史条件核对_${index}`, expected_salary: "税前 CNY 30k，薪数未确认",
          current_or_competing_offer: `完整筹码：${condition}`, hr_style: "standard", status: finished ? "finished" : "ongoing", initial_offer: "模拟初始报价，未承诺",
          final_package: finished ? "只认可月薪，奖金需审批" : "", report: finished ? JSON.stringify(report) : "", created_at: timestamp, finished_at: finished ? timestamp : "" });
        add("salary_negotiation_turns", { id: firstTurn + index, negotiation_id: firstId + index, turn_no: 4, user_message: `历史原答_${index}：${condition}`,
          hr_response: `历史回应_${index}：${condition}`, hr_tactics: "原始策略", hr_mindset: JSON.stringify(index === 2 ? {} : mindset),
          mentor_analysis: JSON.stringify(index === 2 ? {} : mentor), created_at: timestamp });
      }
      const manifest = records.find((entry) => entry.kind === "manifest"); const end = records.find((entry) => entry.kind === "end");
      if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
      end.stats = Object.fromEntries(manifest.tables.map((table) => [table, records.filter((entry) => entry.kind === "row" && entry.table === table).length]));
      end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
      manifest.sequences = { ...manifest.sequences, salary_negotiations: firstId + 2, salary_negotiation_turns: firstTurn + 2 };
    });
    try {
      const restored = await postEncryptedBackup(request, "/api/backup/restore", seeded);
      expect(restored.status(), await restored.text()).toBe(200);
      let writes = 0;
      page.on("request", (incoming) => { if (new URL(incoming.url()).pathname.startsWith("/api/tools/salary-negotiations") && incoming.method() !== "GET") writes++; });
      await page.setViewportSize({ width, height: 900 }); await page.goto(`/tools/salary/${firstId}`);
      await expect(page.getByRole("heading", { name: "历史条件核对_0", exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await expect(page.getByRole("meter", { name: "模拟可谈程度", exact: true })).toHaveAttribute("aria-valuenow", "20.5");
      await expect(page.getByText("7.5", { exact: true })).toBeVisible();
      expect(await page.getByText(`历史模拟方案：${condition}`, { exact: true }).textContent()).toBe(`历史模拟方案：${condition}`);
      expect(await page.getByText(`底牌筹码：完整筹码：${condition}`, { exact: true }).textContent()).toBe(`底牌筹码：完整筹码：${condition}`);
      const replies = page.getByRole("button", { name: "一键填入输入框 ↗", exact: true });
      await expect(replies).toHaveCount(4); await replies.nth(3).click();
      await expect(page.getByRole("textbox", { name: "你的练习回复", exact: true })).toHaveValue(`历史回复_3：${condition}`);
      expect((await (await request.get(`/api/tools/salary-negotiations/${firstId}`)).json()).turns[0].mentor_analysis).toEqual(mentor);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.goto(`/tools/salary/${firstId + 1}`);
      await expect(page.getByRole("heading", { name: `本次模拟结果：${report.final_package_summary}`, exact: true })).toBeVisible();
      await expect(page.getByText("保存的方案说明：只认可月薪，奖金需审批", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "本次模拟结果：只认可月薪，奖金需审批", exact: true })).toHaveCount(0);
      await expect(page.getByText("A", { exact: true })).toBeVisible();
      await expect(page.getByText("70.5", { exact: false }).filter({ hasText: "/ 100" }).last()).toBeVisible();
      expect(await page.getByText(`原点评：${condition}`, { exact: true }).textContent()).toBe(`原点评：${condition}`);
      await expect(page.getByText(`历史建议_6：${condition}`, { exact: true })).toBeVisible();
      await expect(page.getByText("旧记录未保存筹码与说服力评估", { exact: true })).toBeVisible();
      expect((await (await request.get(`/api/tools/salary-negotiations/${firstId + 1}`)).json()).report).toEqual(report);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`salary-history-report-${width}.png`) });
      await page.goto(`/tools/salary/${firstId + 2}`);
      await expect(page.getByText("旧记录未保存模拟方案", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await expect(page.getByRole("meter")).toHaveCount(0); await expect(page.getByText("未保存有效评分", { exact: true })).toHaveCount(2);
      await expect(page.getByRole("button", { name: /一键填入/ })).toHaveCount(0);
      await expect(page.getByText(/态度稳健|底牌展露略快|综合表现稳健/)).toHaveCount(0);
      expect(writes).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`salary-history-missing-${width}.png`) });
      const after = await exportEncryptedBackup(request); expect(after.response.ok()).toBe(true);
      await rewriteEncryptedBackup(after.bytes, (records) => {
        const actual = records.filter((row): row is RowRecord => row.kind === "row" && expectedRows.some((expected) => expected.table === row.table && expected.data.id === row.data.id));
        expectedRows = expectedRows.sort((a, b) => a.table.localeCompare(b.table) || Number(a.data.id) - Number(b.data.id));
        actual.sort((a, b) => a.table.localeCompare(b.table) || Number(a.data.id) - Number(b.data.id));
        expect(actual).toEqual(expectedRows);
      });
    } finally {
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
