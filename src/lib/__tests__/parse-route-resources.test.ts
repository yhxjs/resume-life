import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sandbox from "../parse-sandbox";
import { extractContentFromFile } from "../parse-file";
import { POST as importResume } from "../../app/api/import/parse/route";
import { POST as createMaterial } from "../../app/api/projects/[id]/materials/route";

const fixtures = vi.hoisted(() => ({ dispose: vi.fn(), run: vi.fn(), safeChat: vi.fn() }));
vi.mock("../streaming-multipart", async (original) => ({
  ...await original<typeof import("../streaming-multipart")>(),
  parseMultipartUpload: vi.fn(async () => ({
    file: { filename: "fixture.pdf", path: "isolated-fixture" }, fields: {}, dispose: fixtures.dispose,
  })),
}));
vi.mock("../db", () => ({
  requestDataGeneration: () => null,
  getDb: () => ({ prepare: () => ({ get: () => ({ id: 1 }), run: fixtures.run }) }),
  inTransaction: (operation: () => unknown) => operation(), now: () => "fixture",
}));
vi.mock("../safe-llm", () => ({ safeChat: fixtures.safeChat, LLM_FEATURES: { resumeImportParse: "fixture" } }));
vi.mock("../ocr-service", () => ({ recognizeScannedPdf: vi.fn(), recognizeImage: vi.fn() }));

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(fs.promises, "readFile").mockResolvedValue(Buffer.from("fixture")); });
afterEach(() => { vi.restoreAllMocks(); });

function request(signal?: AbortSignal) {
  return new Request("http://localhost/api/import/parse", {
    method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=fixture" }, signal,
  });
}

describe("parse APIs share extraction capacity", () => {
  it("import and materials map the same busy error to 429 without starting another sandbox", async () => {
    const release: Array<() => void> = [];
    const process = vi.spyOn(sandbox, "runInSandboxedProcess").mockImplementation(() => new Promise((resolve) => {
      release.push(() => resolve("fixture text"));
    }));
    const pending = [0, 1].map(() => extractContentFromFile("a.pdf", Buffer.from("fixture")));
    try {
      const responses = await Promise.all([
        importResume(request()),
        createMaterial(request(), { params: Promise.resolve({ id: "1" }) }),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(429);
        expect(await response.json()).toEqual({ error: expect.stringContaining("解析") });
      }
      expect(process).toHaveBeenCalledTimes(2);
      expect(fixtures.dispose).toHaveBeenCalledTimes(2);
      expect(fixtures.run).not.toHaveBeenCalled();
      expect(fixtures.safeChat).not.toHaveBeenCalled();
    } finally {
      release.forEach((finish) => finish());
      await Promise.all(pending);
    }
  });

  it.each(["import", "materials"])("%s cancellation reaches the parser and prevents model or persistence stages", async (api) => {
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    const process = vi.spyOn(sandbox, "runInSandboxedProcess").mockImplementation((_source, _module, _data, _limits, _timeout, _read, options) => (
      new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(reason), { once: true }))
    ));
    const req = request(controller.signal);
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = api === "import"
      ? importResume(req)
      : createMaterial(req, { params: Promise.resolve({ id: "1" }) });
    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());
    expect(process.mock.calls[0]?.[6]).toEqual({ signal: req.signal });
    controller.abort(reason);
    await pending;
    expect(fixtures.run).not.toHaveBeenCalled();
    expect(fixtures.safeChat).not.toHaveBeenCalled();
    expect(fixtures.dispose).toHaveBeenCalledOnce();
    output.mockRestore();
  });
});
