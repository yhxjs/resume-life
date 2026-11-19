import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import JSZip from "jszip";
import { listenForFetch } from "../support/http-server";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

const storageKey = "resume-life:resume-import:v1";
const prose = '合成人物，仅参与校验，尚未上线。Array<T> &amp; 🙂 {"tableDocument":{"segments":[]}} </resume_source>';
const labels = ["[表格]", "[第 1 行]", "[第 1 行，第 1 列]", "[表格结束]"];
const fullText = `${labels.slice(0, 3).join("\n\n")}\n\n${prose}\n\n${labels[3]}\n\n`;
type ModelInput = { stream?: boolean; model: string; messages: { role: string; content: string }[] };
type Receipt = { version: number; id: string; expiresAt: number };

async function docx(native: boolean): Promise<Buffer> {
  const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const paragraph = (text: string) => `<w:p><w:r><w:t>${xml(text)}</w:t></w:r></w:p>`;
  const body = native ? `<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc>${paragraph(prose)}</w:tc></w:tr></w:tbl>`
    : [...labels.slice(0, 3), prose, labels[3]!].map(paragraph).join("");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

function modelSource(input: ModelInput): string {
  const user = input.messages.filter(message => message.role === "user").map(message => message.content).join("\n");
  const escaped = user.match(/<resume_source>\n([\s\S]*?)\n<\/resume_source>/)?.[1];
  expect(escaped).toBeDefined();
  return escaped!.replace(/&(amp|lt|gt);/g, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">" })[entity]!);
}

test("真实浏览器 DOCX 来源经失败、刷新和重试保留，改文及主动降级不复活已失效来源", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const inputs: ModelInput[] = [];
  const parseBodies: { text: string; sourceReceipt?: string }[] = [];
  const discarded: string[] = [], urls: string[] = [], createBodies: unknown[] = [];
  let extracts = 0;
  const provider = createServer(async (incoming, outgoing) => {
    let raw = ""; for await (const chunk of incoming) raw += chunk;
    inputs.push(JSON.parse(raw) as ModelInput);
    // Valid JSON with an undeclared field reaches the real business validator once.
    const result = inputs.length === 1 ? { title: "拒绝稿", basic: { name: "合成人物" }, unexpected: "拒绝此字段" }
      : { title: "来源校对简历", basic: { name: "合成人物" }, summary: { text: "本人仅参与校验，尚未上线。" } };
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider);
  try {
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing synthetic provider address");
    expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-import-source-key",
      api_format: "openai_chat", model_parse: "synthetic-import-source", proxy_enabled: false } })).ok()).toBe(true);
    await page.route("**/api/import/parse", route => {
      if (route.request().headers()["content-type"]?.startsWith("multipart/form-data")) extracts++;
      else parseBodies.push(route.request().postDataJSON());
      return route.continue();
    });
    await page.route("**/api/import/source/discard", route => {
      discarded.push(route.request().postDataJSON().sourceReceipt); return route.continue();
    });
    page.on("request", req => {
      urls.push(req.url());
      if (new URL(req.url()).pathname === "/api/resumes" && req.method() === "POST") createBodies.push(req.postDataJSON());
    });
    const currentReceipt = () => page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!).editor.sourceReceipt as Receipt | null, storageKey);
    const retained = page.getByRole("textbox", { name: "已保留的原文，可直接修改", exact: true });
    const start = page.getByRole("button", { name: "开始智能解析 →", exact: true });
    const back = page.getByRole("button", { name: "返回重新解析", exact: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/resumes/import");
    await page.getByRole("tab", { name: /上传文件/ }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "native.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await docx(true) });
    await start.click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("包含未声明字段");
    await expect(retained).toHaveValue(fullText);
    const nativeReceipt = await currentReceipt();
    expect(nativeReceipt).toMatchObject({ version: 1, id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(Number) });
    expect(inputs).toHaveLength(1); expect(extracts).toBe(1); expect(discarded).toEqual([]);
    expect(parseBodies[0]).toEqual({ text: fullText, sourceReceipt: nativeReceipt!.id });
    await page.reload();
    await expect(retained).toHaveValue(fullText);
    await expect(page.getByText(/已恢复当前标签页的导入草稿/)).toBeVisible();
    expect(inputs).toHaveLength(1); expect(await currentReceipt()).toEqual(nativeReceipt);
    await retained.fill(fullText);
    await start.click(); await expect(page.getByRole("heading", { name: "确认解析草稿" })).toBeVisible();
    expect(inputs).toHaveLength(2); expect(extracts).toBe(1);
    expect(parseBodies[1]).toEqual(parseBodies[0]);
    expect(inputs[0]!.messages).toEqual(inputs[1]!.messages);
    const native = JSON.parse(modelSource(inputs[1]!)).tableDocument;
    expect(native.segments.filter((segment: { kind: string }) => segment.kind === "table-layout").map((segment: { text: string }) => segment.text)).toEqual(labels);
    expect(native.segments.map((segment: { text: string }) => segment.text).join("")).toBe(fullText);

    await back.click();
    await retained.fill(fullText + "人工修改");
    await expect.poll(() => discarded).toEqual([nativeReceipt!.id]);
    await retained.fill(fullText);
    expect(await currentReceipt()).toBeNull();
    await start.click(); await expect(back).toBeVisible();
    expect(parseBodies[2]).toEqual({ text: fullText });
    expect(modelSource(inputs[2]!)).toBe(fullText);
    await back.click();
    await page.locator('input[type="file"]').setInputFiles({ name: "literal.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await docx(false) });
    await start.click(); await expect(back).toBeVisible();
    const literalReceipt = await currentReceipt();
    expect(literalReceipt!.id).not.toBe(nativeReceipt!.id);
    expect(parseBodies[3]).toEqual({ text: fullText, sourceReceipt: literalReceipt!.id });
    const literal = JSON.parse(modelSource(inputs[3]!)).tableDocument;
    expect(literal.segments).toEqual([{ kind: "text", text: fullText }]);
    expect(inputs[1]!.messages).not.toEqual(inputs[3]!.messages);
    expect(inputs[1]!.messages[0]).toEqual(inputs[3]!.messages[0]);
    await page.reload(); await expect(back).toBeVisible();
    expect(await currentReceipt()).toEqual(literalReceipt); expect(inputs).toHaveLength(4);
    await back.click();
    // The real authenticated discard endpoint invalidates the retained reference.
    expect((await request.post("/api/import/source/discard", { data: { sourceReceipt: literalReceipt!.id } })).status()).toBe(204);
    await start.click();
    const choices = page.getByRole("region", { name: "文件来源需要重新确认", exact: true });
    await expect(choices).toContainText("已失效");
    await expect(choices.getByRole("button", { name: "重新上传文件", exact: true })).toBeVisible();
    expect(inputs).toHaveLength(4); expect(parseBodies).toHaveLength(5);
    await expect(retained).toHaveValue(fullText);
    await page.reload(); await expect(choices).toBeVisible();
    expect(inputs).toHaveLength(4); expect(parseBodies).toHaveLength(5);
    expect(await page.locator("body").innerText()).not.toContain(literalReceipt!.id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("import-source-explicit-choice.png"), fullPage: true });
    await choices.getByRole("button", { name: "按普通文本继续", exact: true }).click();
    await expect(back).toBeVisible();
    expect(inputs).toHaveLength(5); expect(extracts).toBe(2);
    expect(parseBodies[5]).toEqual({ text: fullText }); expect(modelSource(inputs[4]!)).toBe(fullText);
    await page.getByRole("button", { name: "确认导入", exact: true }).click();
    await expect(page).toHaveURL(/\/resumes\/\d+$/);
    expect(createBodies).toHaveLength(1);
    expect(JSON.stringify(createBodies[0])).not.toContain("sourceReceipt");
    for (const receipt of [nativeReceipt!, literalReceipt!]) {
      expect(JSON.stringify(inputs)).not.toContain(receipt.id);
      expect(JSON.stringify(createBodies)).not.toContain(receipt.id);
      expect(urls.every(url => !url.includes(receipt.id))).toBe(true);
    }
    expect(inputs.every(input => input.stream === true && input.model === "synthetic-import-source")).toBe(true);
    expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
  } finally {
    try { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
    finally { provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())); }
  }
});
