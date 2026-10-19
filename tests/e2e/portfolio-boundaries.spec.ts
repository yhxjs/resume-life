import fs from "node:fs/promises";
import JSZip from "jszip";
import { expect, test } from "@playwright/test";

test("真实动态简历：简历内容、同源生成器、动效预览与 ZIP 下载", async ({ page, request }) => {
  const marker = `个人简历${Date.now()}`;
  const created = await request.post("/api/resumes", { data: { title: marker, modules: {
    basic: { name: "林知远", title: "产品设计师", email: "lin@example.com", location: "上海" },
    work: [{ id: "w1", company: "示例设计公司", title: "产品设计师", start: "2023", end: "至今", description: "负责核心产品体验设计" }],
    projects: [{ id: "p1", name: "个人知识空间", role: "产品设计", description: "完成用户研究与交互设计" }],
    summary: { text: "相信好的设计始于对人的理解。" },
  } } });
  expect(created.status()).toBe(201);
  const resume = await created.json() as { id: number };
  try {
    await page.goto("/tools/portfolio");
    await page.getByLabel("选择简历", { exact: true }).selectOption(String(resume.id));
    await page.getByLabel("选择版本快照").selectOption("");
    await page.getByLabel("网页标题").fill(marker);
    const iframe = page.frameLocator('iframe[title="动态简历真实页面"]');
    await expect(iframe.getByRole("heading", { name: "林**", exact: true })).toBeVisible();
    await expect(iframe.getByRole("heading", { name: "示例设计公司", exact: true })).toHaveCount(1);
    await expect(iframe.getByRole("heading", { name: "个人知识空间", exact: true })).toHaveCount(1);
    await expect(iframe.getByText("查看技术细节", { exact: false })).toHaveCount(0);
    await expect(iframe.locator("canvas")).toHaveCount(1);

    for (const siteTemplate of ["focus", "chronicle", "sidebar", "flow"]) {
      await page.getByLabel("主页模板", { exact: true }).selectOption(siteTemplate);
      await expect(iframe.locator("html")).toHaveAttribute("data-template", siteTemplate);
      await expect(iframe.getByRole("heading", { name: "示例设计公司", exact: true })).toHaveCount(1);
    }

    await iframe.getByRole("link", { name: "了解我的经历" }).press("Enter");
    await expect.poll(() => iframe.locator("html").evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(await iframe.locator("html").evaluate(() => location.href)).toBe("about:srcdoc");
    await expect(iframe.getByRole("heading", { name: "林**", exact: true })).toHaveCount(1);
    await iframe.getByRole("link", { name: "回到顶部" }).press("Enter");
    await expect.poll(() => iframe.locator("html").evaluate(() => window.scrollY)).toBe(0);
    expect(await iframe.locator("html").evaluate(() => location.href)).toBe("about:srcdoc");

    await page.getByRole("button", { name: "手机", exact: true }).click();
    await expect(page.getByTitle("动态简历真实页面")).toHaveCSS("width", "390px");
    await page.getByRole("button", { name: "全屏预览", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "真实页面预览" })).toBeVisible();
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();

    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "生成并下载作品集", exact: true }).click();
    const download = await downloadEvent;
    const zip = await JSZip.loadAsync(await fs.readFile((await download.path())!));
    const html = await zip.file("index.html")!.async("string");
    expect(html).toContain(marker);
    expect(html).toContain("示例设计公司");
    expect(html).not.toContain("林知远");
    expect(html).not.toContain("查看技术细节");
    const previewResponse = await request.post("/api/portfolio/preview", { data: {
      resumeId: resume.id, selectedProjects: [], siteTitle: marker, themeMode: "dark", accentColor: "#b8ef67",
    } });
    expect(previewResponse.status()).toBe(200);
    const { html: previewHtml } = await previewResponse.json();
    const css = await zip.file("assets/style.css")!.async("string");
    const js = await zip.file("assets/app.js")!.async("string");
    expect(previewHtml).toBe(html.replace('<link rel="stylesheet" href="assets/style.css" />', () => `<style>${css}</style>`)
      .replace('<script src="assets/app.js"></script>', () => `<script>${js}</script>`));
  } finally { await request.delete(`/api/resumes/${resume.id}`); }
});
