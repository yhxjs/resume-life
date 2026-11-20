import { expect, test } from "@playwright/test";

const original = "Assisted with weekly stock counts and recorded discrepancies in Excel. The supervisor handled purchasing decisions. No change in stock losses was measured.";
const condensed = "Assisted with weekly stock counts and recorded discrepancies in Excel; the supervisor handled purchasing decisions. No stock-loss change was measured.";

for (const width of [390, 1280]) test(`编辑与连续精简保留原始事实，采用和导出不带错误成果 (${width}px)`, async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const created = await request.post("/api/resumes", { data: { title: `Synthetic stock assistant ${width}`, modules: { work: [
    { id: "synthetic-stock-helper", company: "Synthetic Stockroom", title: "Stock assistant", description: original, descriptionItems: [original] },
  ] } } });
  expect(created.status()).toBe(201);
  const root = `/api/resumes/${(await created.json()).id}`;
  const bodies: Record<string, unknown>[] = [];
  await page.route(`**${root}/polish`, async route => {
    bodies.push(route.request().postDataJSON());
    // 错误草稿为合成的对抗输入；模型是否纠正另由真实提示词评测核对。
    const text = bodies.length === 1 ? "Led purchasing decisions and reduced stock losses by 30%." : condensed;
    await route.fulfill({ json: { result: {
      star: null, quantifiedTips: [], draft: `• ${text}`, draftItems: [text],
      draftItemDetails: [{ text, sourceIndices: [1] }], highlights: [],
    } } });
  });
  try {
    await page.goto(root.replace("/api/", "/"));
    await page.getByRole("tab", { name: "工作经历", exact: true }).click();
    await page.getByRole("button", { name: "✨ STAR 润色与量化", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("目标岗位/偏向（选填）").fill("Stock assistant, UK; English CV");
    await dialog.getByRole("button", { name: "开始 AI 智能润色", exact: true }).click();
    const item = dialog.getByLabel("经历条目第 1 项", { exact: true });
    await expect(item).toContainText("30%");
    await item.fill("Assisted with stock records; stock losses fell by 30%.");
    await dialog.getByRole("button", { name: "智能精简合并", exact: true }).click();
    await expect(item).toHaveText(condensed);

    // 整段改写后来源关联未知，先保留草稿并允许用户恢复关联，不能当成无原始事实。
    const edited = condensed.replace("; the supervisor", ". The supervisor");
    await dialog.getByRole("button", { name: "📄 整段编辑", exact: true }).click();
    await dialog.getByLabel("推荐排版草稿", { exact: true }).fill(`• ${edited}`);
    await dialog.getByRole("button", { name: "• 多项列表（推荐）", exact: true }).click();
    await dialog.getByRole("button", { name: "智能精简合并", exact: true }).click();
    await expect(dialog.getByTestId("condense-error")).toContainText("当前草稿已保留");
    await expect(item).toHaveText(edited);
    expect(bodies).toHaveLength(2);
    await dialog.getByRole("button", { name: "点击关联段落 1", exact: true }).click();
    await dialog.getByRole("button", { name: "智能精简合并", exact: true }).click();
    await expect.poll(() => bodies.length).toBe(3);
    await expect(dialog.getByRole("button", { name: "智能精简合并", exact: true })).toBeEnabled();
    for (const body of bodies.slice(1)) {
      expect(body.originalSourceParagraphs).toEqual([original]);
      expect(body.mode).toBe("condense");
      expect(body.moduleType).toBe("work");
    }
    expect(bodies[1]!.text).toContain("30%");
    expect(bodies[2]!.text).toContain(edited);
    await expect(dialog.getByTestId("condense-error")).toHaveCount(0);
    await dialog.getByRole("button", { name: "展开第 1 项来源原文对比", exact: true }).click();
    await expect(dialog.getByTestId("source-comparison-0")).toContainText(original);
    await expect(dialog.getByText("二次精简会对照本轮原始资料。", { exact: false })).toBeVisible();
    await dialog.getByTestId("source-comparison-0").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("resume-polish-facts.png") });
    await dialog.getByRole("button", { name: "确认写入简历", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => JSON.stringify((await (await request.get(root)).json()).modules))
      .toContain(condensed);
    const exported = await request.post(`${root}/export`, { data: {} });
    expect(exported.status()).toBe(200);
    const markdown = await exported.text();
    expect(markdown).toContain(condensed);
    expect(markdown).not.toContain("30%");
    expect(markdown).not.toContain("Led purchasing");
  } finally {
    await page.goto("/resumes");
    expect((await request.delete(root)).status()).toBe(200);
  }
});

for (const text of ["[待補充：本人實際職責]", "[To add: actual responsibilities]"]) test(`常规导出识别多语言待填标记：${text}`, async ({ request }) => {
  const created = await request.post("/api/resumes", { data: { title: "Synthetic incomplete draft", modules: { summary: { text } } } });
  expect(created.status()).toBe(201);
  const root = `/api/resumes/${(await created.json()).id}`;
  try {
    for (const suffix of ["", "/pdf", "/docx"]) {
      const response = await request.post(`${root}/export${suffix}`, { data: {} });
      expect(response.status()).toBe(409);
      const body = await response.json();
      expect(body.issues.some((issue: { kind: string }) => issue.kind === "placeholder")).toBe(true);
    }
  } finally {
    expect((await request.delete(root)).status()).toBe(200);
  }
});

test("繁体中文正常职责可导出 Markdown、PDF 和 DOCX", async ({ request }) => {
  const text = "協助客戶完成申請填寫及文件核實。跟進待確認訂單並協助主管核實資料。";
  const created = await request.post("/api/resumes", { data: {
    title: "Synthetic service duties", modules: { work: [{ id: "service-duties", description: text }] },
  } });
  expect(created.status()).toBe(201);
  const root = `/api/resumes/${(await created.json()).id}`;
  try {
    for (const [suffix, contentType] of [
      ["", "text/markdown"], ["/pdf", "application/pdf"],
      ["/docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ]) {
      const response = await request.post(`${root}/export${suffix}`, { data: {} });
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain(contentType);
      if (!suffix) expect(await response.text()).toContain(text);
      else expect((await response.body()).length).toBeGreaterThan(0);
    }
  } finally {
    expect((await request.delete(root)).status()).toBe(200);
  }
});
