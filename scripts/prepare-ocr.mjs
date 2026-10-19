import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export const OCR_ASSETS = [
  {
    language: "eng",
    bytes: 5_199_098,
    url: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz",
    sha256: "5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747",
  },
  {
    language: "chi_sim",
    bytes: 2_471_033,
    url: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz",
    sha256: "9784f7c917c546424b690fcde708ce1f604a4393d08bb51ddab146d7d7c794e6",
  },
];

function digest(buffer, algorithm, encoding = "hex") {
  return crypto.createHash(algorithm).update(buffer).digest(encoding);
}

function decodeAsset(asset, compressedData) {
  const data = zlib.gunzipSync(compressedData, { maxOutputLength: asset.bytes });
  if (data.length !== asset.bytes || digest(data, "sha256") !== asset.sha256) {
    throw new Error(`OCR 语言包 SHA-256 校验失败：${asset.language}`);
  }
  return data;
}

function isValidAsset(asset, target) {
  try {
    const data = fs.readFileSync(target);
    return data.length === asset.bytes && digest(data, "sha256") === asset.sha256;
  } catch {
    return false;
  }
}

export async function prepareOcrAssets({
  directory = process.env.RESUME_LIFE_OCR_DATA_DIR || process.cwd(),
  fetchImpl = fetch,
  assets = OCR_ASSETS,
} = {}) {
  if (!path.isAbsolute(directory)) throw new Error("本地 OCR 语言包目录必须是绝对路径");
  fs.mkdirSync(directory, { recursive: true });
  const staged = [];
  for (const asset of assets) {
      const target = path.join(directory, `${asset.language}.traineddata`);
      if (isValidAsset(asset, target)) continue;
      const response = await fetchImpl(asset.url, {
        signal: AbortSignal.timeout(60_000),
        headers: { accept: "application/octet-stream" },
      });
      if (!response.ok) throw new Error(`OCR 语言包下载失败：${asset.language} HTTP ${response.status}`);
      staged.push({ asset, target, data: decodeAsset(asset, Buffer.from(await response.arrayBuffer())) });
  }
  for (const { target, data } of staged) {
      const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, data, { mode: 0o644 });
        fs.renameSync(temporary, target);
      } finally {
        if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
      }
  }
  console.log(`OCR 语言包已准备：${assets.map((asset) => asset.language).join(", ")} → ${directory}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  prepareOcrAssets().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
