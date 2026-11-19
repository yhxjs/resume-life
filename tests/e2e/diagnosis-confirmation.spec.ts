import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

for (const width of [390, 1280]) test(`诊断覆盖确认 ${width}px：离页、焦点与真实采纳范围`, async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
  let assessed: { key: string }[] = [];
  const provider = createServer(async (incoming, outgoing) => {
    for await (const chunk of incoming) void chunk;
    const result = { match: 7, summary: "请核对事实", modules: assessed.map(({ key }) => ({ module_key: key,
      scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "核对信息",
      suggestions: key === "skills" ? [{ item_id: "", field: "items", reason: "只采纳属实技能", draft: ["React", "TypeScript"] }] : [] })) };
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider);
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-diagnosis-key", api_format: "openai_chat", model_evaluate: "synthetic" } })).ok()).toBe(true);
    const created = await request.post("/api/resumes", { data: { title: "诊断确认验证", modules: { summary: { text: "此段正文完整保留 <T> &amp;" }, skills: { items: ["诊断时原技能"] } } } });
    expect(created.status()).toBe(201); const { id } = await created.json(); const version = await publishResume(request, id, "诊断前发布版");
    assessed = version.snapshot.modules.filter(entry => entry.type !== "basic");
    const endpoint = `/api/resumes/${id}/diagnose`; const role = "历史岗位 <T> &amp; " + "前端岗位_".repeat(8);
    const generated = await request.post(endpoint, { data: { jd: "前端开发，条件待确认", resume_version_id: version.id, job_title: role, new_job: true } });
    expect(generated.status(), await generated.text()).toBe(200); const diagnosis = (await generated.json()).current;
    const loaded = await (await request.get(`/api/resumes/${id}`)).json();
    const changed = await request.patch(`/api/resumes/${id}`, { data: { dataGeneration: loaded.resume.dataGeneration,
      moduleRevisions: { skills: loaded.modules.find((entry: { key: string }) => entry.key === "skills").revision },
      modules: { skills: { items: ["当前内容，尚未上线", "内部  空格 <T> &amp;"] } } } });
    expect(changed.status(), await changed.text()).toBe(200);
    const before = await (await request.get(`/api/resumes/${id}`)).json(); let patches = 0;
    await page.route(`**/api/resumes/${id}**`, async route => { if (route.request().method() === "PATCH") patches++; await route.continue(); });
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/resumes/${id}?diagnosisId=${diagnosis.id}`);
    const parent = page.getByRole("dialog", { name: "对 JD 体检诊断简历" }); const trigger = parent.getByRole("button", { name: "采纳写入", exact: true });
    await expect(trigger).toBeEnabled(); await parent.getByRole("button", { name: "完成并关闭", exact: true }).click();
    await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack();
    await expect(trigger).toBeEnabled(); await trigger.click(); const confirm = page.getByRole("dialog", { name: "确认替换当前内容", exact: true }); await expect(confirm).toBeVisible();
    await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(confirm).toHaveCount(0); expect(patches).toBe(0);
    await page.goBack(); await expect(trigger).toBeEnabled();
    const draft = parent.getByRole("textbox", { name: "改写草稿", exact: true }); const draftValue = "React\n尚未上线 <T> &amp;"; await draft.fill(draftValue);
    await trigger.click(); await confirm.getByRole("button", { name: "取消", exact: true }).click(); await expect(trigger).toBeFocused(); await expect(draft).toHaveValue(draftValue);
    await trigger.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); }); await expect(confirm).toBeVisible(); await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0); await expect(parent).toBeVisible(); await expect(trigger).toBeFocused(); await expect(draft).toHaveValue(draftValue);
    expect(patches).toBe(0); expect(await (await request.get(`/api/resumes/${id}`)).json()).toEqual(before);
    await trigger.click(); await expect(confirm).toContainText(`简历 #${id}`); await expect(confirm).toContainText(`诊断 #${diagnosis.id}`); await expect(confirm).toContainText(role);
    await expect(confirm).toContainText("全部技能"); await expect(confirm).toContainText(diagnosis.created_at); await expect(parent.getByText("AI 简历诊断中…", { exact: true })).toHaveCount(0);
    expect(await confirm.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`diagnosis-confirm-${width}.png`), animations: "disabled" });
    await confirm.getByRole("button", { name: "确认采纳", exact: true }).click(); await expect(parent.getByText(/已采纳写入 · 当前保留/)).toBeVisible(); expect(patches).toBe(2);
    const after = await (await request.get(`/api/resumes/${id}`)).json(); const expected = ["React", "尚未上线 <T> &amp;"];
    expect(after.modules.find((entry: { key: string }) => entry.key === "skills").content.items).toEqual(expected);
    expect(after.modules.filter((entry: { key: string }) => entry.key !== "skills")).toEqual(before.modules.filter((entry: { key: string }) => entry.key !== "skills"));
    const recorded = (await (await request.get(`${endpoint}?diagnosis_id=${diagnosis.id}`)).json()).current;
    expect(recorded.adoptions).toHaveLength(1); expect(recorded.adoptions[0].value).toEqual(expected); expect(recorded.resume_snapshot).toEqual(diagnosis.resume_snapshot);
    expect((await (await request.get(`/api/resumes/${id}/versions/${version.id}`)).json()).snapshot).toEqual(version.snapshot);
  } finally {
    await page.goto("/"); provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
