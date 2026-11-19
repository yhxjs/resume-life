import { listenForFetch } from "../support/http-server";
import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

for (const width of [390, 1280]) {
  for (const failure of ["响应断开", "响应无法解析", "响应缺少结果", "响应历史损坏", "响应编号不符", "响应缺少回执", "旧历史空时间"]) {
    test(`重答恢复 ${width}px ${failure}：已提交结果不重复评分，同文新提交仍独立保存`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const original = "原答：仅负责接口校验 <T> &amp;，未上线。";
      const answer = "本次重答 <T> &amp;：只负责接口联调，\n方案与结果仍待核实。";
      const firstReference = "第一次重答的参考 <T> &amp;：[待补充：联调记录]。";
      const nextReference = "再次独立评分的参考 <T> &amp;：仍保留未验证条件。";
      const replies: unknown[] = [
        { question: "你个人负责哪些接口工作？" },
        { depth: 7, structure: 8, authenticity: 9, completeness: 7, comment: "原答点评", next_question: "如何核实验证范围？", next_kind: "question" },
        { jd_match: 7, strengths: "分工明确", weaknesses: "验证记录待核实", suggestions: "补充真实记录" },
        { depth: 8, structure: 8, authenticity: 9, completeness: 8, comment: "第一次重答点评", reference: firstReference },
        { depth: 7, structure: 8, authenticity: 9, completeness: 8, comment: "再次独立评分点评", reference: nextReference },
      ];
      const inputs: string[] = [];
      const provider = createServer(async (incoming, outgoing) => {
        let raw = "";
        for await (const chunk of incoming) raw += chunk;
        inputs.push(raw);
        const reply = replies.shift();
        if (!reply) {
          outgoing.writeHead(500);
          outgoing.end("Unexpected synthetic provider request");
          return;
        }
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing synthetic provider address");
      const done = async (response: APIResponse) => {
        expect(response.status()).toBe(200);
        const events = await response.text();
        const match = events.match(/event: done\ndata: ([^\n]+)/);
        expect(match, events).not.toBeNull();
        return JSON.parse(match![1]!);
      };
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-retry-recovery-key", api_format: "openai_chat",
          model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const resumeResponse = await request.post("/api/resumes", { data: { title: "重答恢复合成简历" } });
        expect(resumeResponse.status()).toBe(201);
        const resume = await resumeResponse.json();
        const version = await publishResume(request, resume.id);
        const interview = await done(await request.post("/api/interviews", { data: {
          resume_id: resume.id, resume_version_id: version.id, jd: "接口开发与联调", rounds: 3,
        } }));
        const endpoint = `/api/interviews/${interview.id}`;
        const initial = await request.get(endpoint);
        expect(initial.ok()).toBe(true);
        const turnId = (await initial.json()).turns[0].id as number;
        await done(await request.post(`${endpoint}/answer`, { data: { turn_id: turnId, answer: original } }));
        expect((await request.post(`${endpoint}/finish`)).status()).toBe(200);
        const legacy = { id: "legacy", answer: "旧回答 <T> &amp;，未上线", scores: null, comment: "", created_at: "" };
        const initialHistory = failure === "旧历史空时间" ? [legacy] : [];
        if (initialHistory.length) {
          const snapshot = await exportEncryptedBackup(request);
          expect(snapshot.response.ok()).toBe(true);
          const seeded = await rewriteEncryptedBackup(snapshot.bytes, records => {
            const row = records.find(record => record.kind === "row" && record.table === "interview_turns" && record.data.id === turnId);
            if (!row || row.kind !== "row") throw new Error("Missing synthetic interview turn");
            row.data.retries = JSON.stringify(initialHistory);
          });
          expect((await postEncryptedBackup(request, "/api/backup/restore", seeded, { preserveAiConfig: true })).ok()).toBe(true);
        }
        const keys: string[] = [];
        await page.route(`**${endpoint}/turns/${turnId}/retry`, async (route) => {
          expect(route.request().postDataJSON()).toEqual({ answer });
          const key = route.request().headers()["idempotency-key"];
          expect(key).toMatch(/^[0-9a-f-]{36}$/i);
          keys.push(key!);
          // 先执行生产路由并提交 SQLite，再丢弃成功响应，不能用纯 mock 冒充保存。
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          if (keys.length === 1) {
            if (failure === "响应断开") await route.abort("failed");
            else if (failure === "响应无法解析") await route.fulfill({ status: 200, contentType: "application/json", body: "{broken" });
            else if (failure === "响应缺少结果" || failure === "旧历史空时间") await route.fulfill({ json: { retries: [] } });
            else {
              const saved = await response.json();
              if (failure === "响应历史损坏") saved.retries[0].reference = { invalid: true };
              else if (failure === "响应编号不符") {
                saved.retry.id = "retry_00000000-0000-4000-8000-000000000099";
                saved.retries[0].id = saved.retry.id;
              } else delete saved.retry;
              await route.fulfill({ json: saved });
            }
          } else await route.fulfill({ response });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.goto(`/interviews/${interview.id}`);
        const card = page.locator(`#turn-${turnId}`);
        const input = card.getByRole("textbox", { name: /重新作答此题/ });
        const reference = card.getByRole("region", { name: "当前回答参考", exact: true });
        await card.getByRole("button", { name: /重答这一题/ }).click();
        await input.fill(answer);
        await card.getByRole("button", { name: "提交并重新评分", exact: true }).click();
        const message = failure === "响应断开" ? "无法连接服务器"
          : failure === "响应无法解析" ? "服务器返回的数据无法读取" : "服务器返回的重答结果不完整";
        await expect(card.getByRole("alert")).toContainText(message);
        await expect(input).toHaveValue(answer);
        await expect(input).toBeEnabled();
        if (failure === "响应历史损坏") await card.screenshot({ path: testInfo.outputPath(`retry-invalid-${width}.png`) });
        const committed = await request.get(endpoint);
        expect(committed.ok()).toBe(true);
        const committedTurn = (await committed.json()).turns[0];
        expect(committedTurn).toMatchObject({ answer: original, reference: "" });
        expect(committedTurn.retries).toEqual([...initialHistory, expect.objectContaining({ answer, reference: firstReference })]);
        expect(inputs).toHaveLength(4);
        await card.getByRole("button", { name: "提交并重新评分", exact: true }).click();
        await expect(input).toHaveCount(0);
        await expect(reference).toHaveText(firstReference);
        expect(keys[1]).toBe(keys[0]);
        expect(inputs).toHaveLength(4);
        await card.getByRole("button", { name: "复制参考答案", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(firstReference);
        await card.getByRole("button", { name: /重答这一题/ }).click();
        await expect(input).toHaveValue(answer);
        await card.getByRole("button", { name: "提交并重新评分", exact: true }).click();
        await expect(reference).toHaveText(nextReference);
        expect(keys).toHaveLength(3);
        expect(keys[2]).not.toBe(keys[1]);
        expect(inputs).toHaveLength(5);
        const saved = await request.get(endpoint);
        expect(saved.ok()).toBe(true);
        const savedTurn = (await saved.json()).turns[0];
        expect(savedTurn).toMatchObject({ answer: original, reference: "" });
        expect(savedTurn.retries).toEqual([
          ...initialHistory,
          expect.objectContaining({ id: committedTurn.retries[initialHistory.length].id, answer, reference: firstReference }),
          expect.objectContaining({ answer, reference: nextReference }),
        ]);
        expect(savedTurn.retries[initialHistory.length + 1].id).not.toBe(savedTurn.retries[initialHistory.length].id);
        await page.reload();
        await expect(reference).toHaveText(nextReference);
        await card.getByRole("button", { name: new RegExp(`^重答#${initialHistory.length + 1}(?!\\d)`) }).click();
        await expect(reference).toHaveText(firstReference);
        expect(inputs).toHaveLength(5);
        expect(replies).toHaveLength(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await card.screenshot({ path: testInfo.outputPath(`retry-recovery-${width}-${failure}.png`) });
      } finally {
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
