import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import { listenForFetch } from "../support/http-server";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

const uniform = (value: number) => ({ depth: value, structure: value, authenticity: value, completeness: value });
for (const width of [390, 1280]) {
  test(`历史小数评分 ${width}px：五个页面按原分展示，收藏独立快照不改分`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const replies: unknown[] = [{ questions: ["如何验证个人负责的部分？"] }, { question: "如何说明未验证的收益？" }];
    let modelCalls = 0;
    const provider = createServer(async (incoming, outgoing) => {
      for await (const chunk of incoming) void chunk;
      modelCalls++;
      const reply = replies.shift();
      outgoing.writeHead(reply ? 200 : 500, { "Content-Type": "text/event-stream" });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
    });
    await listenForFetch(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing provider");
    const json = async (response: APIResponse, status = 200) => {
      expect(response.status(), await response.text()).toBe(status);
      return response.json();
    };
    try {
      // 聚合评分必须从无评分的独立样本开始，不能依赖前序 spec 没有留下演练记录。
      // 本用例只运行于隔离的 e2e 数据库，finally 恢复进入用例前的完整备份。
      const empty = await rewriteEncryptedBackup(baseline.bytes, records => {
        const manifest = records.find(record => record.kind === "manifest");
        const end = records.find(record => record.kind === "end");
        if (!manifest || !end) throw new Error("Missing backup envelope");
        manifest.files = []; manifest.sequences = {};
        end.stats = Object.fromEntries(manifest.tables.map(table => [table, 0]));
        end.totalRecords = 0; end.files = 0;
        records.splice(0, records.length, manifest, end);
      });
      expect((await postEncryptedBackup(request, "/api/backup/restore", empty)).ok()).toBe(true);
      const beforeStats = (await json(await request.get("/api/backup/stats"))).stats;
      const beforeApplications = await json(await request.get("/api/applications/stats"));
      await json(await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-stored-score-key",
        api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
      } }));
      const project = await json(await request.post("/api/projects", { data: { name: "小数评分项目" } }), 201);
      const drill = await json(await request.post("/api/drills", { data: { project_id: project.id, count: 1 } }), 201);
      const resume = await json(await request.post("/api/resumes", { data: { title: "小数评分简历" } }), 201);
      const version = await publishResume(request, resume.id);
      for (const role of ["接口开发", "测试开发"]) {
        await json(await request.post("/api/applications", { data: { company: "同一公司", role, stage: "applied" } }), 201);
      }
      const created = await request.post("/api/interviews", { data: { resume_id: resume.id, resume_version_id: version.id, jd: "接口校验", rounds: 3 } });
      expect(created.status()).toBe(200);
      const events = await created.text();
      const match = events.match(/event: done\ndata: ([^\n]+)/);
      expect(match, events).not.toBeNull();
      const interview = JSON.parse(match![1]!);
      const drillEndpoint = `/api/drills/${drill.id}`;
      const interviewEndpoint = `/api/interviews/${interview.id}`;
      const drillId = (await json(await request.get(drillEndpoint))).questions[0].id;
      const turnId = (await json(await request.get(interviewEndpoint))).turns[0].id;
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const homeScore = page.getByRole("link").filter({ hasText: "历史四维均分" });
      await expect(homeScore.getByText("暂无评分", { exact: true })).toBeVisible();
      await expect(homeScore).toContainText("练习或模考评分后显示");
      const training = page.getByRole("link").filter({ hasText: "模考与练习" });
      await expect(training.getByText(String(beforeStats.interviews + beforeStats.drills + 2), { exact: true })).toBeVisible();
      await expect(training).toContainText("条演练记录");
      await expect(training).toContainText(`${beforeStats.interviews + 1} 场模考 · ${beforeStats.drills + 1} 组练习`);
      await expect(page.getByRole("link").filter({ hasText: "推进中的投递" }).getByText(String(beforeApplications.totalActive + 2), { exact: true })).toBeVisible();
      await expect(page.getByRole("link").filter({ hasText: "维护简历" }).getByText(String(beforeStats.resumes + 1), { exact: true })).toBeVisible();
      await expect(page.getByText(/场模拟已完成|四维综合胜率/)).toHaveCount(0);
      expect((await json(await request.get(interviewEndpoint))).status).toBe("ongoing");
      expect((await json(await request.get(drillEndpoint))).questions[0].answered_at).toBe("");
      await training.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`home-unscored-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const seed = await exportEncryptedBackup(request);
      expect(seed.response.ok()).toBe(true);
      const bytes = await rewriteEncryptedBackup(seed.bytes, records => {
        for (const [table, id, value] of [["drill_questions", drillId, 8.2], ["interview_turns", turnId, 7.4]] as const) {
          const row = records.find(record => record.kind === "row" && record.table === table && record.data.id === id);
          if (!row || row.kind !== "row") throw new Error("Missing seeded answer");
          Object.assign(row.data, { scores: JSON.stringify(uniform(value)), answer: "个人负责校验 <T> &amp;，收益未验证。", comment: "历史点评", answered_at: "2026-11-01T00:00:00.000Z" });
        }
      });
      expect((await postEncryptedBackup(request, "/api/backup/restore", bytes, { preserveAiConfig: true })).ok()).toBe(true);
      for (const [source, source_id] of [["drill", drillId], ["interview", turnId]] as const) {
        await json(await request.post("/api/notebook", { data: { source, source_id } }), 201);
      }
      const storedRows = async () => {
        const backup = await exportEncryptedBackup(request);
        expect(backup.response.ok()).toBe(true);
        let rows: unknown[] = [];
        await rewriteEncryptedBackup(backup.bytes, records => {
          rows = records.filter(record => record.kind === "row" && ["drills", "drill_questions", "interviews", "interview_turns", "notebook_entries", "review_cards", "applications", "application_stage_history"].includes(record.table));
        });
        return rows;
      };
      const before = await storedRows();
      const mutations: string[] = [];
      page.on("request", sent => { if (sent.url().includes("/api/") && sent.method() !== "GET") mutations.push(sent.url()); });
      await page.goto("/");
      await expect.soft(homeScore.getByText("7.8", { exact: true })).toBeVisible();
      await homeScore.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`scores-home-${width}.png`) });
      await page.goto("/review");
      const reviewScore = page.getByText("本次统计综合均分", { exact: true }).locator("..");
      await expect.soft(reviewScore.getByText("7.8", { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`scores-review-${width}.png`) });
      const review = await json(await request.get("/api/review"));
      expect.soft(review).toMatchObject({ overall: uniform(7.8), overallScore: 7.8, drillAvg: uniform(8.2), interviewAvg: uniform(7.4), projects: [{ id: project.id, name: "小数评分项目", answers: 1, overall: 8.2 }] });
      for (const [endpoint, score] of [[interviewEndpoint, 7.4], [drillEndpoint, 8.2]] as const) {
        await page.goto(endpoint.replace("/api", ""));
        await expect.soft(page.getByText(String(score), { exact: true })).toHaveCount(4);
        const detail = await json(await request.get(endpoint));
        expect.soft((detail.turns ?? detail.questions)[0].scores).toEqual(uniform(score));
        await page.getByText("技术深度", { exact: false }).first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`scores-${score}-${width}.png`) });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      await page.goto("/notebook");
      const notebook = await json(await request.get("/api/notebook"));
      for (const entry of notebook.items) {
        const score = entry.source === "interview" ? 7.4 : 8.2;
        expect.soft(entry.scores).toEqual(uniform(score));
        await page.getByRole("article", { name: `错题 #${entry.id}`, exact: true }).getByRole("button", { name: "展开温习", exact: true }).click();
        const region = page.getByRole("region", { name: `错题 #${entry.id} 温习内容`, exact: true });
        await expect.soft(region.getByText(String(score), { exact: true })).toHaveCount(4);
        await region.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`scores-notebook-${score}-${width}.png`) });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      expect(await storedRows()).toEqual(before);
      expect(modelCalls).toBe(2);
      expect(mutations).toEqual([]);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
