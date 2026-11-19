import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

const jd = "  接口校验 <T> &amp;\n职责与结果待验证  ";
const text = "只参与接口校验，尚未上线。";
const conflict = "参考简历或所选发布版本已变化或删除，请核对材料后重新生成";

for (const width of [390, 1280]) for (const preparation of [false, true]) test(`自我介绍创建 ${width}px：${preparation ? "投递 JD 改变" : "简历删除"}拒绝晚到结果，显式重试才创建`, async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const entered = gate();
  const release = gate();
  let modelCalls = 0;
  let posts = 0;
  const payloads: string[] = [];
  const provider = createServer(async (incoming, outgoing) => {
    let raw = "";
    for await (const chunk of incoming) raw += chunk;
    payloads.push(raw);
    modelCalls++;
    if (modelCalls === 2) { entered.release(); await release.promise; }
    const content = JSON.stringify({ versions: ["30s", "2min"].map(kind => ({ kind, sentences: [{ text, comment: "保留个人职责。" }] })) });
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider);
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: {
      base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-intro-create-context-key",
      api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
    } })).ok()).toBe(true);
    const makeResume = async (title: string) => {
      const response = await request.post("/api/resumes", { data: { title, modules: { summary: { text: `${title}：仅参与接口校验。` } } } });
      expect(response.status()).toBe(201);
      const resume = await response.json();
      return { ...resume, version: await publishResume(request, resume.id) };
    };
    const other = await makeResume("另一份有效材料");
    const source = await makeResume("原选发布材料");
    const oldCreation = await request.post("/api/intros", { data: { resume_id: other.id, resume_version_id: other.version.id, jd: "另一份历史记录" } });
    const oldMatch = (await oldCreation.text()).match(/event: done\ndata: ([^\n]+)/);
    expect(oldMatch).not.toBeNull();
    const oldId = JSON.parse(oldMatch![1]!).id;
    const old = await (await request.get(`/api/intros/${oldId}`)).json();
    let applicationId = 0;
    if (preparation) {
      const application = await request.post("/api/applications", { data: {
        company: "创建依据验证", role: "接口校验", resume_id: source.id, resume_version_id: source.version.id, jd: jd.trim(),
      } });
      expect(application.status()).toBe(201);
      applicationId = (await application.json()).id;
    }
    await page.route("**/api/intros", route => {
      if (route.request().method() === "POST") posts++;
      return route.continue();
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(preparation ? `/applications/${applicationId}/prepare` : "/intros");
    if (!preparation) {
      await page.getByRole("combobox", { name: "选择参考简历", exact: true }).selectOption(String(source.id));
      await page.getByRole("combobox", { name: "已发布版本", exact: true }).selectOption(String(source.version.id));
      await page.getByRole("textbox", { name: "目标岗位要求（JD / 职位描述）", exact: true }).fill(jd);
    }
    await page.getByRole("button", { name: preparation ? "生成自我介绍" : "立即生成两版自我介绍", exact: true }).click();
    await entered.promise;
    if (preparation) {
      expect((await request.patch(`/api/applications/${applicationId}`, { data: { jd: "新岗位：接口兼容性与验证" } })).status()).toBe(200);
    } else {
      expect((await request.delete(`/api/resumes/${source.id}`)).status()).toBe(200);
    }
    release.release();
    const error = page.getByRole("alert").filter({ hasText: preparation ? "投递 JD 已变更" : conflict });
    await expect(error).toBeVisible();
    await expect(page).toHaveURL(preparation ? new RegExp(`/applications/${applicationId}/prepare$`) : /\/intros$/);
    if (!preparation) {
      await expect(page.getByRole("textbox", { name: "目标岗位要求（JD / 职位描述）", exact: true })).toHaveValue(jd);
      await expect(error).toContainText("请按上方提示处理后再生成");
      await expect(error).not.toContainText("仍可能已保存");
    }
    expect(posts).toBe(1);
    expect(modelCalls).toBe(2);
    expect((await (await request.get("/api/intros?limit=50")).json()).items.map((item: { id: number }) => item.id)).toEqual([oldId]);
    expect(await (await request.get(`/api/intros/${oldId}`)).json()).toEqual(old);
    if (preparation) {
      expect((await (await request.get(`/api/applications/${applicationId}/preparation`)).json()).resources.intro.total).toBe(0);
    }
    await error.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`intro-create-${preparation ? "application" : "resume"}-${width}.png`), animations: "disabled" });
    if (preparation) await page.reload();
    else {
      await page.getByRole("combobox", { name: "选择参考简历", exact: true }).selectOption(String(other.id));
      await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue(String(other.version.id));
    }
    await page.getByRole("button", { name: preparation ? "生成自我介绍" : "立即生成两版自我介绍", exact: true }).click();
    if (preparation) await expect(page.getByRole("region", { name: "自我介绍", exact: true })).toContainText(text);
    else await expect(page.getByText(text, { exact: true })).toBeVisible();
    expect(posts).toBe(2);
    expect(modelCalls).toBe(3);
    const list = await (await request.get("/api/intros?limit=50")).json();
    expect(list.items).toHaveLength(2);
    const latest = await (await request.get(`/api/intros/${list.items[0].id}`)).json();
    expect(latest).toMatchObject({ resume_id: preparation ? source.id : other.id, resume_version_id: preparation ? source.version.id : other.version.id, jd: preparation ? "新岗位：接口兼容性与验证" : jd.trim() });
    expect(latest.versions).toHaveLength(2);
    expect(await (await request.get(`/api/intros/${oldId}`)).json()).toEqual(old);
    if (preparation) {
      const resources = (await (await request.get(`/api/applications/${applicationId}/preparation`)).json()).resources.intro;
      expect(resources.total).toBe(1);
      expect(resources.items[0].id).toBe(latest.id);
      expect(payloads[2]).toContain("新岗位：接口兼容性与验证");
    } else expect(payloads[2]).toContain("另一份有效材料");
  } finally {
    release.release();
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
