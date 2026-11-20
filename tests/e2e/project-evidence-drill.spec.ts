import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { emptySummary } from "../../src/lib/summary";

test("DOCX 摘录将带特殊字符的正文与定位片段分开保存并回看", async ({ page, request }) => {
  const prose = 'a < b && b > c; &lt;literal&gt; 😀';
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const paragraph = (text: string) => `<w:p><w:r><w:t>${escape(text)}</w:t></w:r></w:p>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph(prose)}<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc>${paragraph("本人只参与测试，尚未上线。")}</w:tc></w:tr></w:tbl></w:body></w:document>`);
  const { id } = await (await request.post("/api/projects", { data: { name: "表格摘录来源" } })).json();
  try {
    const upload = await request.post(`/api/projects/${id}/materials`, { multipart: {
      title: "设计依据", file: { name: "evidence.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await zip.generateAsync({ type: "nodebuffer" }) },
    } });
    expect(upload.status(), await upload.text()).toBe(201);
    const { id: mid } = await upload.json();
    const detail = await (await request.get(`/api/projects/${id}/materials/${mid}`)).json();
    const quote = (detail.content as string).trimEnd();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`/knowledge/${id}`);
    await page.getByLabel("依据来源").selectOption(`material:${mid}`);
    await expect(page.getByLabel("结束行", { exact: true })).toBeVisible();
    await page.getByLabel("结束行", { exact: true }).fill(String(quote.split("\n").length));
    await page.getByRole("button", { name: "创建依据深挖题", exact: true }).click();
    await page.getByRole("link", { name: "开始答辩练习 →" }).click();
    await expect(page).toHaveURL(/\/drills\/\d+$/);
    await page.reload();
    const question = page.getByText(/依据快照：材料#/).first();
    await expect(question).toContainText("Word 分段引用");
    await expect(question).toContainText(prose);
    const segments = [...(await question.innerText()).matchAll(/^(正文|表格定位说明)：(".*")$/gm)]
      .map(([, kind, value]) => ({ kind, text: JSON.parse(value!) as string }));
    expect(segments.map(segment => segment.text).join("")).toBe(quote);
    expect(segments.filter(segment => segment.kind === "表格定位说明").map(segment => segment.text))
      .toEqual(detail.tableProvenance.markers.map((marker: { start: number; end: number }) => detail.content.slice(marker.start, marker.end)));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { expect((await request.delete(`/api/projects/${id}`)).status()).toBe(200); }
});

for (const width of [390, 1280]) test(`零材料的已保存档案可选且刷新后仍可用 ${width}px`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 900 });
  const created = await request.post("/api/projects", { data: { name: "仅档案依据" } });
  const { id } = await created.json();
  const architecture = "当前方案待核实。".repeat(40) + "采用同步写入，尚未验证容量。";
  try {
    expect((await request.patch(`/api/projects/${id}`, { data: { summary: { ...emptySummary(), architecture }, expectedRevisionId: 0 } })).ok()).toBe(true);
    await page.goto(`/knowledge/${id}`);
    await expect(page.getByLabel("依据来源")).toBeEnabled();
    await page.reload();
    await page.getByLabel("依据来源").selectOption("summary:architecture");
    await expect(page.getByLabel("档案摘录（连续原文，最多 280 字）")).toHaveValue(architecture.slice(0, 280));
    await page.getByRole("textbox", { name: "架构设计", exact: true }).fill("未保存的新草稿");
    await page.getByLabel("档案摘录（连续原文，最多 280 字）").fill("采用同步写入，尚未验证容量。");
    await page.locator("section").filter({ has: page.getByRole("heading", { name: "指着材料追问" }) }).screenshot({ path: `test-results/summary-evidence-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "创建依据深挖题", exact: true }).click();
    await page.getByRole("link", { name: "开始答辩练习 →" }).click();
    await expect(page.getByText(/档案二手总结，待核实/).first()).toBeVisible();
    await expect(page.getByText(/未保存的新草稿/)).toHaveCount(0);
  } finally { expect((await request.delete(`/api/projects/${id}`)).status()).toBe(200); }
});

test("空来源直接读取已记录仓库，不运行总结；刷新后可再次读取并建题", async ({ page, request }) => {
  const prefix = "resume-life-evidence-source-e2e-";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(directory, "package.json"), '{"name":"evidence-fixture"}');
  fs.writeFileSync(path.join(directory, "index.ts"), "export const capacity = 10;\n// capacity has not been measured");
  const { id } = await (await request.post("/api/projects", { data: { name: "仅代码依据" } })).json();
  let summaryCalls = 0;
  page.on("request", req => { if (/\/(scan-repo|summarize)/.test(req.url()) && req.method() === "POST") summaryCalls++; });
  try {
    await page.goto(`/knowledge/${id}`);
    await expect(page.getByLabel("依据来源")).toBeDisabled();
    await page.getByLabel("本地工程路径").fill(directory);
    await page.getByLabel("本地工程路径").press("Enter");
    await page.reload();
    await page.getByRole("button", { name: "从已记录目录读取代码" }).click();
    const source = page.getByLabel("依据来源");
    await expect(source.locator("option").filter({ hasText: "index.ts" })).toHaveCount(1);
    await source.selectOption({ label: await source.locator("option").filter({ hasText: "index.ts" }).innerText() });
    await page.getByRole("button", { name: "创建依据深挖题", exact: true }).click();
    await page.getByRole("link", { name: "开始答辩练习 →" }).click();
    await expect(page.getByText(/export const capacity = 10;/).first()).toBeVisible();
    expect(summaryCalls).toBe(0);
    const detail = await (await request.get(`/api/projects/${id}`)).json();
    expect(detail.summary).toEqual(emptySummary());
    expect(detail.materials_total).toBe(0);
  } finally {
    expect((await request.delete(`/api/projects/${id}`)).status()).toBe(200);
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error("Unsafe cleanup path");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

for (const width of [390, 1280]) test(`从设计材料定位建题并重新打开 ${width}px`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 900 });
  const created = await request.post("/api/projects", { data: { name: "依据条件演练" } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  try {
    const longLine = `const key = "${"x".repeat(200)}";`;
    const material = await request.post(`/api/projects/${id}/materials`, { data: { title: "订单设计", content: `背景\n采用同步写入\n尚未验证容量\n${longLine}` } });
    expect(material.status()).toBe(201);
    const { id: mid } = await material.json();
    await page.goto(`/knowledge/${id}`);
    await page.getByLabel("依据来源").selectOption(`material:${mid}`);
    await expect(page.getByText("1  背景", { exact: false })).toBeVisible();
    await page.getByLabel("结束行", { exact: true }).fill("3");
    await page.getByLabel("起始行", { exact: true }).fill("2");
    await page.getByLabel("原条件与约束（可留空）").fill("当前容量未知");
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "指着材料追问" }) });
    await expect(panel.locator("pre")).toContainText(longLine);
    expect(await panel.locator("pre").evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await panel.screenshot({ path: `test-results/project-evidence-panel-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "创建依据深挖题", exact: true }).click();
    await page.getByRole("link", { name: "开始答辩练习 →" }).click();
    await expect(page.getByText(/依据快照：材料#/).first()).toBeVisible();
    await expect(page.getByText(/假设请求流量增至原来的十倍/).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(/订单设计 L2–L3/).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/project-evidence-${width}.png`, fullPage: true });
  } finally { expect((await request.delete(`/api/projects/${id}`)).status()).toBe(200); }
});
