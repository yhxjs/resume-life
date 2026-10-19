import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import mammoth from "mammoth";
import JSZip from "jszip";
import sharp from "sharp";
import type { ResumeWithModules } from "../../src/lib/resumes";
import { mockApi } from "./synthetic-api";

async function openDocx(page: Page) {
  await page.getByRole("button", { name: "导出 / 打印" }).click();
  await page.getByRole("button", { name: /导出 Word \(\.docx\)/ }).click();
  return page.getByRole("dialog", { name: "导出前检查" });
}

test("真实 DOCX 下载包含刚编辑的正文，确认数字后才下载", async ({ page, request }) => {
  const created = await request.post("/api/resumes", { data: { title: "张三的简历", modules: {
    basic: { name: "张三", phone: "13800000000", email: "zhangsan@example.com" },
    work: [{ company: "示例公司", title: "工程师", description: "效率提升 40%" }],
  } } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  try {
    const draft = await (await request.get(`/api/resumes/${id}`)).json();
    const added = await request.patch(`/api/resumes/${id}`, { data: { dataGeneration: draft.resume.dataGeneration, addModule: { type: "custom", label: "开源贡献" } } });
    expect(added.ok()).toBe(true);
    const data = await added.json() as ResumeWithModules & { addedKey: string };
    const extra = data.modules.find((mod) => mod.key === data.addedKey)!;
    expect((await request.patch(`/api/resumes/${id}`, { data: {
      modules: { [extra.key]: [{ title: "开源贡献", description: "开源工具维护" }] }, moduleRevisions: { [extra.key]: extra.revision },
    } })).ok()).toBe(true);
    await page.goto(`/resumes/${id}`);
    await page.getByLabel("姓名", { exact: true }).fill("张小三");
    const check = await openDocx(page);
    await expect(check.getByRole("button", { name: "继续导出" })).toBeDisabled();
    for (const checkbox of await check.getByRole("checkbox").all()) await checkbox.check();
    const downloaded = page.waitForEvent("download");
    await check.getByRole("button", { name: "继续导出" }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("张三的简历.docx");
    const buffer = await fs.readFile((await download.path())!);
    const { value: text } = await mammoth.extractRawText({ buffer });
    expect(text).toContain("张小三");
    expect(text).toContain("效率提升 40%");
    expect(text).toContain("开源工具维护");
    const again = await openDocx(page);
    await expect(again.getByRole("button", { name: "继续导出" })).toBeDisabled();
  } finally {
    await request.delete(`/api/resumes/${id}`);
  }
});

test("脱敏 DOCX 的正文和下载文件名均使用脱敏内容，移动端按钮可用", async ({ page, request }) => {
  const created = await request.post("/api/resumes", { data: { title: "张三的简历", modules: {
    basic: { name: "张三", phone: "13800000000", email: "zhangsan@example.com" },
    summary: { text: "擅长团队协作" },
  } } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/resumes/${id}/print`);
    await page.getByRole("button", { name: /隐私脱敏导出/ }).click();
    const button = page.getByRole("button", { name: "导出脱敏 DOCX" });
    await expect(button).toBeInViewport();
    await button.click();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("dialog", { name: "导出前检查" }).getByRole("button", { name: "继续导出" }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("[脱敏版] 张_的简历.docx");
    const text = (await mammoth.extractRawText({ buffer: await fs.readFile((await download.path())!) })).value;
    expect(text).toContain("张*");
    for (const secret of ["张三", "13800000000", "zhangsan@example.com"]) expect(text).not.toContain(secret);
  } finally {
    await request.delete(`/api/resumes/${id}`);
  }
});

test("真实上传的 WebP 头像随横幅模板一起导出为可编辑 DOCX", async ({ page, request }) => {
  const photo = await sharp({ create: { width: 180, height: 240, channels: 3, background: "#aa3366" } }).webp().toBuffer();
  const uploaded = await request.post("/api/upload", { multipart: { file: {
    name: "photo.webp", mimeType: "image/webp", buffer: photo,
  } } });
  expect(uploaded.status()).toBe(200);
  const { url } = await uploaded.json();
  const created = await request.post("/api/resumes", { data: { title: "头像简历", modules: {
    basic: { name: "王小明", avatar: url, avatarShape: "rounded", avatarSize: 72 },
    summary: { text: "熟悉系统开发" },
  } } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  try {
    const draft = await (await request.get(`/api/resumes/${id}`)).json();
    expect((await request.patch(`/api/resumes/${id}`, { data: { template: "banner_navy", dataGeneration: draft.resume.dataGeneration } })).ok()).toBe(true);
    await page.goto(`/resumes/${id}`);
    await expect(page.locator('[data-resume-avatar="true"]')).toBeVisible();
    const check = await openDocx(page);
    const pending = page.waitForEvent("download");
    await check.getByRole("button", { name: "继续导出" }).click();
    const download = await pending;
    const buffer = await fs.readFile((await download.path())!);
    const zip = await JSZip.loadAsync(buffer);
    expect(Object.keys(zip.files).some((name) => /^word\/media\/.*\.png$/.test(name))).toBe(true);
    expect(await zip.file("word/document.xml")!.async("string")).toContain('w:fill="1E3A8A"');
    expect((await mammoth.extractRawText({ buffer })).value).toContain("王小明");
  } finally {
    await request.delete(`/api/resumes/${id}`);
  }
});

test("保存失败时不下载 DOCX 旧稿", async ({ page }) => {
  const api = await mockApi(page);
  api.failSaves = true;
  let requests = 0;
  await page.route("**/api/resumes/9001/export/docx", async (route) => {
    requests += 1;
    await route.fulfill({ body: "旧稿" });
  });
  await page.goto("/resumes/9001");
  await page.getByLabel("姓名", { exact: true }).fill("修改姓名");
  const check = await openDocx(page);
  await check.getByRole("button", { name: "继续导出" }).click();
  await expect(check.getByRole("alert")).toBeVisible();
  expect(requests).toBe(0);
});

test("DOCX 生成失败保留检查界面并显示错误", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/resumes/9001/export/docx", (route) => route.fulfill({ status: 500, json: { error: "生成文档失败" } }));
  await page.goto("/resumes/9001");
  const check = await openDocx(page);
  await check.getByRole("button", { name: "继续导出" }).click();
  await expect(check.getByRole("alert")).toHaveText("生成文档失败");
  await expect(check.getByRole("button", { name: "继续导出" })).toBeEnabled();
});
