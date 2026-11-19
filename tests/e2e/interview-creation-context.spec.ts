import { listenForFetch } from "../support/http-server";
import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

const jd = "  接口校验 <T> &amp;\n职责与结果待验证  ";
const question = "请说明你实际参与的一项接口校验任务。";
const conflict = "参考简历或所选发布版本已变化或删除，请核对材料后重新生成";
async function done(response: APIResponse) {
  expect(response.status()).toBe(200);
  const events = await response.text(); expect(events).not.toContain("event: error");
  const match = events.match(/event: done\ndata: ([^\n]+)/); expect(match, events).not.toBeNull();
  return JSON.parse(match![1]!);
}

for (const width of [390, 1280]) for (const mode of ["single", "series"]) test(`面试首题 ${width}px ${mode}：${mode === "single" ? "简历删除" : "投递 JD 变化"}拒绝晚到创建，核对后显式重试`, async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
  const entered = gate(); const release = gate(); let calls = 0; let posts = 0; const inputs: string[] = [];
  const provider = createServer(async (incoming, outgoing) => {
    let raw = ""; for await (const chunk of incoming) raw += chunk;
    inputs.push(raw); calls++;
    if (calls === 2) { entered.release(); await release.promise; }
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ question }) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider);
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: {
      base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-interview-create-context-key",
      api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
    } })).ok()).toBe(true);
    const makeResume = async (title: string) => {
      const response = await request.post("/api/resumes", { data: { title, modules: { summary: { text: `${title}：仅参与参数校验。` } } } });
      expect(response.status()).toBe(201); const resume = await response.json();
      return { ...resume, version: await publishResume(request, resume.id) };
    };
    const other = await makeResume("其他有效材料"); const source = await makeResume("原选发布材料");
    const old = await done(await request.post("/api/interviews", { data: { resume_id: other.id, resume_version_id: other.version.id, jd: "其他存档", rounds: 1 } }));
    const savedOther = await (await request.get(`/api/interviews/${old.id}`)).json();
    let applicationId = 0;
    if (mode === "series") {
      const response = await request.post("/api/applications", { data: { company: "创建材料验证", role: "接口校验", resume_id: source.id, resume_version_id: source.version.id, jd: jd.trim() } });
      expect(response.status()).toBe(201); applicationId = (await response.json()).id;
    }
    await page.route("**/api/interviews", route => { if (route.request().method() === "POST") posts++; return route.continue(); });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(mode === "series" ? `/interviews?applicationId=${applicationId}` : `/interviews?resumeId=${source.id}&resumeVersionId=${source.version.id}`);
    const input = page.getByRole("textbox", { name: "目标岗位要求（JD / 职位描述）", exact: true });
    await expect(page.getByLabel("关联简历")).toHaveValue(String(source.id));
    if (mode === "series") await page.getByRole("button", { name: "进阶三轮连打", exact: true }).click();
    else await input.fill(jd);
    await page.getByRole("spinbutton", { name: mode === "series" ? "每轮题数" : "总题数", exact: true }).fill("1");
    const startName = mode === "series" ? "开启进阶三轮连打" : "立即开启模拟实战";
    await page.getByRole("button", { name: startName, exact: true }).click(); await entered.promise;
    if (mode === "single") expect((await request.delete(`/api/resumes/${source.id}`)).status()).toBe(200);
    else expect((await request.patch(`/api/applications/${applicationId}`, { data: { jd: "新岗位：接口兼容性验证" } })).status()).toBe(200);
    release.release();
    const error = page.getByRole("alert").filter({ hasText: mode === "single" ? conflict : "投递 JD 已变更" });
    await expect(error).toBeVisible(); await expect(page).toHaveURL(mode === "single" ? /\/interviews\?resumeId=/ : new RegExp(`/interviews\\?applicationId=${applicationId}$`));
    await expect(error).not.toContainText("仍可能已保存"); await expect(error).toContainText("核对材料或配置");
    await expect(input).toHaveValue(mode === "single" ? jd : jd.trim());
    await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue(String(source.version.id));
    expect(posts).toBe(1); expect(calls).toBe(2);
    expect((await (await request.get("/api/interviews?limit=50")).json()).items.map((item: { id: number }) => item.id)).toEqual([old.id]);
    expect((await (await request.get("/api/interviews/series?limit=50")).json()).items).toEqual([]);
    expect(await (await request.get(`/api/interviews/${old.id}`)).json()).toEqual(savedOther);
    if (mode === "series") expect((await (await request.get(`/api/applications/${applicationId}/preparation`)).json()).resources.series.total).toBe(0);
    await error.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`interview-context-${mode}-${width}.png`), animations: "disabled" });
    if (mode === "series") {
      await page.reload(); await expect(input).toHaveValue("新岗位：接口兼容性验证");
      await page.getByRole("button", { name: "进阶三轮连打", exact: true }).click();
      await page.getByRole("spinbutton", { name: "每轮题数", exact: true }).fill("1");
    } else await page.getByLabel("关联简历").selectOption(String(other.id));
    await page.getByRole("button", { name: startName, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/interviews/\\d+${mode === "series" ? `\\?applicationId=${applicationId}` : ""}$`));
    const createdId = Number(new URL(page.url()).pathname.split("/").pop());
    const created = await (await request.get(`/api/interviews/${createdId}`)).json();
    expect(created).toMatchObject({ resume_id: mode === "series" ? source.id : other.id, resume_version_id: mode === "series" ? source.version.id : other.version.id,
      jd: mode === "series" ? "新岗位：接口兼容性验证" : jd.trim(), rounds: 1 });
    expect(created.turns).toHaveLength(1); expect(created.turns[0].question).toBe(question);
    expect(posts).toBe(2); expect(calls).toBe(3);
    expect(await (await request.get(`/api/interviews/${old.id}`)).json()).toEqual(savedOther);
    if (mode === "series") {
      const resources = (await (await request.get(`/api/applications/${applicationId}/preparation`)).json()).resources.series;
      expect(resources.total).toBe(1); expect(resources.items[0].id).toBe(created.series_id); expect(inputs[2]).toContain("新岗位：接口兼容性验证");
    } else expect(inputs[2]).toContain("其他有效材料");
  } finally {
    release.release(); provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});

test("旧系列推进：模型等待时实际简历草稿变化返回冲突，显式重试用新材料且原轮次不改写", async ({ request }) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
  const entered = gate(); const release = gate(); let hold = false; let calls = 0; let reply: unknown; const inputs: string[] = [];
  const provider = createServer(async (incoming, outgoing) => {
    let raw = ""; for await (const chunk of incoming) raw += chunk; inputs.push(raw); calls++;
    if (hold) { hold = false; entered.release(); await release.promise; }
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider);
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-legacy-series-key", api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic" } })).ok()).toBe(true);
    const response = await request.post("/api/resumes", { data: { title: "旧系列材料", modules: { summary: { text: "旧系列原草稿：仅参与校验。" } } } });
    expect(response.status()).toBe(201); const resume = await response.json(); const version = await publishResume(request, resume.id);
    reply = { question }; const created = await done(await request.post("/api/interviews", { data: { resume_id: resume.id, resume_version_id: version.id, jd: "接口校验", rounds: 1, mode: "series" } }));
    const endpoint = `/api/interviews/${created.id}`; const seriesEndpoint = `/api/interviews/series/${created.series_id}`;
    const turnId = (await (await request.get(endpoint)).json()).turns[0].id;
    reply = { depth: 7, structure: 7, authenticity: 8, completeness: 7, comment: "说明分工", next_kind: "question", next_question: "" };
    await done(await request.post(`${endpoint}/answer`, { data: { turn_id: turnId, answer: "仅参与校验，验收未确认。" } }));
    reply = { jd_match: 6, strengths: "分工清楚", weaknesses: "验收未确认", suggestions: "核对验证材料" };
    expect((await request.post(`${endpoint}/finish`)).status()).toBe(200);
    const seed = await exportEncryptedBackup(request); expect(seed.response.ok()).toBe(true);
    const legacy = await rewriteEncryptedBackup(seed.bytes, records => {
      for (const row of records) if (row.kind === "row" && ((row.table === "interview_series" && row.data.id === created.series_id) || (row.table === "interviews" && row.data.id === created.id))) row.data.resume_version_id = null;
    });
    expect((await postEncryptedBackup(request, "/api/backup/restore", legacy, { preserveAiConfig: true })).status()).toBe(200);
    const before = await (await request.get(seriesEndpoint)).json(); const original = await (await request.get(endpoint)).json();
    reply = { question: "请描述你核对验收边界的具体步骤。" }; hold = true;
    const pending = request.post(`${seriesEndpoint}/advance`, { data: { from_interview_id: created.id } }); await entered.promise;
    const current = await (await request.get(`/api/resumes/${resume.id}`)).json();
    const summary = current.modules.find((module: { type: string }) => module.type === "summary"); expect(summary).toBeDefined();
    expect((await request.patch(`/api/resumes/${resume.id}`, { data: { modules: { [summary.key]: { text: "旧系列新草稿：仅参与测试，未交付。" } }, moduleRevisions: { [summary.key]: summary.revision } } })).status()).toBe(200);
    release.release(); const rejected = await pending; expect(rejected.status(), await rejected.text()).toBe(409);
    expect(await rejected.json()).toEqual({ error: "参考简历或所选发布版本已变化或删除，请核对材料后重新推进" });
    expect(await (await request.get(seriesEndpoint)).json()).toEqual(before); expect(await (await request.get(endpoint)).json()).toEqual(original); expect(calls).toBe(4);
    const retry = await request.post(`${seriesEndpoint}/advance`, { data: { from_interview_id: created.id } }); expect(retry.status(), await retry.text()).toBe(201); const next = await retry.json();
    expect(next.round_no).toBe(2); expect(inputs[4]).toContain("旧系列新草稿：仅参与测试，未交付。");
    expect(await (await request.get(endpoint)).json()).toEqual({ ...original, series_rounds: [
      ...original.series_rounds, { id: next.id, round_no: 2, status: "ongoing", overall: null },
    ] });
    const again = await request.post(`${seriesEndpoint}/advance`, { data: { from_interview_id: created.id } }); expect(again.status()).toBe(201); expect(await again.json()).toEqual(next); expect(calls).toBe(5);
  } finally {
    release.release(); provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
