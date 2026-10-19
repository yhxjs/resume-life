import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createWorker } = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock("tesseract.js", () => ({ createWorker }));
vi.mock("../settings", () => ({ readSettings: () => ({ ocr_mode: "local" }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function workerFixture() {
  const termination = deferred<void>();
  const worker = {
    recognize: vi.fn().mockResolvedValue({ data: { text: "valid OCR text" } }),
    terminate: vi.fn(() => termination.promise),
  };
  return { worker, termination };
}

let temporary: string;
let image: Buffer;
beforeEach(() => {
  vi.resetModules();
  createWorker.mockReset();
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-ocr-resource-"));
  fs.writeFileSync(path.join(temporary, "chi_sim.traineddata"), "fixture");
  fs.writeFileSync(path.join(temporary, "eng.traineddata"), "fixture");
  vi.stubEnv("RESUME_LIFE_OCR_DATA_DIR", temporary);
  const canvas = createCanvas(20, 20);
  canvas.getContext("2d").fillRect(0, 0, 20, 20);
  image = canvas.toBuffer("image/png");
  fs.writeFileSync(path.join(temporary, "fixture.png"), image);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("resume-life-ocr-resource-")) {
    throw new Error(`Unsafe OCR fixture cleanup target: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

describe("real extraction/local OCR initialization resource ownership", () => {
  it.each(["cancel", "timeout"])("%s replies promptly but retains both slots through late creation and paused termination", async (stop) => {
    const creations = [deferred<ReturnType<typeof workerFixture>["worker"]>(), deferred<ReturnType<typeof workerFixture>["worker"]>()];
    const workers = [workerFixture(), workerFixture()];
    createWorker.mockImplementationOnce(() => creations[0]!.promise).mockImplementationOnce(() => creations[1]!.promise);
    if (stop === "timeout") {
      const schedule = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => schedule(callback, delay === 60_000 ? 30 : delay, ...args));
    }
    const { extractContentFromFile, extractContentFromPath, ParseBusyError } = await import("../parse-file");
    const controllers = [new AbortController(), new AbortController()];
    const outcomes = [
      extractContentFromFile("first.png", image, { signal: controllers[0]!.signal }),
      extractContentFromPath("second.png", path.join(temporary, "fixture.png"), { signal: controllers[1]!.signal }),
    ].map((pending) => pending.then(() => new Error("unexpected success"), (error: unknown) => error));
    try {
      await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));
      if (stop === "cancel") controllers.forEach((controller) => controller.abort(new Error("cancelled initialization")));
      const results = await Promise.all(outcomes);
      for (const error of results) expect(error).toBeInstanceOf(Error);
      expect(results.map((error) => (error as Error).message).join(" ")).toContain(stop === "cancel" ? "cancelled initialization" : "超时");
      await expect(extractContentFromFile("third.png", image)).rejects.toBeInstanceOf(ParseBusyError);
      expect(createWorker).toHaveBeenCalledTimes(2);

      creations.forEach((creation, index) => creation.resolve(workers[index]!.worker));
      await vi.waitFor(() => workers.forEach(({ worker }) => expect(worker.terminate).toHaveBeenCalledOnce()));
      await expect(extractContentFromFile("still-busy.png", image)).rejects.toBeInstanceOf(ParseBusyError);
      workers.forEach(({ worker }) => expect(worker.recognize).not.toHaveBeenCalled());

      workers[0]!.termination.resolve();
      await vi.waitFor(async () => expect(await extractContentFromFile("released.txt", Buffer.from("released"))).toEqual({ text: "released" }));
      workers[1]!.termination.resolve();
      await vi.waitFor(async () => expect(await Promise.all([0, 1].map(() => extractContentFromFile("released.txt", Buffer.from("released"))))).toHaveLength(2));
      expect(createWorker).toHaveBeenCalledTimes(2);
    } finally {
      controllers.forEach((controller) => controller.abort());
      creations.forEach((creation, index) => creation.resolve(workers[index]!.worker));
      workers.forEach(({ termination }) => termination.resolve());
      await Promise.all(outcomes);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });

  it("cancelled initialization rejection releases both slots without English fallback", async () => {
    const creations = [deferred<ReturnType<typeof workerFixture>["worker"]>(), deferred<ReturnType<typeof workerFixture>["worker"]>()];
    createWorker.mockImplementationOnce(() => creations[0]!.promise).mockImplementationOnce(() => creations[1]!.promise);
    const { extractContentFromFile, ParseBusyError } = await import("../parse-file");
    const controller = new AbortController();
    const pending = [0, 1].map(() => extractContentFromFile("fixture.png", image, { signal: controller.signal }).catch((error) => error));
    try {
      await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));
      controller.abort(new Error("cancelled initialization"));
      await Promise.all(pending);
      await expect(extractContentFromFile("third.png", image)).rejects.toBeInstanceOf(ParseBusyError);
      creations.forEach((creation) => creation.reject(new Error("failed initialization")));
      await vi.waitFor(async () => expect(await Promise.all([0, 1].map(() => extractContentFromFile("released.txt", Buffer.from("released"))))).toHaveLength(2));
      expect(createWorker).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      creations.forEach((creation) => creation.reject(new Error("fixture cleanup")));
      await Promise.all(pending);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });

  it.each(["cancel", "timeout"])("%s during recognition replies before paused termination without freeing the resource slots", async (stop) => {
    const workers = [workerFixture(), workerFixture()];
    const recognitions = [deferred<{ data: { text: string } }>(), deferred<{ data: { text: string } }>()];
    workers.forEach(({ worker }, index) => worker.recognize.mockImplementation(() => recognitions[index]!.promise));
    createWorker.mockResolvedValueOnce(workers[0]!.worker).mockResolvedValueOnce(workers[1]!.worker);
    if (stop === "timeout") {
      const schedule = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => schedule(callback, delay === 60_000 ? 30 : delay, ...args));
    }
    const { extractContentFromFile, ParseBusyError } = await import("../parse-file");
    const controller = new AbortController();
    const outcomes = [0, 1].map(() => extractContentFromFile("fixture.png", image, { signal: controller.signal }).catch((error) => error));
    try {
      await vi.waitFor(() => workers.forEach(({ worker }) => expect(worker.recognize).toHaveBeenCalledOnce()));
      if (stop === "cancel") controller.abort(new Error("cancelled recognition"));
      const result = await Promise.race([
        Promise.all(outcomes),
        new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 100)),
      ]);
      expect(result).not.toBe("still waiting");
      expect((result as Error[]).map((error) => error.message).join(" ")).toContain(stop === "cancel" ? "cancelled recognition" : "超时");
      workers.forEach(({ worker }) => expect(worker.terminate).toHaveBeenCalledOnce());
      await expect(extractContentFromFile("third.png", image)).rejects.toBeInstanceOf(ParseBusyError);
      workers.forEach(({ termination }) => termination.resolve());
      await vi.waitFor(async () => expect(await Promise.all([0, 1].map(() => extractContentFromFile("released.txt", Buffer.from("released"))))).toHaveLength(2));
      expect(createWorker).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      workers.forEach(({ termination }) => termination.resolve());
      recognitions.forEach((recognition) => recognition.resolve({ data: { text: "late OCR result" } }));
      await Promise.all(outcomes);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });

  it("initialization failure reports the required language without English fallback and releases resources", async () => {
    const recognize = vi.fn().mockResolvedValue({ data: { text: "valid OCR text" } });
    const terminate = vi.fn().mockResolvedValue(undefined);
    createWorker.mockRejectedValueOnce(new Error("combined language failure")).mockResolvedValueOnce({ recognize, terminate });
    const { extractContentFromFile } = await import("../parse-file");
    await expect(extractContentFromFile("fixture.png", image)).rejects.toThrow(/OCR.*语言初始化失败.*chi_sim\+eng/);
    expect(createWorker.mock.calls.map(([language]) => language)).toEqual(["chi_sim+eng"]);
    expect(recognize).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
    await expect(Promise.all([0, 1].map(() => extractContentFromFile("released.txt", Buffer.from("released"))))).resolves.toHaveLength(2);
  });

  it("termination failure preserves a valid result, retains its slot, and logs safe diagnostics", async () => {
    const recognize = vi.fn().mockResolvedValue({ data: { text: "PRIVATE_VALID_OCR_RESULT" } });
    const terminate = vi.fn().mockRejectedValue(new Error("PRIVATE_CLEANUP_FAILURE"));
    const creation = deferred<ReturnType<typeof workerFixture>["worker"]>();
    const second = workerFixture();
    createWorker.mockResolvedValueOnce({ recognize, terminate }).mockImplementationOnce(() => creation.promise);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { extractContentFromFile, ParseBusyError } = await import("../parse-file");
    await expect(extractContentFromFile("first.png", image)).resolves.toMatchObject({ text: "PRIVATE_VALID_OCR_RESULT" });
    expect(terminate).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("ocr.local_worker_cleanup_failed");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/PRIVATE_VALID_OCR_RESULT|PRIVATE_CLEANUP_FAILURE/);
    const controller = new AbortController();
    const pending = extractContentFromFile("second.png", image, { signal: controller.signal }).catch((error) => error);
    try {
      await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));
      await expect(extractContentFromFile("third.png", image)).rejects.toBeInstanceOf(ParseBusyError);
    } finally {
      controller.abort();
      creation.resolve(second.worker);
      second.termination.resolve();
      await pending;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
});
