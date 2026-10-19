import fs from "node:fs";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sandbox from "../parse-sandbox";
import * as ocr from "../ocr-service";
import { extractContentFromFile, extractContentFromPath, PdfNoTextError } from "../parse-file";

vi.mock("../docx-budget", () => ({ assertDocxArchiveBudget: vi.fn() }));
vi.mock("../ocr-service", () => ({ recognizeScannedPdf: vi.fn(), recognizeImage: vi.fn() }));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("shared extraction resource budget", () => {
  it("eight mixed file/path calls share two slots before PDF/OCR resources are created", async () => {
    const releases: Array<() => void> = [];
    const pdf = vi.spyOn(sandbox, "runInSandboxedProcess").mockImplementation(() => new Promise((resolve) => {
      releases.push(() => resolve("pdf text"));
    }));
    vi.mocked(ocr.recognizeImage).mockImplementation(() => new Promise((resolve) => {
      releases.push(() => resolve({ text: "image text", engine: "local", pageCount: 1 }));
    }));
    const read = vi.spyOn(fs.promises, "readFile").mockResolvedValue(Buffer.from("fixture"));
    const outcomes: Array<{ index: number; error?: unknown }> = [];
    const pending = Array.from({ length: 8 }, (_, index) => (
      index % 2 === 0
        ? extractContentFromFile("resume.pdf", Buffer.from("fixture"))
        : extractContentFromPath("material.png", "isolated-fixture")
    ).then(() => { outcomes.push({ index }); }, (error) => { outcomes.push({ index, error }); }));
    try {
      await vi.waitFor(() => expect(outcomes).toHaveLength(6));
      expect(outcomes.every(({ error }) => error instanceof Error && error.name === "ParseBusyError")).toBe(true);
      expect(pdf).toHaveBeenCalledOnce();
      expect(ocr.recognizeImage).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledOnce();
    } finally {
      releases.forEach((release) => release());
      await Promise.all(pending);
    }
    await expect(extractContentFromFile("next.txt", Buffer.from("released"))).resolves.toEqual({ text: "released" });
  });

  it("pre-cancellation does not read a path or start PDF, DOCX or OCR", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before extraction");
    controller.abort(reason);
    const pdf = vi.spyOn(sandbox, "runInSandboxedProcess").mockResolvedValue("unexpected");
    const docx = vi.spyOn(sandbox, "runInSandboxedWorker").mockResolvedValue("unexpected");
    const read = vi.spyOn(fs.promises, "readFile").mockResolvedValue(Buffer.from("fixture"));
    for (const filename of ["a.pdf", "a.docx", "a.png", "a.txt"]) {
      await expect(extractContentFromFile(filename, Buffer.from("fixture"), { signal: controller.signal })).rejects.toBe(reason);
    }
    await expect(extractContentFromPath("a.pdf", "isolated-fixture", { signal: controller.signal })).rejects.toBe(reason);
    expect(pdf).not.toHaveBeenCalled();
    expect(docx).not.toHaveBeenCalled();
    expect(ocr.recognizeImage).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("forwards cancellation to PDF and DOCX sandboxes and releases cancelled/error slots", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled sandbox");
    const pdf = vi.spyOn(sandbox, "runInSandboxedProcess").mockImplementation((_source, _module, _data, _limits, _timeout, _read, options) => (
      new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(reason), { once: true }))
    ));
    const docx = vi.spyOn(sandbox, "runInSandboxedWorker").mockRejectedValue(new sandbox.FileFormatError("fixture failure"));
    const pending = extractContentFromFile("a.pdf", Buffer.from("fixture"), { signal: controller.signal });
    const outcome = pending.catch((error) => error);
    await expect(extractContentFromFile("a.docx", Buffer.from("fixture"), { signal: controller.signal })).rejects.toThrow("fixture failure");
    expect(pdf.mock.calls[0]?.[6]).toEqual({ signal: controller.signal });
    expect(docx.mock.calls[0]?.[5]).toEqual({ signal: controller.signal });
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    await expect(Promise.all([0, 1].map(() => extractContentFromFile("next.txt", Buffer.from("released"))))).resolves.toEqual([
      { text: "released" }, { text: "released" },
    ]);
  });

  it("cancellation after PDF extraction prevents the OCR fallback stage", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before OCR");
    vi.spyOn(sandbox, "runInSandboxedProcess").mockImplementation(async () => {
      controller.abort(reason);
      throw new PdfNoTextError();
    });
    vi.mocked(ocr.recognizeScannedPdf).mockResolvedValue({ text: "unexpected", engine: "local", pageCount: 1 });
    await expect(extractContentFromFile("a.pdf", Buffer.from("fixture"), { signal: controller.signal })).rejects.toBe(reason);
    expect(ocr.recognizeScannedPdf).not.toHaveBeenCalled();
  });

  it("cancellation during OCR preserves the cancellation reason and releases its slot", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled OCR");
    vi.mocked(ocr.recognizeImage).mockImplementation(async () => { controller.abort(reason); throw reason; });
    await expect(extractContentFromFile("a.png", Buffer.from("fixture"), { signal: controller.signal })).rejects.toBe(reason);
    await expect(extractContentFromFile("next.txt", Buffer.from("released"))).resolves.toEqual({ text: "released" });
  });
});

describe("PDF/DOCX/TXT extraction counts Unicode code points", () => {
  it.each(["pdf", "docx", "txt"])("%s accepts exactly 200000 supplementary characters and rejects one more", async (ext) => {
    let text = "\u{1f600}".repeat(200_000);
    vi.spyOn(sandbox, "runInSandboxedWorker").mockImplementation((source, data, _limits, _timeout, read) => new Promise((resolve, reject) => {
      const parentPort = { postMessage(message: unknown) { try { resolve(read(message)); } catch (error) { reject(error); } } };
      vm.runInNewContext(source, { Buffer, require: (name: string) => name === "node:worker_threads"
        ? { parentPort, workerData: data }
        : { extractRawText: async () => ({ value: text }) } });
    }));
    vi.spyOn(sandbox, "runInSandboxedProcess").mockImplementation((source, _module, _data, _limits, _timeout, read) => new Promise((resolve, reject) => {
      const stdin = new EventEmitter();
      const stdout = { write(value: string) { try { resolve(read(value)); } catch (error) { reject(error); } } };
      class PDFParse { async load() {} async getText() { return { text }; } async destroy() {} }
      vm.runInNewContext(source, { Buffer, process: { argv: ["", "fixture"], stdin, stdout }, require: () => ({ PDFParse }) });
      stdin.emit("end");
    }));
    await expect(extractContentFromFile(`boundary.${ext}`, Buffer.from(text))).resolves.toEqual({ text });
    text += "x";
    await expect(extractContentFromFile(`over.${ext}`, Buffer.from(text))).rejects.toBeInstanceOf(sandbox.FileFormatError);
  });
});
