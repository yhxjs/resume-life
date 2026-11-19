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
  it("窄字形的扫描 PDF 页面不能被判为空白", async () => {
    const { createCanvas } = getCanvasModule();
    const canvas = createCanvas(128, 64);
    const ctx = canvas.getContext("2d") as { fillStyle: string; font: string; fillRect: (x: number, y: number, width: number, height: number) => void; fillText: (text: string, x: number, y: number) => void };
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, 128, 64);
    ctx.fillStyle = "black"; ctx.font = "20px Arial"; ctx.fillText("I", 3, 36);
    const jpeg = canvas.toBuffer("image/jpeg");
    const commands = Buffer.from("q 128 0 0 64 0 0 cm /Im1 Do Q");
    const objects = [
      Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
      Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
      Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 128 64] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>"),
      Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 128 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream")]),
      Buffer.concat([Buffer.from(`<< /Length ${commands.length} >>\nstream\n`), commands, Buffer.from("\nendstream")]),
    ];
    const chunks = [Buffer.from("%PDF-1.4\n")];
    const offsets: number[] = [];
    let offset = chunks[0]!.length;
    objects.forEach((object, index) => {
      offsets.push(offset);
      const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
      chunks.push(chunk); offset += chunk.length;
    });
    chunks.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map(value => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`));
    const [page] = await renderPdfPagesToImages(Buffer.concat(chunks));
    expect(page!.hasVisualContent).toBe(true);
  });

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

  it("从长文档选择少量页面时保留原页号和完整 PNG", async () => {
    const images = await renderPdfPagesToImages(createTestPdf(8), MAX_OCR_PAGES, undefined, [2, 8]);
    expect(images.map(page => page.pageNumber)).toEqual([2, 8]);
    for (const page of images) {
      expect(page.buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(page.base64).toBe(`data:image/png;base64,${page.buffer.toString("base64")}`);
      expect(page.hasVisualContent).toBe(false);
    }
  });

  it.each([[], [0], [-1], [1.5], [NaN], [2, 2], [3, 1], [1, 2, 3, 4, 5, 6]].map(selected => ({ selected })))("拒绝无效或超预算的选择页码 $selected", async ({ selected }) => {
    await expect(renderPdfPagesToImages(createTestPdf(8), MAX_OCR_PAGES, undefined, selected)).rejects.toThrow(/页码|最多.*5.*页/);
  });

  it("选择页码不得超出文档页数或显式渲染数量", async () => {
    await expect(renderPdfPagesToImages(createTestPdf(2), MAX_OCR_PAGES, undefined, [3])).rejects.toThrow(/页码/);
    await expect(renderPdfPagesToImages(createTestPdf(3), 1, undefined, [1, 2])).rejects.toThrow(/最多.*1.*页/);
  });

  it("极大 MediaBox 渲染后仍不超过画布尺寸和像素预算", async () => {
    const images = await renderPdfPagesToImages(createTestPdf(1, "[0 0 6400 6400]"));
    expect(images).toHaveLength(1);
    expect(images[0]!.width).toBeLessThanOrEqual(3000);
    expect(images[0]!.height).toBeLessThanOrEqual(3000);
    expect(images[0]!.width * images[0]!.height).toBeLessThanOrEqual(6_000_000);
  }, 15_000);

  describe("processImageBufferToPage 单图预处理", () => {
    it.each(["white", "transparent"])("%s 背景上的窄字形保留，实际空白仍为空白", async background => {
      const { createCanvas } = getCanvasModule();
      const canvas = createCanvas(128, 64);
      const ctx = canvas.getContext("2d") as { fillStyle: string; font: string; fillRect: (x: number, y: number, width: number, height: number) => void; fillText: (text: string, x: number, y: number) => void };
      if (background === "white") { ctx.fillStyle = "white"; ctx.fillRect(0, 0, 128, 64); }
      expect((await processImageBufferToPage(canvas.toBuffer("image/png"))).hasVisualContent).toBe(false);
      ctx.fillStyle = "black"; ctx.font = "20px Arial"; ctx.fillText("I", 3, 36);
      const page = await processImageBufferToPage(canvas.toBuffer("image/png"));
      expect(page.hasVisualContent).toBe(true);
      expect([page.width, page.height]).toEqual([128, 64]);
    });

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
