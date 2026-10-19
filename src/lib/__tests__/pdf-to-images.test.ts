import { describe, it, expect } from "vitest";
import { renderPdfPagesToImages, processImageBufferToPage, MAX_OCR_PAGES, getCanvasModule } from "../pdf-to-images";

// 构造一个最小的 2 页有效测试 PDF
function createTestPdf(pageCount = 2, mediaBox = "[0 0 100 100]"): Buffer {
  const pageObjs = Array.from({ length: pageCount }, (_, i) => {
    const pageNum = i + 3;
    return `${pageNum} 0 obj <</Type /Page /Parent 2 0 R /MediaBox ${mediaBox} /Resources <<>> /Contents 0 R>> endobj\n`;
  }).join("");

  const pageKids = Array.from({ length: pageCount }, (_, i) => `${i + 3} 0 R`).join(" ");

  const raw =
    `%PDF-1.4\n` +
    `1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n` +
    `2 0 obj <</Type /Pages /Kids [${pageKids}] /Count ${pageCount}>> endobj\n` +
    pageObjs +
    `xref\n0 ${pageCount + 3}\n` +
    `0000000000 65535 f \n` +
    `trailer <</Size ${pageCount + 3} /Root 1 0 R>>\n` +
    `startxref\n10\n%%EOF`;

  return Buffer.from(raw);
}

describe("pdf-to-images.ts PDF 渲染为图像", () => {
  it("默认最多处理前 MAX_OCR_PAGES (5) 页", () => {
    expect(MAX_OCR_PAGES).toBe(5);
  });

  it("能成功将有效 PDF 页面渲染为 PNG 图像 Buffer 与 DataURL", async () => {
    const pdfBuf = createTestPdf(2);
    const images = await renderPdfPagesToImages(pdfBuf, 2);

    expect(images).toHaveLength(2);
    expect(images[0]?.pageNumber).toBe(1);
    expect(images[0]?.buffer).toBeInstanceOf(Buffer);
    expect(images[0]?.buffer.length).toBeGreaterThan(0);
    expect(images[0]?.base64.startsWith("data:image/png;base64,")).toBe(true);
    expect(images[0]?.width).toBeGreaterThan(0);
    expect(images[0]?.height).toBeGreaterThan(0);

    expect(images[1]?.pageNumber).toBe(2);
  });

  it("超限多页 PDF 严格截断到指定的 maxPages", async () => {
    const pdfBuf = createTestPdf(3);
    const images = await renderPdfPagesToImages(pdfBuf, 1);
    expect(images).toHaveLength(1);
    expect(images[0]?.pageNumber).toBe(1);
  });

  it("六页扫描 PDF 明确拒绝，不会静默遗漏末页", async () => {
    await expect(renderPdfPagesToImages(createTestPdf(6))).rejects.toThrow(/共 6 页.*最多支持 5 页.*拆分/);
  });

  it("极大 MediaBox 渲染后仍不超过画布尺寸和像素预算", async () => {
    const images = await renderPdfPagesToImages(createTestPdf(1, "[0 0 6400 6400]"));
    expect(images).toHaveLength(1);
    expect(images[0]!.width).toBeLessThanOrEqual(3000);
    expect(images[0]!.height).toBeLessThanOrEqual(3000);
    expect(images[0]!.width * images[0]!.height).toBeLessThanOrEqual(6_000_000);
  }, 15_000);

  describe("processImageBufferToPage 单图预处理", () => {
    it("能正确解析图片尺寸并检测视觉笔迹", async () => {
      const { createCanvas } = getCanvasModule();
      const canvas = createCanvas(120, 80);
      const ctx = canvas.getContext("2d") as { fillStyle: string; fillRect: (x: number, y: number, w: number, h: number) => void };
      ctx.fillStyle = "blue";
      ctx.fillRect(0, 0, 120, 80);
      const imgBuffer = canvas.toBuffer("image/png");

      const page = await processImageBufferToPage(imgBuffer);
      expect(page.pageNumber).toBe(1);
      expect(page.width).toBe(120);
      expect(page.height).toBe(80);
      expect(page.hasVisualContent).toBe(true);
      expect(page.base64.startsWith("data:image/png;base64,")).toBe(true);
      expect(page.buffer).toBeInstanceOf(Buffer);
    });

    it.each(["image/jpeg", "image/webp"])("保留 %s 图片的正常 OCR 输入路径", async (mime) => {
      const { createCanvas } = getCanvasModule();
      const canvas = createCanvas(48, 32);
      const ctx = canvas.getContext("2d") as { fillStyle: string; fillRect: (x: number, y: number, w: number, h: number) => void };
      ctx.fillStyle = "blue";
      ctx.fillRect(0, 0, 48, 32);
      const page = await processImageBufferToPage(canvas.toBuffer(mime));
      expect([page.width, page.height, page.hasVisualContent]).toEqual([48, 32, true]);
    });

    it("对损坏的非图片数据抛出友好错误", async () => {
      const corrupted = Buffer.from("not-a-valid-image");
      await expect(processImageBufferToPage(corrupted)).rejects.toThrow("图片文件损坏或不支持该格式");
    });

    it("在解码前拒绝小文件声明的超大像素尺寸", async () => {
      const { createCanvas } = getCanvasModule();
      const tinyPng = Buffer.from(createCanvas(1, 1).toBuffer("image/png"));
      tinyPng.writeUInt32BE(20_000, 16);
      tinyPng.writeUInt32BE(20_000, 20);
      expect(tinyPng.byteLength).toBeLessThan(1024);

      await expect(processImageBufferToPage(tinyPng)).rejects.toThrow("图片像素超过上限");
    });

    it("请求已取消时不启动图片解码", async () => {
      const { createCanvas } = getCanvasModule();
      const image = createCanvas(1, 1).toBuffer("image/png");
      const controller = new AbortController();
      controller.abort();
      await expect(processImageBufferToPage(image, controller.signal)).rejects.toThrow("取消");
    });
  });
});
