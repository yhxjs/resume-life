import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OCR_ASSETS, prepareOcrAssets } from "../../../scripts/prepare-ocr.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-ocr-setup-"));
  temporaryDirectories.push(directory);
  return directory;
}

function response(bytes: Uint8Array, status = 200) {
  return new Response(Buffer.from(bytes), { status, headers: { "content-type": "application/gzip" } });
}

describe("prepare-ocr.mjs", () => {
  it("模型已就绪且散列正确时不下载", async () => {
    const directory = tempDirectory();
    for (const asset of OCR_ASSETS) {
      fs.copyFileSync(path.join(process.cwd(), `${asset.language}.traineddata`), path.join(directory, `${asset.language}.traineddata`));
    }
    const fetchImpl = vi.fn();
    await prepareOcrAssets({ directory, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("下载失败或散列错误时不污染已有语言包", async () => {
    const directory = tempDirectory();
    const existing = Buffer.from("existing-model");
    fs.writeFileSync(path.join(directory, "eng.traineddata"), existing);
    const fetchImpl = vi.fn().mockResolvedValue(response(zlib.gzipSync(Buffer.from("bad"))));
    await expect(prepareOcrAssets({ directory, fetchImpl })).rejects.toThrow(/SHA-256/);
    expect(fs.readFileSync(path.join(directory, "eng.traineddata"))).toEqual(existing);
  });

  it("校验固定来源后原子写入中英文模型", async () => {
    const directory = tempDirectory();
    const contents = new Map(OCR_ASSETS.map((asset) => [asset.language, Buffer.from(`test-${asset.language}`)]));
    const assets = OCR_ASSETS.map((asset) => ({
      ...asset,
      bytes: contents.get(asset.language)!.length,
      sha256: crypto.createHash("sha256").update(contents.get(asset.language)!).digest("hex"),
    }));
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const asset = assets.find((candidate) => candidate.url === String(input))!;
      return Promise.resolve(response(zlib.gzipSync(contents.get(asset.language)!)));
    });
    await prepareOcrAssets({ directory, fetchImpl, assets });
    for (const asset of OCR_ASSETS) expect(fs.readFileSync(path.join(directory, `${asset.language}.traineddata`))).toEqual(contents.get(asset.language));
    expect(fs.readdirSync(directory).sort()).toEqual(["chi_sim.traineddata", "eng.traineddata"]);
    expect(fetchImpl.mock.calls.every(([, options]) => options?.signal instanceof AbortSignal)).toBe(true);
  });

  it("HTTP 失败不写入文件且保留现有模型", async () => {
    const directory = tempDirectory();
    fs.writeFileSync(path.join(directory, "eng.traineddata"), "existing-model");
    await expect(prepareOcrAssets({ directory, fetchImpl: vi.fn().mockResolvedValue(response(Buffer.alloc(0), 503)) }))
      .rejects.toThrow(/HTTP 503/);
    expect(fs.readFileSync(path.join(directory, "eng.traineddata"), "utf8")).toBe("existing-model");
    expect(fs.existsSync(path.join(directory, "chi_sim.traineddata"))).toBe(false);
  });

  it("后一个模型失败时前一个有效下载也不覆盖本地文件", async () => {
    const directory = tempDirectory();
    const content = Buffer.from("test-eng");
    const assets = OCR_ASSETS.map((asset) => ({
      ...asset,
      bytes: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    }));
    fs.writeFileSync(path.join(directory, "eng.traineddata"), "existing-model");
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(zlib.gzipSync(content)))
      .mockResolvedValueOnce(response(Buffer.alloc(0), 503));
    await expect(prepareOcrAssets({ directory, fetchImpl, assets })).rejects.toThrow(/HTTP 503/);
    expect(fs.readFileSync(path.join(directory, "eng.traineddata"), "utf8")).toBe("existing-model");
    expect(fs.existsSync(path.join(directory, "chi_sim.traineddata"))).toBe(false);
  });
});
