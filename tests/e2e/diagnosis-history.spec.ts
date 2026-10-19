import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

test("岗位诊断历史保留快照、采纳和前后变化，刷新后仍可浏览", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  let match = 6;
  const provider = createServer(async (incoming, outgoing) => {
    for await (const chunk of incoming) void chunk;
    const reply = { match, summary: "突出岗位相关成果", modules: [{ module_key: "summary",
      scores: { depth: match, structure: 7, authenticity: 8, completeness: 7 }, gaps: "突出成果",
      suggestions: [{ item_id: "", field: "text", reason: "对齐岗位", draft: "建议的自我评价" }],
    }] };
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`,
      api_key: "synthetic-diagnosis-key", api_format: "openai_chat", model_evaluate: "synthetic" } })).ok()).toBe(true);
    const created = await request.post("/api/resumes", { data: { title: "历史验证简历",
      modules: { summary: { text: "诊断前的原评价" } } } });
    expect(created.status()).toBe(201);
    const id = (await created.json()).id;
    const firstVersion = await publishResume(request, id, "诊断前发布版");
    const diagnosisUrl = `/api/resumes/${id}/diagnose`;
    const dialog = page.getByRole("dialog", { name: "对 JD 体检诊断简历" });
    await page.goto(`/resumes/${id}`);
    await page.getByRole("button", { name: "JD 诊断", exact: true }).click();
    await expect(dialog.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue(String(firstVersion.id));
    await dialog.getByLabel("岗位名称", { exact: false }).fill("公司 A · 前端工程师");
    await dialog.getByLabel("岗位要求（JD）", { exact: true }).fill("前端开发，需要 TypeScript");
    await dialog.getByRole("button", { name: "开始诊断", exact: true }).click();
    await expect(dialog.getByText("这是该岗位的首次诊断", { exact: false })).toBeVisible();
    const first = (await (await request.get(diagnosisUrl)).json()).current;
    expect(first.resume_version_id).toBe(firstVersion.id);
    await dialog.getByText("查看诊断时的简历快照", { exact: true }).click();
    await expect(dialog.getByRole("region", { name: "诊断时简历快照" })).toContainText("诊断前的原评价");
    await dialog.getByLabel("改写草稿", { exact: false }).fill("人工调整后采纳的评价");
    await dialog.getByRole("button", { name: "采纳写入", exact: true }).click();
    await expect(dialog.getByText("已采纳写入 · 当前保留", { exact: false })).toBeVisible();
    const saved = await (await request.get(diagnosisUrl)).json();
    expect(saved.current.adoptions[0].value).toBe("人工调整后采纳的评价");
    expect(saved.current.resume_snapshot.modules.find((entry: { key: string }) => entry.key === "summary").content.text).toBe("诊断前的原评价");

    await dialog.getByRole("button", { name: "完成并关闭", exact: true }).click();
    const revisedVersion = await publishResume(request, id, "采纳建议后的发布版");
    await page.reload();
    await page.getByRole("button", { name: "JD 诊断", exact: true }).click();
    await expect(dialog.getByText("已采纳写入 · 当前保留", { exact: false })).toBeVisible();
    const adoptedDraft = dialog.getByText("改写草稿（已采纳，显示当时写入内容）", { exact: true }).locator("..");
    await expect(adoptedDraft).toContainText("人工调整后采纳的评价");
    const versionSelect = dialog.getByRole("combobox", { name: "已发布版本", exact: true });
    await expect(versionSelect).toHaveValue(String(firstVersion.id));
    await versionSelect.selectOption(String(revisedVersion.id));
    match = 8;
    await dialog.getByRole("button", { name: "按所选发布版本再次诊断", exact: true }).click();
    await expect(dialog.getByText("岗位匹配度：6 → 8（+2）", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("table", { name: "模块评分变化" })).toContainText("+2");
    await dialog.getByText("两次诊断间的内容变化（1 处）", { exact: true }).click();
    const comparison = dialog.getByRole("region", { name: "自我评价内容变化" });
    await expect(comparison).toContainText("诊断前的原评价");
    await expect(comparison).toContainText("人工调整后采纳的评价");
    const revised = (await (await request.get(diagnosisUrl)).json()).current;
    expect(revised.resume_version_id).toBe(revisedVersion.id);
    await page.screenshot({ path: testInfo.outputPath("diagnosis-history-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("diagnosis-history-mobile.png") });
    await page.setViewportSize({ width: 1280, height: 720 });

    await dialog.getByRole("button", { name: "诊断新岗位", exact: true }).click();
    await expect(versionSelect).toHaveValue(String(revisedVersion.id));
    await dialog.getByLabel("岗位名称", { exact: false }).fill("公司 B · 后端工程师");
    await dialog.getByLabel("岗位要求（JD）", { exact: true }).fill("后端开发，需要数据库经验");
    await dialog.getByRole("button", { name: "开始诊断", exact: true }).click();
    await expect(dialog.getByText("这是该岗位的首次诊断", { exact: false })).toBeVisible();
    const other = (await (await request.get(diagnosisUrl)).json()).current;
    expect(other.job_id).not.toBe(first.job_id);
    expect(other.resume_version_id).toBe(revisedVersion.id);
    await dialog.getByRole("combobox", { name: "岗位", exact: true }).selectOption(first.job_id);
    await expect(dialog.getByText("岗位匹配度：6 → 8（+2）", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "诊断历史", exact: true }).locator("option")).toHaveCount(3);
    await dialog.getByRole("combobox", { name: "诊断历史", exact: true }).selectOption(String(first.id));
    await expect(versionSelect).toHaveValue(String(firstVersion.id));
    await expect(dialog.getByText("已采纳写入 · 当前保留", { exact: false })).toBeVisible();
    await dialog.getByText("查看诊断时的简历快照", { exact: true }).click();
    await expect(dialog.getByRole("region", { name: "诊断时简历快照" })).toContainText("诊断前的原评价");
    expect((await (await request.get(diagnosisUrl)).json()).history).toHaveLength(3);
    const exported = await exportEncryptedBackup(request);
    expect(exported.response.ok()).toBe(true);
    expect((await request.delete(`/api/resumes/${id}`)).ok()).toBe(true);
    expect((await postEncryptedBackup(request, "/api/backup/restore", exported.bytes)).ok()).toBe(true);
    const restored = await (await request.get(`${diagnosisUrl}?diagnosis_id=${first.id}`)).json();
    expect(restored.history).toHaveLength(3);
    expect(restored.current.resume_version_id).toBe(firstVersion.id);
    expect(restored.current.adoptions[0].value).toBe("人工调整后采纳的评价");
    expect(restored.current.resume_snapshot.modules.find((entry: { key: string }) => entry.key === "summary").content.text).toBe("诊断前的原评价");
    const restoredVersion = await (await request.get(`/api/resumes/${id}/versions/${firstVersion.id}`)).json();
    expect(restoredVersion.snapshot.modules.find((entry: { key: string }) => entry.key === "summary").content.text).toBe("诊断前的原评价");
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
