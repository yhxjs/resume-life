import { expect, test } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import type { RowRecord } from "../../src/lib/backup-records";

const created = "2026-11-01T03:04:05.000Z";
const title = "历史原稿 <T> &amp; " + "LongTitle_".repeat(24);
const source = "原始材料 Array<T> &amp;\n尚未上线，内部  空格与收益未确认。";
const configs = [
  { kind: "jd", table: "jd_portraits", endpoint: "jd-portraits", button: "删除画像", confirm: "删除记录", scope: "关联的投递备战素材引用" },
  { kind: "decoder", table: "jargon_decodings", endpoint: "jargon-decodings", button: "删除报告", confirm: "删除记录", scope: "原始输入" },
  { kind: "gap", table: "resignation_gap_remedies", endpoint: "career-gap-remedies", button: "删除报告", confirm: "删除报告", scope: "原始经历" },
  { kind: "salary", table: "salary_negotiations", endpoint: "salary-negotiations", button: "删除", confirm: "删除博弈记录", scope: "全部对话回合" },
] as const;
const script = { label: "历史参考", applicableScene: "核对事实后练习", script: source, keyPoints: [] };
const results = {
  jd: { role: title, mustSkills: [], followups: [], companyStyle: { style: "信息不足", signals: [] } },
  decoder: { targetSummary: title, punchline: "只按实际条件核对", overallRiskScore: null, riskRatings: { overtime: null, stability: null, resources: null, management: null }, items: [], companyProfile: { teamStyle: "未知", cultureSummary: "需要核实", riskFlags: [] }, goldenQuestions: [] },
  gap: { title, punchline: "保持未确认事项", hrMindsetAnalysis: { coreConcerns: [], riskPoints: [], whatHrWantsToHear: "未知" },
    reframeFormula: { factAcknowledgment: source, positiveAttribution: "", growthAndValue: "", motivationAlignment: "未知" },
    scripts: { concise: script, detailed: script, pivoting: script }, drills: [], forbiddenList: [], closingTips: [] },
};

for (const width of [390, 1280]) for (const config of configs) {
  test(`工具详情确认 ${config.kind} ${width}px：离页、焦点及真实删除范围`, async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const rows: RowRecord[] = []; const firstIds: Record<string, number> = {}; let applicationId = 0;
    const seeded = await rewriteEncryptedBackup(baseline.bytes, records => {
      function add(table: string, data: RowRecord["data"]) { rows.push({ kind: "row", table, data }); }
      for (const item of configs) {
        const first = Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === item.table ? [Number(row.data.id)] : [])) + 1;
        firstIds[item.kind] = first;
        for (let index = 0; index < 2; index++) {
          if (item.kind === "salary") add(item.table, { id: first + index, target_company_tier: "自定义企业", target_role: title, expected_salary: "30k，奖金待审批", current_or_competing_offer: source, hr_style: "standard", status: "ongoing", initial_offer: "未确认", final_package: "", report: "", created_at: created, finished_at: "" });
          else {
            const result = width === 390 ? JSON.stringify(results[item.kind]) : "";
            if (item.kind === "jd") add(item.table, { id: first + index, jd: source, result, created_at: created });
            else if (item.kind === "decoder") add(item.table, { id: first + index, source_text: source, result, created_at: created });
            else add(item.table, { id: first + index, scenario_type: "gap", raw_story: source, target_role: title, persona_style: "composed", result, created_at: created });
          }
        }
      }
      const firstTurn = Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === "salary_negotiation_turns" ? [Number(row.data.id)] : [])) + 1;
      for (let index = 0; index < 4; index++) add("salary_negotiation_turns", { id: firstTurn + index, negotiation_id: firstIds.salary! + Math.floor(index / 2), turn_no: index % 2 + 1, user_message: source, hr_response: "尚未确定条件", hr_tactics: "澄清", hr_mindset: "{}", mentor_analysis: "{}", created_at: created });
      records.splice(records.findIndex(row => row.kind === "end"), 0, ...rows);
      const manifest = records.find(row => row.kind === "manifest"); const end = records.find(row => row.kind === "end");
      if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing envelope");
      end.stats = Object.fromEntries(manifest.tables.map(table => [table, records.filter(row => row.kind === "row" && row.table === table).length]));
      end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
      for (const row of rows) { const table = row.table as keyof typeof manifest.sequences; manifest.sequences[table] = Math.max(Number(manifest.sequences[table] ?? 0), Number(row.data.id)); }
    });
    const id = firstIds[config.kind]!; const endpoint = `/api/tools/${config.endpoint}/${id}`;
    let deletes = 0;
    try {
      const restored = await postEncryptedBackup(request, "/api/backup/restore", seeded); expect(restored.status(), await restored.text()).toBe(200);
      if (config.kind === "jd" && width === 390) {
        const response = await request.post("/api/applications", { data: { company: "删除画像仍保留的投递", role: "工程师" } }); expect(response.status()).toBe(201); applicationId = (await response.json()).id;
        for (const portraitId of [id, id + 1]) expect((await request.post(`/api/applications/${applicationId}/preparation/resources`, { data: { kind: "portrait", id: portraitId } })).ok()).toBe(true);
      }
      const before = await (await request.get(endpoint)).json(); const originalApp = applicationId ? await (await request.get(`/api/applications/${applicationId}`)).json() : null;
      await page.route(`**${endpoint}`, async route => { if (route.request().method() === "DELETE") deletes++; return route.continue(); });
      await page.setViewportSize({ width, height: 900 }); await page.goto(`/tools/${config.kind}/${id}`);
      const trigger = page.getByRole("button", { name: config.button, exact: true }); await expect(trigger).toBeEnabled();
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack(); await expect(trigger).toBeEnabled();
      await trigger.click(); const dialog = page.getByRole("dialog", { name: config.confirm, exact: true }); await expect(dialog).toBeVisible();
      await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(deletes).toBe(0); expect(await (await request.get(endpoint)).json()).toEqual(before);
      await page.goBack(); await expect(trigger).toBeEnabled();
      if (config.kind === "salary") await page.getByRole("textbox", { name: "你的练习回复", exact: true }).fill(source);
      await trigger.click(); await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(trigger).toBeFocused();
      await trigger.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); }); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
      if (config.kind === "salary") await expect(page.getByRole("textbox", { name: "你的练习回复", exact: true })).toHaveValue(source);
      expect(deletes).toBe(0); expect(await (await request.get(endpoint)).json()).toEqual(before);
      await trigger.click(); await expect(dialog).toContainText(`#${id}`); await expect(dialog).toContainText(created); await expect(dialog).toContainText(config.scope);
      if (width === 390 || config.kind === "salary") await expect(dialog).toContainText(title);
      if (config.kind === "salary") await expect(dialog).toContainText("当前 2 回合");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`tool-confirm-${config.kind}-${width}.png`), animations: "disabled" });
      await dialog.getByRole("button", { name: "删除", exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/tools/${config.kind}$`)); expect(deletes).toBe(1); expect((await request.get(endpoint)).status()).toBe(404);
      const exported = await exportEncryptedBackup(request); expect(exported.response.ok()).toBe(true);
      await rewriteEncryptedBackup(exported.bytes, records => {
        for (const row of rows) {
          const removed = (row.table === config.table && row.data.id === id) || (config.kind === "salary" && row.table === "salary_negotiation_turns" && row.data.negotiation_id === id);
          const actual = records.find(entry => entry.kind === "row" && entry.table === row.table && entry.data.id === row.data.id);
          if (removed) expect(actual).toBeUndefined(); else expect(actual).toEqual(row);
        }
        if (applicationId) {
          const links = records.filter(row => row.kind === "row" && row.table === "application_preparation_resources" && row.data.application_id === applicationId) as RowRecord[];
          expect(links.map(row => row.data.portrait_id)).toEqual([id + 1]);
        }
      });
      if (applicationId) expect(await (await request.get(`/api/applications/${applicationId}`)).json()).toEqual(originalApp);
    } finally { await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });
}
