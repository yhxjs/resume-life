import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import type { RowRecord } from "../../src/lib/backup-records";
import { listenForFetch } from "../support/http-server";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";

type ProviderRequest = { messages: { role: string; content: string }[] };

function userField(input: ProviderRequest, tag: string): string {
  const user = input.messages.filter(message => message.role === "user").map(message => message.content).join("\n");
  const fields = [...user.matchAll(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`, "g"))];
  expect(fields, tag).toHaveLength(1);
  return fields[0]![1]!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

for (const state of ["missing", "empty"] as const) {
  test(`历史来源 390px：${state === "missing" ? "旧复盘未保存资料" : "已保存资料的JD为空"}与当前JD区分，追练不附岗位背景`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const original = { company: "原始空背景公司", role: "测试开发", round: "原始技术面", jd: state === "empty" ? "" : "只用于生成复盘的旧岗位说明" };
    const current = { company: "当前算法公司", role: "算法工程师", jd: "当前 JD：训练图像分类模型并评估准确率。", round: "当前算法面" };
    const question = { question: "你如何记录接口测试结果？", answer: "我记录测试环境的输入和返回，未统计线上收益。", stuck: "记录范围待核实", feedback: "" };
    const result = { mistakes: [{ question_index: 1, gap: "需要澄清测试记录范围", improved_answer: "仅说明实际记录的范围，缺失信息待核实。" }], drills: [{ question_index: 1, question: "假设需要核对两次接口测试结果，你会记录哪些信息？" }], resume_suggestions: [] };
    const answer = "我会记录输入、预期返回和实际返回，再比较差异；这是待执行的假设方案。";
    const grade = { depth: 7, structure: 8, authenticity: 9, completeness: 7, comment: "回答说明了拟记录的信息，未声称已经执行。", reference: "可按输入、预期、实际返回和环境记录差异，具体范围仍需核对。" };
    const replies: unknown[] = [result, grade];
    const inputs: ProviderRequest[] = [];
    const unexpected: string[] = [];
    const provider = createServer(async (incoming, outgoing) => {
      let raw = "";
      for await (const chunk of incoming) raw += chunk;
      const reply = replies.shift();
      if (!reply) { unexpected.push(raw); outgoing.writeHead(500); outgoing.end("Unexpected synthetic request"); return; }
      inputs.push(JSON.parse(raw) as ProviderRequest);
      outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
    });
    await listenForFetch(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing synthetic provider address");
    try {
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-review-empty-context", api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
      } })).ok()).toBe(true);
      const created = await request.post("/api/applications", { data: { company: original.company, role: original.role, jd: original.jd } });
      expect(created.status()).toBe(201);
      const applicationId = (await created.json()).id as number;
      const roundResponse = await request.post(`/api/applications/${applicationId}/interviews`, { data: { round_name: original.round, status: "completed" } });
      expect(roundResponse.status()).toBe(201);
      const roundId = (await roundResponse.json()).id as number;
      const endpoint = `/api/applications/${applicationId}/interviews/${roundId}/review`;
      const initial = await (await request.get(endpoint)).json();
      const saved = await request.put(endpoint, { data: { expected_hash: initial.input_hash, questions: [question] } });
      expect(saved.status()).toBe(200);
      const generated = await request.post(endpoint, { data: { expected_hash: (await saved.json()).input_hash } });
      expect(generated.status()).toBe(200);
      const recap = (await generated.json()).latest;
      const before = await exportEncryptedBackup(request);
      expect(before.response.ok()).toBe(true);
      const imported = await rewriteEncryptedBackup(before.bytes, records => {
        const contextIndex = records.findIndex(row => row.kind === "row" && row.table === "application_interview_recap_contexts" && row.data.recap_id === recap.id);
        expect(contextIndex).toBeGreaterThan(-1);
        if (state === "missing") {
          records.splice(contextIndex, 1);
          const end = records.find(record => record.kind === "end");
          if (!end || end.kind !== "end") throw new Error("Missing backup statistics");
          end.stats.application_interview_recap_contexts = records.filter(record => record.kind === "row" && record.table === "application_interview_recap_contexts").length;
          end.totalRecords = records.filter(record => record.kind === "row").length;
        }
        else expect((records[contextIndex] as RowRecord).data).toMatchObject({ company: original.company, role: original.role, round_name: original.round, jd: "" });
      });
      const restored = await postEncryptedBackup(request, "/api/backup/restore", imported, { preserveAiConfig: true });
      expect(restored.status(), await restored.text()).toBe(200);
      expect((await request.patch(`/api/applications/${applicationId}`, { data: { company: current.company, role: current.role, jd: current.jd } })).status()).toBe(200);
      expect((await request.patch(`/api/applications/${applicationId}/interviews/${roundId}`, { data: { round_name: current.round } })).status()).toBe(200);

      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto(`/applications/${applicationId}/prepare`);
      await page.getByRole("region", { name: "真实面试记录" }).getByRole("button", { name: "逐题复盘", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `逐题复盘 · ${current.round}`, exact: true });
      await expect(dialog.getByText(result.mistakes[0]!.gap, { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`source-${state}-before-check-390.png`), animations: "disabled" });
      const source = dialog.getByRole("region", { name: "生成时的岗位资料", exact: true });
      await expect(source).toBeVisible();
      const expectedContext = state === "missing" ? null : { company: original.company, role: original.role, round_name: original.round, jd: "" };
      expect((await (await request.get(endpoint)).json()).latest.source_context).toEqual(expectedContext);
      const explanation = state === "missing" ? "生成时岗位资料未保存" : "生成时未提供 JD";
      await expect(source).toContainText(explanation);
      if (state === "missing") {
        for (const text of [original.company, original.role, original.round, original.jd]) await expect(source).not.toContainText(text);
      } else {
        for (const text of [original.company, original.role, original.round]) await expect(source).toContainText(text);
        await expect(source).not.toContainText("生成时岗位资料未保存");
      }
      for (const text of [current.company, current.role, current.jd, current.round]) await expect(source).not.toContainText(text);
      await source.scrollIntoViewIfNeeded();
      await expect(source).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`source-${state}-390.png`), animations: "disabled" });
      await dialog.getByRole("button", { name: "加入错题本", exact: true }).click();
      await page.getByRole("dialog", { name: "加入错题本？", exact: true }).getByRole("button", { name: "确认加入", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "已加入错题本", exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "开始追练", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: "开始追练？", exact: true });
      await expect(confirmation).toContainText(`${explanation}，追练将不附岗位背景。`);
      expect(await confirmation.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`source-${state}-confirm-390.png`), animations: "disabled" });
      await confirmation.getByRole("button", { name: "创建并开始", exact: true }).click();
      await expect(page).toHaveURL(/\/drills\/\d+$/);
      const drillId = Number(new URL(page.url()).pathname.split("/").pop());
      const drill = await (await request.get(`/api/drills/${drillId}`)).json();
      const sourceLabel = state === "missing" ? `真实面试复盘 #${recap.id}（生成时岗位资料未保存）` : `${original.company} · ${original.round}`;
      expect(drill).toMatchObject({ jd: "", focus: state === "missing" ? sourceLabel : `真实面试 · ${sourceLabel}` });
      await page.getByRole("textbox", { name: "我的现场回答：", exact: true }).fill(answer);
      await page.getByRole("button", { name: "提交作答并获取批阅", exact: true }).click();
      await expect(page.getByText(grade.comment, { exact: true })).toBeVisible();
      expect(inputs).toHaveLength(2);
      const sent = inputs[1]!.messages.filter(message => message.role === "user").map(message => message.content).join("\n");
      expect(sent).toContain("【岗位背景】\n（未提供）");
      expect(sent).not.toContain("<job_description>");
      expect(sent).not.toContain(current.jd);
      expect(userField(inputs[1]!, "candidate_answer")).toBe(answer);
      const persisted = await (await request.get(`/api/drills/${drillId}`)).json();
      expect(persisted.jd).toBe("");
      expect(persisted.questions[0]).toMatchObject({ answer, comment: grade.comment, reference: grade.reference });
      const exported = await exportEncryptedBackup(request);
      expect(exported.response.ok()).toBe(true);
      await rewriteEncryptedBackup(exported.bytes, records => {
        const mapping = records.find(row => row.kind === "row" && row.table === "application_interview_recap_exports" && row.data.recap_id === recap.id && row.data.kind === "mistakes") as RowRecord;
        expect(mapping).toBeDefined();
        const notebook = records.find(row => row.kind === "row" && row.table === "notebook_entries" && row.data.id === mapping.data.target_id) as RowRecord;
        expect(notebook.data.source_label).toBe(sourceLabel);
      });
      expect(replies).toHaveLength(0);
      expect(unexpected).toEqual([]);
    } finally {
      await testInfo.attach("synthetic-provider-requests", { body: JSON.stringify({ state, inputs, unexpected }, null, 2), contentType: "application/json" });
      await page.goto("/");
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}

for (const width of [390, 1280]) {
  test(`历史复盘导出 ${width}px：投递改名改JD后仍按原资料评分，删除重导出保留原来源`, async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const original = { company: "原始公司 <T> &amp;", role: "接口兼容性工程师", jd: "原始 JD：接口兼容性维护 <T> &amp;，只验证测试环境。", round: "技术一面（原）" };
    const changed = { company: "更新后的数据公司", role: "流式数据工程师", jd: "更新 JD：Kafka 实时数据链路与生产容量治理。", round: "改名后的终面" };
    const question = { question: "你在接口兼容性维护中承担哪些工作？", answer: "我只参与参数校验与回归测试，尚未上线。", stuck: "旧调用方验证范围待核实", feedback: "未记录对方反馈" };
    const drillQuestion = "假设需要移除旧字段，你会如何核对调用方兼容性？";
    const recap = (version: number) => ({
      mistakes: [{ question_index: 1, gap: `版本${version}：调用方兼容性验证仍待说明`, improved_answer: "保留实际测试分工，缺失的验证记录待核实。" }],
      drills: [{ question_index: 1, question: drillQuestion }], resume_suggestions: [],
    });
    const answer = "先核对旧调用方依赖，再用新旧请求样例在测试环境验证；这是假设方案，尚未执行。";
    const grade = { depth: 7, structure: 8, authenticity: 9, completeness: 7, comment: "已说明兼容性核对思路，并保留未执行的假设边界。", reference: "可先确认旧字段依赖，再在测试环境对照请求与返回；实际范围仍待记录核实。" };
    const replies: unknown[] = [recap(1), recap(2), grade, grade];
    const inputs: ProviderRequest[] = [];
    const unexpected: string[] = [];
    const provider = createServer(async (incoming, outgoing) => {
      let raw = "";
      for await (const chunk of incoming) raw += chunk;
      const reply = replies.shift();
      if (!reply) {
        unexpected.push(raw);
        outgoing.writeHead(500, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify({ error: "Unexpected synthetic review export request" }));
        return;
      }
      inputs.push(JSON.parse(raw) as ProviderRequest);
      outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
    });
    await listenForFetch(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing synthetic provider address");
    try {
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-review-export-context", api_format: "openai_chat",
        model_question: "synthetic", model_evaluate: "synthetic",
      } })).ok()).toBe(true);
      const created = await request.post("/api/applications", { data: { company: original.company, role: original.role, jd: original.jd } });
      expect(created.status()).toBe(201);
      const applicationId = (await created.json()).id as number;
      const roundResponse = await request.post(`/api/applications/${applicationId}/interviews`, { data: { round_name: original.round, status: "completed" } });
      expect(roundResponse.status()).toBe(201);
      const roundId = (await roundResponse.json()).id as number;
      const endpoint = `/api/applications/${applicationId}/interviews/${roundId}/review`;
      const initial = await (await request.get(endpoint)).json();
      const saved = await request.put(endpoint, { data: { expected_hash: initial.input_hash, questions: [question] } });
      expect(saved.status()).toBe(200);
      const generated = await request.post(endpoint, { data: { expected_hash: (await saved.json()).input_hash } });
      expect(generated.status()).toBe(200);
      const firstRecap = (await generated.json()).latest;

      const patched = await request.patch(`/api/applications/${applicationId}`, { data: { company: changed.company, role: changed.role, jd: changed.jd } });
      expect(patched.status()).toBe(200);
      expect(await patched.json()).toMatchObject({ company: changed.company, role: changed.role, jd: changed.jd });
      const renamed = await request.patch(`/api/applications/${applicationId}/interviews/${roundId}`, { data: { round_name: changed.round } });
      expect(renamed.status()).toBe(200);
      expect(await renamed.json()).toMatchObject({ round_name: changed.round });
      const current = await (await request.get(endpoint)).json();
      expect(current.input_hash).not.toBe(firstRecap.input_hash);
      expect((await request.post(endpoint, { data: { expected_hash: current.input_hash } })).status()).toBe(200);
      expect(inputs).toHaveLength(2);
      expect(userField(inputs[0]!, "job_description")).toBe(original.jd);
      expect(userField(inputs[0]!, "company")).toBe(original.company);
      expect(userField(inputs[1]!, "job_description")).toBe(changed.jd);
      expect(userField(inputs[1]!, "company")).toBe(changed.company);

      const records = async () => {
        const backup = await exportEncryptedBackup(request);
        expect(backup.response.ok()).toBe(true);
        let rows: RowRecord[] = [];
        await rewriteEncryptedBackup(backup.bytes, entries => { rows = entries.filter((entry): entry is RowRecord => entry.kind === "row"); });
        return rows;
      };
      const originalRows = await records();
      expect(originalRows.find(row => row.table === "application_interview_recap_contexts" && row.data.recap_id === firstRecap.id)?.data).toMatchObject({
        company: original.company, role: original.role, round_name: original.round, jd: original.jd,
      });
      const readSelected = async () => {
        const response = await request.get(`${endpoint}?recap_id=${firstRecap.id}`);
        expect(response.status()).toBe(200);
        const data = await response.json();
        expect(data.history).toHaveLength(2);
        expect(data.latest.id).not.toBe(firstRecap.id);
        expect(data.selected).toMatchObject({ id: firstRecap.id, input_hash: firstRecap.input_hash, questions: [question], result: recap(1),
          source_context: { company: original.company, role: original.role, round_name: original.round, jd: original.jd },
        });
        return data.selected;
      };
      await page.setViewportSize({ width, height: 900 });
      const dialog = page.getByRole("dialog", { name: `逐题复盘 · ${changed.round}`, exact: true });
      const openHistory = async () => {
        await page.goto(`/applications/${applicationId}/prepare`);
        await page.getByRole("region", { name: "真实面试记录" }).getByRole("button", { name: "逐题复盘", exact: true }).click();
        await expect(dialog.getByText("版本2：调用方兼容性验证仍待说明", { exact: true })).toBeVisible();
        await dialog.getByRole("combobox", { name: "复盘版本" }).selectOption(String(firstRecap.id));
        await expect(dialog.getByText("版本1：调用方兼容性验证仍待说明", { exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`history-source-before-check-${width}.png`), animations: "disabled" });
        const source = dialog.getByRole("region", { name: "生成时的岗位资料", exact: true });
        await expect(source).toBeVisible();
        for (const text of [original.company, original.role, original.round]) await expect(source).toContainText(text);
        await source.getByText("查看生成时的 JD", { exact: true }).click();
        await expect(source.getByText(original.jd, { exact: true })).toBeVisible();
        for (const text of [changed.company, changed.role, changed.round, changed.jd]) await expect(source).not.toContainText(text);
        expect(await source.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`history-source-${width}.png`), animations: "disabled" });
      };
      let previousDrillId: number | null = null;
      let previousNotebookId: number | null = null;
      for (const attempt of [1, 2]) {
        await openHistory();
        await dialog.getByRole("button", { name: "加入错题本", exact: true }).click();
        const notebookConfirm = page.getByRole("dialog", { name: "加入错题本？", exact: true });
        await expect(notebookConfirm).toContainText(`复盘 #${firstRecap.id}`);
        await expect(notebookConfirm).toContainText(`生成时：${original.company} · ${original.role} · ${original.round}`);
        await notebookConfirm.getByRole("button", { name: "确认加入", exact: true }).click();
        await expect(dialog.getByRole("button", { name: "已加入错题本", exact: true })).toBeVisible();
        const exportedRows = await records();
        const exportRow = exportedRows.find(row => row.table === "application_interview_recap_exports" && row.data.recap_id === firstRecap.id && row.data.kind === "mistakes");
        expect(exportRow).toBeDefined();
        const notebook = exportedRows.find(row => row.table === "notebook_entries" && row.data.id === exportRow!.data.target_id);
        expect(notebook?.data).toMatchObject({ source: "application_interview", source_label: `${original.company} · ${original.round}`, question: question.question, answer: question.answer });
        const notebookId = notebook!.data.id as number;
        expect(notebookId).not.toBe(previousNotebookId);
        const savedNotebook = await request.get(`/api/notebook/${notebookId}`);
        expect(savedNotebook.status()).toBe(200);
        expect(await savedNotebook.json()).toMatchObject({ question: question.question, answer: question.answer, comment: recap(1).mistakes[0]!.gap });

        await dialog.getByRole("button", { name: "开始追练", exact: true }).click();
        const confirmation = page.getByRole("dialog", { name: "开始追练？", exact: true });
        await expect(confirmation).toContainText(`复盘 #${firstRecap.id}`);
        await expect(confirmation).toContainText(`生成时：${original.company} · ${original.role} · ${original.round}`);
        await expect(confirmation).toContainText("追练采用生成时的 JD");
        await expect(confirmation).toContainText(changed.company);
        await expect(confirmation).toContainText(changed.round);
        expect(await confirmation.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`history-export-confirm-${width}-${attempt}.png`), animations: "disabled" });
        await confirmation.getByRole("button", { name: "创建并开始", exact: true }).click();
        await expect(page).toHaveURL(/\/drills\/\d+$/);
        const drillId = Number(new URL(page.url()).pathname.split("/").pop());
        expect(drillId).not.toBe(previousDrillId);
        const drillResponse = await request.get(`/api/drills/${drillId}`);
        expect(drillResponse.status()).toBe(200);
        const drill = await drillResponse.json();
        expect(drill).toMatchObject({ source: "interview", jd: original.jd, focus: `真实面试 · ${original.company} · ${original.round}` });
        expect(drill.questions).toHaveLength(1);
        expect(drill.questions[0].question).toBe(drillQuestion);
        expect((await readSelected()).exports).toMatchObject({ mistakes: true, drills: drillId });

        await expect(page.getByRole("heading", { level: 2 })).toHaveText(drillQuestion);
        await page.getByRole("textbox", { name: "我的现场回答：", exact: true }).fill(answer);
        await page.getByRole("button", { name: "提交作答并获取批阅", exact: true }).click();
        await expect(page.getByText(grade.comment, { exact: true })).toBeVisible();
        expect(inputs).toHaveLength(2 + attempt);
        const grading = inputs[1 + attempt]!;
        expect(userField(grading, "job_description")).toBe(original.jd);
        expect(userField(grading, "interview_question")).toBe(drillQuestion);
        expect(userField(grading, "candidate_answer")).toBe(answer);
        expect(JSON.stringify(grading.messages)).not.toContain(changed.jd);
        const persisted = await (await request.get(`/api/drills/${drillId}`)).json();
        expect(persisted.jd).toBe(original.jd);
        expect(persisted.questions[0]).toMatchObject({ answer, comment: grade.comment, reference: grade.reference, scores: { depth: 7, structure: 8, authenticity: 9, completeness: 7 } });
        await page.reload();
        await expect(page.getByText(answer, { exact: true })).toBeVisible();
        await expect(page.getByText(grade.comment, { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`history-export-graded-${width}-${attempt}.png`), animations: "disabled" });

        if (attempt === 1) {
          expect((await request.delete(`/api/drills/${drillId}`)).status()).toBe(200);
          expect((await request.delete(`/api/notebook/${notebookId}`)).status()).toBe(200);
          expect((await request.get(`/api/drills/${drillId}`)).status()).toBe(404);
          expect((await request.get(`/api/notebook/${notebookId}`)).status()).toBe(404);
          expect((await readSelected()).exports).toMatchObject({ mistakes: false, drills: null });
          previousDrillId = drillId;
          previousNotebookId = notebookId;
        }
      }
      const finalRows = await records();
      expect(finalRows.filter(row => row.table === "application_interview_recap_contexts")).toEqual(originalRows.filter(row => row.table === "application_interview_recap_contexts"));
      expect(inputs).toHaveLength(4);
      expect(replies).toHaveLength(0);
      expect(unexpected).toEqual([]);
    } finally {
      await testInfo.attach("synthetic-provider-requests", { body: JSON.stringify({ inputs, unexpected }, null, 2), contentType: "application/json" });
      await page.goto("/");
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
