import { test, expect } from "@playwright/test";
import fs from "node:fs";

test("解析草稿并排校对易错字段并从编辑器定位原文", async ({ page, request }) => {
  const source = "示例科技与示例科技合作\n电话 13800138000\n2022-03 至今，吞吐提升 35%";
  await page.route("**/api/import/parse", async (route) => {
    await route.fulfill({ json: {
      title: "校对简历",
      modules: {
        basic: { name: "测试用户", phone: "13800138000", email: "", location: "", birthday: "", links: "" },
        education: [],
        work: [{ id: "w1", company: "示例科技", title: "工程师", start: "2022.03", end: "至今", description: "吞吐提升 35%", descriptionItems: ["吞吐提升 35%"] }],
        projects: [], skills: { items: [] }, summary: { text: "" }, custom: [],
      },
    } });
  });
  await page.goto("/resumes/import");
  await page.getByRole("textbox", { name: "简历原文" }).fill(source);
  await page.getByRole("button", { name: "开始智能解析" }).click();
  await expect(page.getByRole("heading", { name: "确认解析草稿" })).toBeVisible();

  await page.getByRole("button", { name: "定位原文：工作 1 · 公司" }).click();
  await expect(page.getByRole("status", { name: "原文定位状态" })).toContainText("第 1 / 2 处");
  await page.getByRole("button", { name: "下一个匹配" }).click();
  await expect(page.locator('mark[aria-current="location"]')).toHaveAttribute("data-match-index", "1");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "定位原文：工作 1 · 公司" }).click();
  await page.waitForTimeout(500);
  expect((await page.getByRole("heading", { name: "导入原文" }).boundingBox())?.y ?? -1)
    .toBeGreaterThan(58);
  expect((await page.locator('mark[aria-current="location"]').boundingBox())?.y ?? -1)
    .toBeGreaterThan(58);

  await page.getByRole("textbox", { name: "开始时间" }).focus();
  await expect(page.locator('mark[aria-current="location"]')).toHaveText("2022-03");
  await page.getByRole("textbox", { name: "公司名称" }).fill("另一家公司");
  await expect(page.getByRole("status", { name: "原文定位状态" })).toContainText("原文未找到");
  await expect(page.getByLabel("导入原文")).toContainText(source);
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page).toHaveURL(/\/resumes\/\d+$/);
  const saved = await request.get(`/api/resumes/${page.url().split("/").pop()}`);
  expect(saved.ok()).toBe(true);
  const result = await saved.json();
  expect(result.modules.find((module: { key: string }) => module.key === "work").content[0].company).toBe("另一家公司");
});

test("文件原文在 AI 失败后可编辑并完成真实简历创建", async ({ page, request }) => {
  // Extraction, creation and persistence use the real server; only AI is unavailable.
  await page.goto("/resumes/import");
  await page.getByRole("tab", { name: "上传文件" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "resume.txt", mimeType: "text/plain", buffer: Buffer.from("原始合成简历\n项目：测试数据恢复"),
  });
  await page.getByRole("button", { name: "开始智能解析" }).click();
  const original = page.getByLabel("已保留的原文，可直接修改");
  await expect(original).toHaveValue("原始合成简历\n项目：测试数据恢复");
  await original.fill("手工修正的简历原文\n项目：可靠的数据恢复");
  await page.getByRole("button", { name: "手工整理并继续导入" }).click();
  const summary = page.getByRole("textbox", { name: "自我评价第 1 行", exact: true });
  // 原文只作参考，不能未经归位直接变成模型会外发的职业简介。
  await expect(summary).toHaveText("");
  await expect(page.getByText("手工修正的简历原文\n项目：可靠的数据恢复", { exact: true })).toBeVisible();
  await summary.fill("项目：可靠的数据恢复");
  await page.getByLabel("简历标题", { exact: true }).fill("E2E 手工导入");
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page).toHaveURL(/\/resumes\/\d+$/);
  const id = page.url().split("/").pop();
  const saved = await request.get(`/api/resumes/${id}`);
  expect(saved.ok()).toBe(true);
  const data = await saved.json();
  expect(data.resume.title).toBe("E2E 手工导入");
  expect(data.modules.find((m: { key: string }) => m.key === "summary").content.text)
    .toBe("项目：可靠的数据恢复");
});

test("生产接口能从沙箱解析 DOCX 与 PDF", async ({ page, request }) => {
  await page.setContent("<p>Production PDF parse smoke</p>");
  const documents = [
    {
      name: "resume.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: fs.readFileSync("src/lib/__tests__/fixtures/single-paragraph.docx"),
      expected: "Walking on imported air",
    },
    {
      name: "resume.pdf",
      mimeType: "application/pdf",
      buffer: await page.pdf(),
      expected: "Production PDF parse smoke",
    },
  ];

  for (const document of documents) {
    const response = await request.post("/api/import/parse", {
      multipart: {
        extractOnly: "true",
        file: {
          name: document.name,
          mimeType: document.mimeType,
          buffer: document.buffer,
        },
      },
    });
    expect(response.status(), `${document.name}: ${await response.text()}`).toBe(200);
    expect((await response.json()).extractedText).toContain(document.expected);
  }
});

test("生产接口能在独立进程渲染无文本 PDF 并识别空白页", async ({ page, request }) => {
  await page.setContent("<body style='margin:0;background:white'></body>");
  const response = await request.post("/api/import/parse", {
    multipart: {
      extractOnly: "true",
      file: { name: "blank.pdf", mimeType: "application/pdf", buffer: await page.pdf() },
    },
  });

  expect(response.status(), await response.text()).toBe(400);
  expect((await response.json()).error).toContain("PDF 文件未包含可选中文本");
});

test("六页扫描 PDF 导入明确拒绝而不返回前五页的部分内容", async ({ page, request }) => {
  await page.setContent(`<style>@page{size:A4;margin:0}.sheet{width:210mm;height:297mm;break-after:page;background:#335577}</style>${
    Array.from({ length: 6 }, () => '<div class="sheet"></div>').join("")
  }`);
  const response = await request.post("/api/import/parse", {
    multipart: {
      extractOnly: "true",
      file: { name: "six-pages.pdf", mimeType: "application/pdf", buffer: await page.pdf({ format: "A4", printBackground: true }) },
    },
  });
  expect(response.status(), await response.text()).toBe(400);
  expect((await response.json()).error).toMatch(/扫描 PDF 共 [6-9] 页，OCR 最多支持 5 页，请拆分文件/);
});
