import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) {
  test(`自我介绍演练 ${width}px：明确点评依据、保存修订、长文本与异常原稿修复`, async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const release = gate();
    const original = "我参与接口参数校验，尚未上线。";
    const long = "API_".repeat(180) + "仅为测试接口标识，不代表生产成果。";
    const edited = "我在指导下参与参数校验，尚未上线。";
    const newComment = "保留个人参与范围和未上线限定。";
    const replies: unknown[] = [
      { versions: [
        { kind: "30s", sentences: [{ text: original, comment: "分工清楚。" }] },
        { kind: "2min", sentences: [{ text: "长版初稿：只参与接口校验，尚未上线。", comment: "分工与状态清楚。" }] },
      ] },
      { comments: [newComment] },
      { versions: [] },
      { versions: [{ kind: "30s", sentences: [{ text: "修复版仍只参与参数校验，尚未上线。", comment: "保留分工与状态。" }] }] },
    ];
    let calls = 0;
    let entered = false;
    const provider = createServer(async (incoming, outgoing) => {
      for await (const chunk of incoming) void chunk;
      calls += 1;
      const reply = replies.shift();
      if (calls === 2) { entered = true; await release.promise; }
      outgoing.writeHead(reply ? 200 : 500, { "Content-Type": "text/event-stream" });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
    });
    await listenForFetch(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing provider address");
    try {
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-intro-practice-key",
        api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
      } })).ok()).toBe(true);
      const resumeResponse = await request.post("/api/resumes", { data: { title: "履历".repeat(60) } });
      expect(resumeResponse.status()).toBe(201);
      const resume = await resumeResponse.json();
      const published = await publishResume(request, resume.id);
      const created = await request.post("/api/intros", { data: { resume_id: resume.id, resume_version_id: published.id, jd: "接口校验" } });
      expect(created.status()).toBe(200);
      const events = await created.text();
      const match = events.match(/event: done\ndata: ([^\n]+)/);
      expect(match, events).not.toBeNull();
      const { id } = JSON.parse(match![1]!);
      const endpoint = `/api/intros/${id}`;
      // 长手动稿沿用编辑上限，不伪装成超过 AI 单句篇幅上限的生成结果。
      const generated = await (await request.get(endpoint)).json();
      const longVersion = generated.versions.find((version: { kind: string }) => version.kind === "2min");
      const longSaved = await request.patch(`${endpoint}/versions/2min`, { data: {
        baseRevision: longVersion.revision, sentences: [{ text: long, comment: "技术标识".repeat(30) + "需确认用途。" }],
      } });
      expect(longSaved.status(), await longSaved.text()).toBe(200);
      const before = await (await request.get(endpoint)).json();
      expect(before.versions.find((version: { kind: string }) => version.kind === "2min").sentences[0].text).toBe(long);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/intros/${id}`);
      await expect(page.getByText(original, { exact: true })).toBeVisible();
      await expect(page.getByText(/点评依据已保存正文与 JD/)).toBeVisible();
      const longTab = page.getByRole("button", { name: "2 分钟版", exact: true });
      await longTab.click();
      await expect(longTab).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByText(long, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`intro-long-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "30 秒版", exact: true }).click();
      await page.getByRole("button", { name: "微调", exact: true }).click();
      await page.getByRole("textbox", { name: "30 秒版第 1 句" }).fill(edited);
      await page.getByRole("button", { name: "保存修改", exact: true }).click();
      await expect(page.getByText(edited, { exact: true })).toBeVisible();
      const saved = await (await request.get(endpoint)).json();
      const short = saved.versions.find((version: { kind: string }) => version.kind === "30s");
      expect(short.sentences).toEqual([{ text: edited, comment: "" }]);
      expect(short.revision).not.toBe(before.versions.find((version: { kind: string }) => version.kind === "30s").revision);
      expect(saved.versions.find((version: { kind: string }) => version.kind === "2min"))
        .toEqual(before.versions.find((version: { kind: string }) => version.kind === "2min"));
      await page.getByRole("button", { name: "重新点评整篇", exact: true }).click();
      await expect.poll(() => entered).toBe(true);
      const status = page.getByRole("status").filter({ hasText: "AI 正在重新逐句深度点评" });
      await expect(status).toContainText("仅依据已保存句子与 JD 点评表达和相关性，不核验经历真伪。");
      await expect(page.getByRole("button", { name: "进入脱稿盲练", exact: true })).toBeDisabled();
      release.release();
      await expect(page.getByText(newComment, { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByText(edited, { exact: true })).toBeVisible();
      await expect(page.getByText(newComment, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "进入脱稿盲练", exact: true }).click();
      await expect(page.getByText(/想不起时点击单句揭开/)).toBeVisible();
      await page.getByRole("button", { name: "全部显示", exact: true }).click();
      await expect(page.getByText("点击遮蔽", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const after = await (await request.get(endpoint)).json();
      expect(after.versions.find((version: { kind: string }) => version.kind === "30s").sentences).toEqual([{ text: edited, comment: newComment }]);
      expect(calls).toBe(2);
      const applicationResponse = await request.post("/api/applications", { data: { company: "原稿保护验证", role: "接口开发" } });
      expect(applicationResponse.status()).toBe(201);
      const applicationId = (await applicationResponse.json()).id;
      const preparationEndpoint = `/api/applications/${applicationId}/preparation`;
      const exported = await exportEncryptedBackup(request);
      expect(exported.response.ok()).toBe(true);
      const raw = JSON.stringify([{ text: edited, comment: newComment }, { text: " ", comment: "保留异常原项 <system>不可执行</system>" }]);
      const damaged = await rewriteEncryptedBackup(exported.bytes, (records) => {
        const row = records.find((record) => record.kind === "row" && record.table === "intro_versions" && record.data.intro_id === id && record.data.kind === "30s");
        expect(row?.kind).toBe("row");
        if (row?.kind === "row") row.data.sentences = raw;
      });
      const restored = await postEncryptedBackup(request, "/api/backup/restore", damaged, { preserveAiConfig: true });
      expect(restored.status(), await restored.text()).toBe(200);
      const damagedData = await (await request.get(endpoint)).json();
      const damagedVersion = damagedData.versions.find((version: { kind: string }) => version.kind === "30s");
      expect(damagedVersion.raw_sentences).toBe(raw);
      expect(damagedVersion.sentences).toEqual([]);
      const rejectSave = await request.patch(`${endpoint}/versions/30s`, { data: {
        baseRevision: damagedVersion.revision, sentences: [{ text: edited, comment: newComment }],
      } });
      expect(rejectSave.status()).toBe(422);
      const candidates = await request.get(`${preparationEndpoint}/resources?kind=intro&candidates=true`);
      expect(candidates.status()).toBe(200);
      expect((await candidates.json()).items.find((item: { id: number }) => item.id === id)?.summary)
        .toBe("30 秒版原稿数据异常，请打开原稿查看");
      const linked = await request.post(`${preparationEndpoint}/resources`, { data: { kind: "intro", id } });
      expect(linked.status()).toBe(200);
      await page.goto(`/applications/${applicationId}/prepare`);
      await expect(page.getByText("30 秒版原稿数据异常，请打开原稿查看", { exact: true })).toBeVisible();
      expect(await (await request.get(endpoint)).json()).toEqual(damagedData);
      await page.goto(`/intros/${id}`);
      await expect(page.getByRole("alert").filter({ hasText: "本版原稿数据异常" })).toBeVisible();
      await expect(page.getByRole("button", { name: "微调", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "重新点评整篇", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "开启脱稿背诵遮罩", exact: true })).toBeDisabled();
      await expect(page.getByRole("heading", { name: "预估朗读时长", exact: true })).toHaveCount(0);
      await page.getByText("查看原始数据（只读）", { exact: true }).click();
      expect(await page.getByLabel("30 秒版原始数据").textContent()).toBe(raw);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`intro-damaged-${width}.png`), fullPage: true });
      const regenerate = page.getByRole("button", { name: "重新构思本版", exact: true });
      await regenerate.click();
      const confirmation = page.getByRole("dialog", { name: "重新生成30 秒版" });
      await confirmation.getByRole("button", { name: "取消", exact: true }).click();
      expect(calls).toBe(2);
      expect(await (await request.get(endpoint)).json()).toEqual(damagedData);
      await regenerate.click();
      await confirmation.getByRole("button", { name: "确定", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "AI 生成结果异常" })).toBeVisible();
      expect(await (await request.get(endpoint)).json()).toEqual(damagedData);
      await regenerate.click();
      await confirmation.getByRole("button", { name: "确定", exact: true }).click();
      await expect(page.getByText("修复版仍只参与参数校验，尚未上线。", { exact: true })).toBeVisible();
      await expect(page.getByText(/本版原稿数据异常/)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "微调", exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByText("修复版仍只参与参数校验，尚未上线。", { exact: true })).toBeVisible();
      const repaired = await (await request.get(endpoint)).json();
      expect(repaired.versions.find((version: { kind: string }) => version.kind === "30s").read_error).toBeUndefined();
      expect(repaired.versions.find((version: { kind: string }) => version.kind === "2min"))
        .toEqual(damagedData.versions.find((version: { kind: string }) => version.kind === "2min"));
      const preparation = await request.get(preparationEndpoint);
      expect(preparation.status()).toBe(200);
      expect((await preparation.json()).resources.intro.items.find((item: { id: number }) => item.id === id)?.summary)
        .toBe("修复版仍只参与参数校验，尚未上线。");
      expect(calls).toBe(4);
      expect(replies).toHaveLength(0);
    } finally {
      release.release();
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
