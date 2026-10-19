import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

import { extractTextFromFile, extractTextFromPath } from "../parse-file";
import { FileFormatError, UNPARSEABLE_MESSAGE } from "../parse-sandbox";
import {
  MAX_MULTIPART_REQUEST_BYTES,
  MAX_PROJECT_MATERIAL_CHARS,
  MAX_UPLOAD_FILE_BYTES,
  RequestTooLargeError,
} from "../request-limits";
import { parseMultipartUpload } from "../streaming-multipart";

const TEMP_DIRECTORY_PREFIX = "resume-life-upload-";

type MultipartPart = {
  headers: string[];
  body: Uint8Array | string;
};

let ownedUploadDirectories = new Set<string>();

function safeUploadDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !path.basename(resolved).startsWith(TEMP_DIRECTORY_PREFIX)
  ) {
    throw new Error(`Unsafe upload cleanup target: ${resolved}`);
  }
  return resolved;
}

function expectNoNewUploadDirectories(): void {
  for (const directory of ownedUploadDirectories) {
    expect(fs.existsSync(safeUploadDirectory(directory))).toBe(false);
  }
}

function multipartBody(boundary: string, parts: MultipartPart[], close = true): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n${part.headers.join("\r\n")}\r\n\r\n`));
    chunks.push(Buffer.from(part.body));
    chunks.push(Buffer.from("\r\n"));
  }
  if (close) chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function fieldPart(name: string, value: string): MultipartPart {
  return {
    headers: [`Content-Disposition: form-data; name="${name}"`],
    body: value,
  };
}

function filePart(filename: string, mimeType: string, body: Uint8Array): MultipartPart {
  return {
    headers: [
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      `Content-Type: ${mimeType}`,
    ],
    body,
  };
}

function tenMultipartParts(): MultipartPart[] {
  return [
    ...Array.from({ length: 8 }, (_, index) => fieldPart(`field${index}`, "value")),
    filePart("only.txt", "text/plain", Buffer.from("file")),
    { headers: ["Content-Disposition: attachment"], body: "ignored but counted" },
  ];
}

function streamFromBytes(
  bytes: Uint8Array,
  options: {
    cancel?: () => void | Promise<void>;
    chunkSize?: number;
    close?: boolean;
  } = {},
): ReadableStream<Uint8Array> {
  let offset = 0;
  const chunkSize = options.chunkSize ?? 64 * 1024;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.byteLength) {
        const end = Math.min(offset + chunkSize, bytes.byteLength);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
        return;
      }
      if (options.close !== false) controller.close();
    },
    cancel: options.cancel,
  }, { highWaterMark: 0 });
}

function multipartRequest(
  body: ReadableStream<Uint8Array> | null,
  boundary: string,
  contentLength?: string,
  mediaType = "multipart/form-data",
): Request {
  const headers = new Headers({ "Content-Type": `${mediaType}; boundary=${boundary}` });
  if (contentLength !== undefined) headers.set("Content-Length", contentLength);
  return { body, headers, signal: new AbortController().signal } as Request;
}

function unreadMultipartRequest(contentLength: string, boundary: string) {
  const getReader = vi.fn();
  const request = {
    body: { getReader },
    headers: new Headers({
      "Content-Length": contentLength,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    }),
  } as unknown as Request;
  return { request, getReader };
}

beforeEach(() => {
  ownedUploadDirectories = new Set<string>();
  const originalMkdtemp = fs.promises.mkdtemp;
  vi.spyOn(fs.promises, "mkdtemp").mockImplementation(async (prefix) => {
    const directory = await originalMkdtemp(prefix);
    ownedUploadDirectories.add(safeUploadDirectory(directory));
    return directory;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of ownedUploadDirectories) {
    const safeDirectory = safeUploadDirectory(directory);
    if (fs.existsSync(safeDirectory)) {
      fs.rmSync(safeDirectory, { recursive: true, force: true });
    }
  }
});

describe("DOCX extraction resource limits", () => {
  it("rejects a highly compressed document before expanding its XML", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>`);
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${"字".repeat(2_100_000)}</w:t></w:r></w:p></w:body></w:document>`);
    const compressed = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });

    expect(compressed.byteLength).toBeLessThan(100_000);
    await expect(extractTextFromFile("bomb.docx", compressed)).rejects.toBeInstanceOf(FileFormatError);
  });

  it("still extracts an ordinary DOCX", async () => {
    const ordinary = fs.readFileSync(path.join(process.cwd(), "src/lib/__tests__/fixtures/single-paragraph.docx"));
    await expect(extractTextFromFile("ordinary.docx", ordinary)).resolves.toContain("Walking on imported air");
  });
});

/** 构造一个结构完整的单页 PDF（xref 偏移按真实字节位置计算） */
function buildSinglePagePdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** 构造多页 PDF：每页 linesPerPage 行、每行 100 字符。
 *  单页超长 Tj 会被 pdf.js 截断（实测塞 20 万字符只抽出 57 个），
 *  要越过 20 万字符上限只能靠页数与行数堆。 */
function buildMultiPagePdf(pageCount: number, linesPerPage: number): Buffer {
  const pageIds: number[] = [];
  for (let index = 0; index < pageCount; index += 1) pageIds.push(3 + index * 2);
  const fontId = 3 + pageCount * 2;
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
  ];
  for (let index = 0; index < pageCount; index += 1) {
    let stream = "BT /F1 12 Tf 20 750 Td 14 TL\n";
    for (let line = 0; line < linesPerPage; line += 1) stream += `(${"x".repeat(100)}) Tj T*\n`;
    stream += "ET";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageIds[index]! + 1} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
    );
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

describe("PDF extraction resource limits", () => {
  it("在沙箱中解析普通 PDF 并返回正文", async () => {
    await expect(extractTextFromFile("ordinary.pdf", buildSinglePagePdf("Hello PDF World"))).resolves.toContain(
      "Hello PDF World"
    );
  });

  it("损坏的 PDF 报格式错误而不是让主进程抛未捕获异常", async () => {
    const garbage = Buffer.from("%PDF-1.4\n完全不是合法的 PDF 结构", "utf8");

    await expect(extractTextFromFile("broken.pdf", garbage)).rejects.toBeInstanceOf(FileFormatError);
  });

  it("提取正文超过 20 万字符时报错，且文案带具体原因", async () => {
    // 45 页 × 50 行 × 100 字符，实测抽出 225,756 字符，离上限有 2.5 万字符余量
    const oversized = buildMultiPagePdf(45, 50);

    await expect(extractTextFromFile("big.pdf", oversized)).rejects.toThrow("PDF 提取文本不得超过 200000 字符");
    await expect(extractTextFromFile("big.pdf", oversized)).rejects.not.toThrow(UNPARSEABLE_MESSAGE);
  });

  it("无可选中文本的纯图片/空内容 PDF 给出明确的友好错误提示", async () => {
    // 构造只有空页面且无任何字体的 PDF，模拟扫描件或纯图 PDF
    const emptyPageObjects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    emptyPageObjects.forEach((body, index) => {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefOffset = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${emptyPageObjects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${emptyPageObjects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    const emptyPdfBuffer = Buffer.from(pdf, "latin1");

    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIRECTORY_PREFIX));
    vi.stubEnv("RESUME_LIFE_DATA_DIR", dataDirectory);
    let settingsDb: DatabaseSync | undefined;
    try {
      vi.resetModules();
      settingsDb = (await import("../db")).getDb();
      const { extractTextFromFile: extractWithSettings } = await import("../parse-file");
      await expect(extractWithSettings("scan.pdf", emptyPdfBuffer)).rejects.toThrow(
        "PDF 文件未包含可选中文本（可能为图片扫描件或未内嵌字体的打印件），请使用文字版 PDF、Word 或复制纯文本导入"
      );
    } finally {
      settingsDb?.close();
      vi.unstubAllEnvs();
      fs.rmSync(safeUploadDirectory(dataDirectory), { recursive: true, force: true });
    }
  });

  it("支持 UTF-8 与 GBK 编码的文本文件解析", async () => {
    const utf8Content = "你好，这是 UTF-8 编码的文档";
    const utf8Buffer = Buffer.from(utf8Content, "utf8");
    await expect(extractTextFromFile("test-utf8.md", utf8Buffer)).resolves.toBe(utf8Content);

    // GBK 编码的中文文本
    const gbkBuffer = Buffer.from([0xbf, 0xcd, 0xb7, 0xfe, 0xc2, 0xe7, 0xbe, 0xad]); // '客服络经'
    await expect(extractTextFromFile("test-gbk.txt", gbkBuffer)).resolves.toBe("客服络经");
  });
});

describe("parseMultipartUpload request limits", () => {
  it("rejects Content-Length one byte over 12 MiB before reading or creating temp storage", async () => {
    const getReader = vi.fn();
    const mkdtemp = vi.spyOn(fs.promises, "mkdtemp");
    const request = {
      body: { getReader },
      headers: new Headers({
        "Content-Length": String(MAX_MULTIPART_REQUEST_BYTES + 1),
        "Content-Type": "multipart/form-data; boundary=immediate-limit",
      }),
    } as unknown as Request;

    await expect(parseMultipartUpload(request)).rejects.toBeInstanceOf(RequestTooLargeError);
    expect(getReader).not.toHaveBeenCalled();
    expect(mkdtemp).not.toHaveBeenCalled();
    expectNoNewUploadDirectories();
  });

  it("rejects an unannounced streamed byte over 12 MiB, cancels, unlocks, and leaves no temp data", async () => {
    const cancel = vi.fn();
    const bytes = Buffer.alloc(MAX_MULTIPART_REQUEST_BYTES + 1, 0x78);
    const body = streamFromBytes(bytes, { cancel, chunkSize: 256 * 1024, close: false });

    await expect(parseMultipartUpload(multipartRequest(body, "stream-limit"))).rejects.toBeInstanceOf(
      RequestTooLargeError,
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expectNoNewUploadDirectories();
  });

  it("accepts a file at exactly 10 MiB", async () => {
    const boundary = "exact-file-limit";
    const fileBytes = Buffer.alloc(MAX_UPLOAD_FILE_BYTES, 0x61);
    const body = multipartBody(boundary, [filePart("exact.txt", "text/plain", fileBytes)]);
    const upload = await parseMultipartUpload(
      multipartRequest(streamFromBytes(body, { chunkSize: 256 * 1024 }), boundary),
    );

    try {
      expect(upload.file?.bytes).toBe(MAX_UPLOAD_FILE_BYTES);
      expect(upload.file && fs.statSync(upload.file.path).size).toBe(MAX_UPLOAD_FILE_BYTES);
    } finally {
      upload.dispose();
    }
    expectNoNewUploadDirectories();
  });

  it("rejects a file one byte over 10 MiB with a 413 and no residue", async () => {
    const boundary = "over-file-limit";
    const body = multipartBody(boundary, [
      filePart("over.txt", "text/plain", Buffer.alloc(MAX_UPLOAD_FILE_BYTES + 1, 0x62)),
    ]);

    await expect(
      parseMultipartUpload(
        multipartRequest(streamFromBytes(body, { chunkSize: 256 * 1024 }), boundary),
      ),
    ).rejects.toBeInstanceOf(RequestTooLargeError);
    expectNoNewUploadDirectories();
  });
});

describe("parseMultipartUpload results", () => {
  it("writes a legal upload to a random safe path and keeps fields and original metadata", async () => {
    const boundary = "legal-upload";
    const filename = "../../nested/hostile-name.txt";
    const fileBytes = Buffer.from("streamed text content", "utf8");
    const body = multipartBody(boundary, [
      fieldPart("title", "first"),
      fieldPart("title", "last"),
      fieldPart("locale", "zh-CN"),
      filePart(filename, "text/plain", fileBytes),
    ]);
    const upload = await parseMultipartUpload(
      multipartRequest(streamFromBytes(body, { chunkSize: 7 }), boundary),
    );

    try {
      expect(upload.fields).toEqual({ title: "last", locale: "zh-CN" });
      expect(upload.file).toMatchObject({
        filename,
        mimeType: "text/plain",
        bytes: fileBytes.byteLength,
      });
      expect(upload.file).not.toBeNull();
      if (!upload.file) throw new Error("Expected an uploaded file");

      const uploadDirectory = safeUploadDirectory(path.dirname(upload.file.path));
      expect(path.dirname(uploadDirectory)).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(upload.file.path)).not.toContain("hostile-name.txt");
      expect(fs.readFileSync(upload.file.path)).toEqual(fileBytes);
      await expect(extractTextFromPath(filename, upload.file.path)).resolves.toBe(
        "streamed text content",
      );

      upload.dispose();
      expect(fs.existsSync(uploadDirectory)).toBe(false);
      expect(() => upload.dispose()).not.toThrow();
    } finally {
      upload.dispose();
    }
    expectNoNewUploadDirectories();
  });

  it("正确解析带有中文文件名的文件上传", async () => {
    const boundary = "chinese-filename-boundary";
    const chineseFilename = "客服络经题诗题参考.md";
    const fileBytes = Buffer.from("# 架构文档正文\n这是测试内容", "utf8");
    const body = multipartBody(boundary, [
      filePart(chineseFilename, "text/markdown", fileBytes),
    ]);
    const upload = await parseMultipartUpload(
      multipartRequest(streamFromBytes(body), boundary),
    );

    try {
      expect(upload.file?.filename).toBe(chineseFilename);
      if (!upload.file) throw new Error("Expected an uploaded file");
      await expect(extractTextFromPath(upload.file.filename, upload.file.path)).resolves.toContain(
        "架构文档正文",
      );
    } finally {
      upload.dispose();
    }
    expectNoNewUploadDirectories();
  });

  it("returns null when the multipart body has no file", async () => {
    const boundary = "fields-only";
    const body = multipartBody(boundary, [fieldPart("note", "plain field")]);
    const upload = await parseMultipartUpload(multipartRequest(streamFromBytes(body), boundary));

    try {
      expect(upload).toMatchObject({ fields: { note: "plain field" }, file: null });
    } finally {
      upload.dispose();
    }
    expectNoNewUploadDirectories();
  });
});

describe("parseMultipartUpload structural errors", () => {
  it.each([
    "application/json",
    "application/x-www-form-urlencoded",
  ])("rejects invalid multipart Content-Type %s before reading or creating temp storage", async (contentType) => {
    const getReader = vi.fn();
    const request = {
      body: { getReader },
      headers: new Headers({ "Content-Type": contentType }),
    } as unknown as Request;

    const error = await parseMultipartUpload(request).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RequestTooLargeError);
    expect(getReader).not.toHaveBeenCalled();
    expectNoNewUploadDirectories();
  });

  it("cancels an unread Web body when a missing boundary makes Busboy construction fail", async () => {
    const cancel = vi.fn();
    const body = streamFromBytes(new Uint8Array(0), { cancel, close: false });
    const request = {
      body,
      headers: new Headers({ "Content-Type": "multipart/form-data" }),
    } as Request;

    const error = await parseMultipartUpload(request).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RequestTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expectNoNewUploadDirectories();
  });

  it("keeps a missing body as an ordinary error without temp storage", async () => {
    const missingBodyRequest = multipartRequest(null, "missing-body");

    const missingBodyError = await parseMultipartUpload(missingBodyRequest).catch(
      (error: unknown) => error,
    );

    expect(missingBodyError).toBeInstanceOf(Error);
    expect(missingBodyError).not.toBeInstanceOf(RequestTooLargeError);
    expectNoNewUploadDirectories();
  });

  it("removes temp storage after malformed multipart input", async () => {
    const boundary = "malformed-upload";
    const body = multipartBody(boundary, [fieldPart("broken", "never closed")], false);

    const error = await parseMultipartUpload(
      multipartRequest(streamFromBytes(body), boundary),
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RequestTooLargeError);
    expectNoNewUploadDirectories();
  });

  it("accepts exactly 10 multipart parts and disposes its owned temp directory", async () => {
    const boundary = "exact-parts-limit";
    const upload = await parseMultipartUpload(
      multipartRequest(streamFromBytes(multipartBody(boundary, tenMultipartParts())), boundary),
    );

    try {
      expect(Object.keys(upload.fields)).toHaveLength(8);
      expect(upload.file).toMatchObject({ filename: "only.txt", bytes: 4 });
    } finally {
      upload.dispose();
    }
    expectNoNewUploadDirectories();
  });

  it("rejects 11 multipart parts as an ordinary error and cleans owned temp storage", async () => {
    const boundary = "over-parts-limit";
    const parts = [
      ...tenMultipartParts(),
      { headers: ["Content-Disposition: attachment"], body: "eleventh part" },
    ];
    const error = await parseMultipartUpload(
      multipartRequest(streamFromBytes(multipartBody(boundary, parts)), boundary),
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RequestTooLargeError);
    expectNoNewUploadDirectories();
  });

  it.each([
    {
      name: "files",
      boundary: "files-limit",
      parts: [
        filePart("one.txt", "text/plain", Buffer.from("one")),
        filePart("two.txt", "text/plain", Buffer.from("two")),
      ],
    },
    {
      name: "fields",
      boundary: "fields-limit",
      parts: Array.from({ length: 9 }, (_, index) => fieldPart(`field${index}`, "value")),
    },
    {
      name: "fieldSize",
      boundary: "field-size-limit",
      parts: [fieldPart("large", "x".repeat(64 * 1024 + 1))],
    },
  ])("rejects the $name limit as an ordinary error and cleans temp storage", async ({ boundary, parts }) => {
    const error = await parseMultipartUpload(
      multipartRequest(streamFromBytes(multipartBody(boundary, parts)), boundary),
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RequestTooLargeError);
    expectNoNewUploadDirectories();
  });
});

describe("parseMultipartUpload failure cleanup", () => {
  it("preserves mkdtemp failure while destroying parsers and cancelling without waiting", async () => {
    const mkdtempError = new Error("injected mkdtemp failure");
    vi.spyOn(fs.promises, "mkdtemp").mockRejectedValueOnce(mkdtempError);
    const destroy = vi.spyOn(Writable.prototype, "destroy");
    let markCancelStarted!: () => void;
    let releaseCancel!: () => void;
    const cancelStarted = new Promise<void>((resolve) => { markCancelStarted = resolve; });
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const cancel = vi.fn(async () => {
      markCancelStarted();
      await cancelGate;
    });
    const body = streamFromBytes(new Uint8Array(0), { cancel, close: false });
    const settled = parseMultipartUpload(multipartRequest(body, "mkdtemp-failure")).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    const first = await Promise.race([
      cancelStarted.then(() => "cancel" as const),
      settled.then(() => "settled" as const),
    ]);

    try {
      expect(first).toBe("cancel");
      // 原实现用 Promise.race 与 100ms 真实 timer 竞速，慢机器上 rejection 晚到即误报。
      const outcome = await settled;
      expect(outcome).toEqual({ status: "rejected", reason: mkdtempError });
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(destroy).toHaveBeenCalledTimes(2);
      expectNoNewUploadDirectories();
    } finally {
      releaseCancel();
      await settled;
    }
  });

  it("preserves a synchronous getReader failure, cancels the body, and removes its temp directory", async () => {
    const getReaderError = new Error("injected getReader failure");
    const cancel = vi.fn().mockRejectedValue(new Error("injected body cancel failure"));
    const mkdtemp = vi.spyOn(fs.promises, "mkdtemp");
    const request = {
      body: {
        getReader: vi.fn(() => { throw getReaderError; }),
        cancel,
      },
      headers: new Headers({ "Content-Type": "multipart/form-data; boundary=get-reader-failure" }),
    } as unknown as Request;

    await expect(parseMultipartUpload(request)).rejects.toBe(getReaderError);
    expect(mkdtemp).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expectNoNewUploadDirectories();
  });

  it("preserves a file write failure and removes the temp directory", async () => {
    const writeError = new Error("injected upload write failure");
    vi.spyOn(fs, "createWriteStream").mockImplementationOnce(() => new Writable({
      write(_chunk, _encoding, callback) {
        callback(writeError);
      },
    }) as fs.WriteStream);
    const boundary = "write-failure";
    const body = multipartBody(boundary, [
      filePart("write.txt", "text/plain", Buffer.from("cannot persist")),
    ]);

    await expect(
      parseMultipartUpload(multipartRequest(streamFromBytes(body), boundary)),
    ).rejects.toBe(writeError);
    expectNoNewUploadDirectories();
  });

  it("preserves a Web reader failure, cancels, unlocks, and removes partial files", async () => {
    const readError = new Error("injected upload read failure");
    const cancel = vi.fn();
    const releaseLock = vi.fn();
    const boundary = "read-failure";
    const partialBody = multipartBody(boundary, [
      filePart("partial.txt", "text/plain", Buffer.from("partial")),
    ], false);
    const request = {
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: partialBody })
            .mockRejectedValueOnce(readError),
          cancel,
          releaseLock,
        }),
      },
      headers: new Headers({ "Content-Type": `multipart/form-data; boundary=${boundary}` }),
    } as unknown as Request;

    await expect(parseMultipartUpload(request)).rejects.toBe(readError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    expectNoNewUploadDirectories();
  });

  it("does not await pending cancel or replace the 413 when cancel and cleanup fail", async () => {
    let markCancelStarted!: () => void;
    let releaseCancel!: () => void;
    const cancelStarted = new Promise<void>((resolve) => { markCancelStarted = resolve; });
    const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const cancel = vi.fn(async () => {
      markCancelStarted();
      await cancelGate;
      throw new Error("injected cancel cleanup failure");
    });
    const bytes = Buffer.alloc(MAX_MULTIPART_REQUEST_BYTES + 1, 0x79);
    const body = streamFromBytes(bytes, {
      cancel,
      chunkSize: bytes.byteLength,
      close: false,
    });
    const cleanupError = new Error("injected directory cleanup failure");
    const originalRmSync = fs.rmSync;
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      const resolved = safeUploadDirectory(String(target));
      originalRmSync(resolved, options);
      throw cleanupError;
    });
    const settled = parseMultipartUpload(multipartRequest(body, "pending-cancel")).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );

    await cancelStarted;
    try {
      const outcome = await Promise.race([
        settled,
        new Promise<{ status: "pending" }>((resolve) => {
          queueMicrotask(() => resolve({ status: "pending" }));
        }),
      ]);

      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(RequestTooLargeError);
        expect(outcome.reason).not.toBe(cleanupError);
      }
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expectNoNewUploadDirectories();
    } finally {
      rmSpy.mockRestore();
      releaseCancel();
      await settled;
    }
  });
});

describe("multipart route integration", () => {
  let dataDirectory: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    vi.resetModules();
    dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-upload-route-"));
    vi.stubEnv("RESUME_LIFE_DATA_DIR", dataDirectory);
    db = (await import("../db")).getDb();
    db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'上传项目','created','original-project')");
  });

  afterEach(() => {
    db?.close();
    vi.unstubAllEnvs();
    const resolved = path.resolve(dataDirectory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir())
      || !path.basename(resolved).startsWith("resume-life-upload-route-")
    ) {
      throw new Error(`Unsafe route database cleanup target: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  async function importResume(parts: MultipartPart[], boundary: string, close = true) {
    const { POST } = await import("../../app/api/import/parse/route");
    const body = multipartBody(boundary, parts, close);
    return POST(multipartRequest(streamFromBytes(body, { chunkSize: 256 * 1024 }), boundary));
  }

  async function createMaterial(parts: MultipartPart[], boundary: string, close = true) {
    const { POST } = await import("../../app/api/projects/[id]/materials/route");
    const body = multipartBody(boundary, parts, close);
    return POST(
      multipartRequest(streamFromBytes(body, { chunkSize: 256 * 1024 }), boundary),
      { params: Promise.resolve({ id: "1" }) },
    );
  }

  function databaseState() {
    return {
      project: db.prepare("SELECT * FROM projects WHERE id = 1").get(),
      materials: db.prepare("SELECT * FROM project_materials ORDER BY id").all(),
    };
  }

  it.each(["-1", "01", "9007199254740992"])(
    "import parse maps invalid multipart Content-Length %j to 400 before reading or creating temp storage",
    async (contentLength) => {
      const output = vi.spyOn(console, "error").mockImplementation(() => {});
      const mkdtemp = vi.spyOn(fs.promises, "mkdtemp");
      const { request, getReader } = unreadMultipartRequest(contentLength, "import-invalid-length");
      const { POST } = await import("../../app/api/import/parse/route");

      const response = await POST(request);

      expect(response.status).toBe(400);
      expect(output).not.toHaveBeenCalled();
      expect(getReader).not.toHaveBeenCalled();
      expect(mkdtemp).not.toHaveBeenCalled();
      expectNoNewUploadDirectories();
    },
  );

  it.each(["-1", "01", "9007199254740992"])(
    "materials POST maps invalid multipart Content-Length %j to 400 without persistence or temp storage",
    async (contentLength) => {
      const before = databaseState();
      const output = vi.spyOn(console, "error").mockImplementation(() => {});
      const mkdtemp = vi.spyOn(fs.promises, "mkdtemp");
      const { request, getReader } = unreadMultipartRequest(contentLength, "material-invalid-length");
      const { POST } = await import("../../app/api/projects/[id]/materials/route");

      const response = await POST(request, { params: Promise.resolve({ id: "1" }) });

      expect(response.status).toBe(400);
      expect(output).not.toHaveBeenCalled();
      expect(getReader).not.toHaveBeenCalled();
      expect(mkdtemp).not.toHaveBeenCalled();
      expect(databaseState()).toEqual(before);
      expectNoNewUploadDirectories();
    },
  );

  it("import parse rejects a 10 MiB text file at the extraction limit without temp residue", async () => {
    const response = await importResume([
      fieldPart("extractOnly", "true"),
      filePart("exact.txt", "text/plain", Buffer.alloc(MAX_UPLOAD_FILE_BYTES, 0x61)),
    ], "import-exact-file");

    expect(response.status).toBe(400);
    expectNoNewUploadDirectories();
  });

  it("import parse maps a file one byte over 10 MiB to 413 without temp residue", async () => {
    const response = await importResume([
      fieldPart("extractOnly", "true"),
      filePart("over.txt", "text/plain", Buffer.alloc(MAX_UPLOAD_FILE_BYTES + 1, 0x62)),
    ], "import-over-file");

    expect(response.status).toBe(413);
    expectNoNewUploadDirectories();
  });

  it("import parse maps malformed multipart to 400 without temp residue", async () => {
    const response = await importResume([
      filePart("broken.txt", "text/plain", Buffer.from("never closed")),
    ], "import-malformed", false);

    expect(response.status).toBe(400);
    expectNoNewUploadDirectories();
  });

  it("import parse recognizes a mixed-case multipart media type", async () => {
    const boundary = "import-mixed-case";
    const body = multipartBody(boundary, [
      fieldPart("extractOnly", "true"),
      filePart("resume.txt", "text/plain", Buffer.from("mixed case resume")),
    ]);
    const request = multipartRequest(
      streamFromBytes(body),
      boundary,
      undefined,
      "Multipart/Form-Data",
    );
    const { POST } = await import("../../app/api/import/parse/route");

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ extractedText: "mixed case resume" });
    expectNoNewUploadDirectories();
  });

  it("import parse maps temporary storage failures to a generic 500", async () => {
    const internalMessage = "PRIVATE_MKDTEMP_FAILURE";
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("../../app/api/import/parse/route");
    vi.spyOn(fs.promises, "mkdtemp").mockRejectedValueOnce(new Error(internalMessage));
    const boundary = "import-storage-failure";
    const request = multipartRequest(
      streamFromBytes(multipartBody(boundary, [
        filePart("resume.txt", "text/plain", Buffer.from("resume")),
      ])),
      boundary,
    );
    request.headers.set("x-request-id", "req-import-storage");

    const response = await POST(request);
    const result = await response.json();

    expect(response.status).toBe(500);
    expect(result).toEqual({
      error: "简历文件处理失败，请稍后重试",
      requestId: "req-import-storage",
    });
    expect(JSON.stringify(result)).not.toContain(internalMessage);
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.stringify(output.mock.calls.flat())).not.toContain(internalMessage);
    expectNoNewUploadDirectories();
  });

  it("materials POST accepts the exact Unicode code point boundary and disposes the upload", async () => {
    const content = "😀".repeat(MAX_PROJECT_MATERIAL_CHARS);
    const response = await createMaterial([
      fieldPart("title", "边界文件"),
      filePart("boundary.txt", "text/plain", Buffer.from(content)),
    ], "material-exact-content");

    expect(response.status).toBe(201);
    expect(db.prepare("SELECT title, source, filename, content FROM project_materials").get()).toEqual({
      title: "边界文件",
      source: "file",
      filename: "boundary.txt",
      content,
    });
    expectNoNewUploadDirectories();
  });

  it("materials POST rejects text over the extraction limit before persistence and disposes the upload", async () => {
    const before = databaseState();
    const content = `${"😀".repeat(MAX_PROJECT_MATERIAL_CHARS)}x`;
    const response = await createMaterial([
      fieldPart("title", "超限文件"),
      filePart("over.txt", "text/plain", Buffer.from(content)),
    ], "material-over-content");

    expect(response.status).toBe(400);
    expect(databaseState()).toEqual(before);
    expectNoNewUploadDirectories();
  });

  it("materials POST recognizes a mixed-case multipart media type", async () => {
    const boundary = "material-mixed-case";
    const body = multipartBody(boundary, [
      fieldPart("title", "混合大小写"),
      filePart("material.txt", "text/plain", Buffer.from("material content")),
    ]);
    const request = multipartRequest(
      streamFromBytes(body),
      boundary,
      undefined,
      "Multipart/Form-Data",
    );
    const { POST } = await import("../../app/api/projects/[id]/materials/route");

    const response = await POST(request, { params: Promise.resolve({ id: "1" }) });

    expect(response.status).toBe(201);
    expect(db.prepare("SELECT title, content FROM project_materials").get()).toEqual({
      title: "混合大小写",
      content: "material content",
    });
    expectNoNewUploadDirectories();
  });

  it("materials POST maps temporary file read failures to a generic 500 before persistence", async () => {
    const before = databaseState();
    const internalMessage = "PRIVATE_TEMP_READ_FAILURE";
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("../../app/api/projects/[id]/materials/route");
    vi.spyOn(fs.promises, "readFile").mockRejectedValueOnce(new Error(internalMessage));
    const boundary = "material-read-failure";
    const request = multipartRequest(
      streamFromBytes(multipartBody(boundary, [
        filePart("material.txt", "text/plain", Buffer.from("material")),
      ])),
      boundary,
    );
    request.headers.set("x-request-id", "req-material-read");

    const response = await POST(request, { params: Promise.resolve({ id: "1" }) });
    const result = await response.json();

    expect(response.status).toBe(500);
    expect(result).toEqual({
      error: "保存项目材料失败，请稍后重试",
      requestId: "req-material-read",
    });
    expect(JSON.stringify(result)).not.toContain(internalMessage);
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.stringify(output.mock.calls.flat())).not.toContain(internalMessage);
    expect(databaseState()).toEqual(before);
    expectNoNewUploadDirectories();
  });

  it("materials POST maps malformed multipart to 400 without persistence or temp residue", async () => {
    const before = databaseState();
    const response = await createMaterial([
      filePart("broken.txt", "text/plain", Buffer.from("never closed")),
    ], "material-malformed", false);

    expect(response.status).toBe(400);
    expect(databaseState()).toEqual(before);
    expectNoNewUploadDirectories();
  });
});

describe("txt/md 提取的字符上限", () => {
  it("20 万字符以内正常提取", async () => {
    const text = "a".repeat(200_000);
    await expect(extractTextFromFile("big.txt", Buffer.from(text, "utf8"))).resolves.toHaveLength(200_000);
  });

  it("超过 20 万字符抛 FileFormatError", async () => {
    const text = "a".repeat(200_001);
    await expect(extractTextFromFile("big.txt", Buffer.from(text, "utf8"))).rejects.toBeInstanceOf(FileFormatError);
  });
});
