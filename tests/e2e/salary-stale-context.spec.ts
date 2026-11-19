import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { listenForFetch } from "../support/http-server";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { wrapUntrustedData } from "../../src/lib/prompt-safety";

const offerA = "模拟方案 A：税前 CNY 月薪 30k，保证 14 薪；试用期全薪，尚未接受。";
const offerB = "模拟替代方案 B：税前 CNY 月薪 32k，保证 12 薪；试用期工资八折，仍待审批。原方案 A 已撤回，不能组合成 32k × 14。";
const colleagueMessage = "请重新核实月薪、保证薪数和试用期条件；我尚未接受任何方案。";
const turnOutput = {
  hr_response: offerB, hr_tactics: "分别说明方案与审批条件",
  hr_mindset: { looseness: 20, current_attitude: "模拟：尚待确认", estimated_package: "模拟 B：32k×12，试用期八折，待审批；A已撤回",
    tactics_label: "澄清方案", internal_pressure: "模拟：方案 B 仍待审批，不能承诺到岗" },
  mentor_analysis: { user_argument_score: 7, strengths: ["明确要求核实完整条件"], vulnerabilities: ["审批和书面条款待确认"],
    tactical_tips: "核对新方案，不把月薪方向视为整套接受",
    suggested_replies: [{ title: "核实条件", content: "请书面确认保证薪数与试用期工资。", rationale: "保留审批和接受边界" }] },
};
const openingOutput = {
  ...turnOutput, initial_offer: offerA, hr_response: offerA,
  hr_mindset: { ...turnOutput.hr_mindset, estimated_package: offerA, internal_pressure: "模拟：尚无其他报价或审批结果" },
  mentor_analysis: { ...turnOutput.mentor_analysis, user_argument_score: 5, strengths: ["候选人尚未发言"], tactical_tips: "开局为中性起点，先核对保证收入" },
};
const reportOutput = {
  final_package_summary: "模拟尚未达成：B 为税前 CNY 月薪 32k × 12、试用期八折且待审批；A 已撤回。",
  score: 75, leverage_efficiency: "不能将已撤回 A 的 14 薪与 B 的月薪拼接计算收益。",
  turn_critiques: [{ turn_no: 2, gain_or_loss: "neutral", summary: "候选人要求核实完整条件", key_point: "本轮 HR 才说明 B 与撤回 A，候选人尚未回应" }],
  real_world_tips: ["核实新方案和审批后再决定"], mentor_summary: "仅为模拟练习；结束补充不代表双方已达成。",
};

for (const width of [390, 1280]) {
  for (const operation of ["turn", "finalize"] as const) {
    test(`谈薪旧报价 ${width}px ${operation}：两页读取后拒绝过期提交，保留草稿再明确重试`, async ({ page, context, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const inputs: { messages: { role: string; content: string }[]; stream?: boolean }[] = [];
      let stage: "opening" | "turn" | "finalize" = "opening";
      const provider = createServer(async (incoming, outgoing) => {
        let body = "";
        for await (const chunk of incoming) body += chunk;
        const input = JSON.parse(body); inputs.push(input);
        const content = JSON.stringify(stage === "opening" ? openingOutput : stage === "finalize" ? reportOutput : turnOutput);
        if (input.stream) {
          outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
          outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
        } else {
          outgoing.writeHead(200, { "Content-Type": "application/json" });
          outgoing.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
        }
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing provider address");
      const otherPage = await context.newPage();
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-salary-stale-key",
          api_format: "openai_chat", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const created = await request.post("/api/tools/salary-negotiations", { data: {
          target_role: `过期报价核对_${operation}_${width}`, expected_salary: "税前 CNY 月薪 30k，完整条件核对后决定",
        } });
        expect(created.status(), await created.text()).toBe(201);
        const id = (await created.json()).id;
        const endpoint = `/api/tools/salary-negotiations/${id}`;
        const original = await (await request.get(endpoint)).json();
        expect(original.revision).toMatch(/^[a-f0-9]{64}$/);
        expect(original.turns).toHaveLength(1);
        const viewed: { page: string; revision: string }[] = [];
        for (const [browserPage, label] of [[page, "A"], [otherPage, "B"]] as const) {
          await browserPage.setViewportSize({ width, height: 900 });
          const response = browserPage.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === "GET");
          await browserPage.goto(`/tools/salary/${id}`);
          const detail = await (await response).json();
          viewed.push({ page: label, revision: detail.revision });
          expect(detail.revision).toBe(original.revision);
          await expect(browserPage.getByText(offerA, { exact: true }).first()).toBeVisible();
        }
        const input = page.getByRole("textbox", { name: "你的练习回复", exact: true });
        const draft = "  我只看过 A 的 30k × 14。原稿 Array<T> &amp;\n未接受其他方案，也未承诺到岗。  ";
        const supplement = "  结束补充 Array<T> &amp;\n我只看过 A，任何新条件都需核对，不能认定已达成。  ";
        await input.fill(draft);
        const finalizeTrigger = page.getByRole("button", { name: "结束模拟 / 生成复盘", exact: true });
        const dialog = page.getByRole("dialog", { name: "结束模拟并生成复盘报告", exact: true });
        const finalInput = dialog.getByRole("textbox", { name: "结束补充（可选）", exact: true });
        await finalizeTrigger.click(); await finalInput.fill(supplement);
        await dialog.getByRole("button", { name: "取消", exact: true }).click();

        // 第二页先推进，第一页保留它实际看过的旧版本与两个本地草稿。
        stage = "turn";
        await otherPage.getByRole("textbox", { name: "你的练习回复", exact: true }).fill(colleagueMessage);
        const otherResponse = otherPage.waitForResponse(response => new URL(response.url()).pathname === `${endpoint}/turn` && response.request().method() === "POST");
        await otherPage.getByRole("button", { name: "发送话术 · 推进博弈", exact: true }).click();
        const changed = await otherResponse;
        expect(changed.status(), await changed.text()).toBe(201);
        expect(changed.request().postDataJSON()).toEqual({ user_message: colleagueMessage, expected_revision: original.revision });
        const committed = await changed.json();
        expect(committed.base_revision).toBe(original.revision);
        expect(committed.revision).toMatch(/^[a-f0-9]{64}$/);
        expect(committed.revision).not.toBe(original.revision);
        await expect(otherPage.getByRole("textbox", { name: "你的练习回复", exact: true })).toHaveValue("");
        const updated = await (await request.get(endpoint)).json();
        expect(updated.revision).toBe(committed.revision);
        expect(updated.turns).toHaveLength(2);
        expect(updated.turns[1].hr_response).toBe(offerB);
        expect(inputs).toHaveLength(2);
        await expect(page.getByText(offerB, { exact: true })).toHaveCount(0);
        await expect(input).toHaveValue(draft);

        const posts: Record<string, unknown>[] = [];
        page.on("request", incoming => {
          if (new URL(incoming.url()).pathname === `${endpoint}/${operation}` && incoming.method() === "POST") posts.push(incoming.postDataJSON());
        });
        const staleResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${endpoint}/${operation}` && response.request().method() === "POST");
        if (operation === "turn") await page.getByRole("button", { name: "发送话术 · 推进博弈", exact: true }).click();
        else {
          await finalizeTrigger.click(); await expect(finalInput).toHaveValue(supplement);
          await dialog.getByRole("button", { name: "结束模拟并生成报告", exact: true }).click();
        }
        const rejected = await staleResponse;
        expect(rejected.status(), await rejected.text()).toBe(409);
        expect(rejected.headers()["cache-control"]).toContain("no-store");
        const submitted = operation === "turn" ? { user_message: draft.trim() } : { final_words: supplement.trim() };
        expect(posts).toEqual([{ ...submitted, expected_revision: original.revision }]);
        const alert = page.getByRole("alert", { name: "谈薪操作状态", exact: true });
        await expect(alert).toContainText("已重新读取当前存档");
        await expect(alert).toContainText("原话与结束补充已保留");
        await expect(input).toBeEnabled(); await expect(input).toHaveValue(draft);
        await expect(page.getByText(offerB, { exact: true }).first()).toBeVisible();
        expect(inputs).toHaveLength(2);
        expect(await (await request.get(endpoint)).json()).toEqual(updated);
        expect(posts).toHaveLength(1);
        await alert.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`salary-stale-${operation}-${width}.png`), fullPage: true, animations: "disabled" });
        await finalizeTrigger.click(); await expect(finalInput).toHaveValue(supplement);
        await page.screenshot({ path: testInfo.outputPath(`salary-stale-drafts-${operation}-${width}.png`), animations: "disabled" });

        // 唯有用户再次点击才提交；沿用刚回读的新报价版本，不隐式重发旧请求。
        stage = operation;
        const retryResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${endpoint}/${operation}` && response.request().method() === "POST");
        if (operation === "turn") {
          await dialog.getByRole("button", { name: "取消", exact: true }).click();
          await page.getByRole("button", { name: "发送话术 · 推进博弈", exact: true }).click();
        } else await dialog.getByRole("button", { name: "结束模拟并生成报告", exact: true }).click();
        const retried = await retryResponse;
        expect(retried.status(), await retried.text()).toBe(operation === "turn" ? 201 : 200);
        const result = await retried.json();
        expect(result.base_revision).toBe(updated.revision);
        expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
        expect(result.revision).not.toBe(updated.revision);
        expect(posts).toEqual([{ ...submitted, expected_revision: original.revision }, { ...submitted, expected_revision: updated.revision }]);
        expect(inputs).toHaveLength(3);
        const actualMessages = inputs[2]!.messages.map(message => message.content).join("\n");
        expect(actualMessages).toContain(offerB);
        if (operation === "turn") {
          expect(actualMessages).toContain(wrapUntrustedData("candidate_message", draft.trim()));
          await expect(input).toHaveValue("");
        } else {
          expect(actualMessages).toContain("结束补充 Array&lt;T&gt; &amp;amp;");
          await expect(page.getByRole("heading", { name: `本次模拟结果：${reportOutput.final_package_summary}`, exact: true })).toBeVisible();
        }
        const saved = await (await request.get(endpoint)).json();
        expect(saved.revision).toBe(result.revision);
        expect(saved.turns).toHaveLength(operation === "turn" ? 3 : 2);
        expect(saved.turns.slice(0, 2)).toEqual(updated.turns);
        expect(saved.status).toBe(operation === "turn" ? "ongoing" : "finished");
        if (operation === "turn") expect(saved.turns[2].user_message).toBe(draft.trim());
        await page.reload();
        await expect(page.getByText(offerB, { exact: true }).first()).toBeVisible();
        if (operation === "finalize") await expect(page.getByRole("heading", { name: `本次模拟结果：${reportOutput.final_package_summary}`, exact: true })).toBeVisible();
        expect(await (await request.get(endpoint)).json()).toEqual(saved);
        expect(inputs).toHaveLength(3);
        await testInfo.attach("synthetic-provider-requests", { body: JSON.stringify({ viewed, posts, inputs, originalRevision: original.revision, updatedRevision: updated.revision, savedRevision: saved.revision }), contentType: "application/json" });
        await page.screenshot({ path: testInfo.outputPath(`salary-fresh-${operation}-${width}.png`), fullPage: true, animations: "disabled" });
      } finally {
        await otherPage.close(); provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
