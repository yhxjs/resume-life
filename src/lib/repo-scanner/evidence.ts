import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { ScanEvidenceFile } from "../evidence-challenge";
import type { RepoTarget } from "./prompts";
import { dataGeneration } from "../db";

// Short-lived, process-local scan receipts: never reread a client-supplied host path.
const keySlot = Symbol.for("resume-life.scan-evidence-key");
const runtime = globalThis as typeof globalThis & { [keySlot]?: Buffer };
const key = runtime[keySlot] ??= randomBytes(32);
const signature = (file: Omit<ScanEvidenceFile, "receipt">, projectId: number) => createHmac("sha256", key)
  .update(JSON.stringify([dataGeneration(), projectId, file.locator, file.content, file.truncated, file.capturedAt])).digest("hex");

export function captureScanEvidence(source: string, targets: RepoTarget[], projectId: number): ScanEvidenceFile[] {
  const capturedAt = new Date().toISOString();
  return source.split("\n").filter(Boolean).flatMap(line => {
    // Only the collector's top-level JSONL records are source files.
    let record;
    try { record = JSON.parse(line); } catch { return []; }
    if (!record || record.kind !== "file" || typeof record.path !== "string" || typeof record.content !== "string"
      || !Number.isSafeInteger(record.repoNumber) || !targets[record.repoNumber - 1]) return [];
    const file = {
      locator: `仓库${record.repoNumber} ${path.basename(targets[record.repoNumber - 1]!.path)} / ${record.path}`,
      content: record.content, truncated: record.truncated === true, capturedAt,
    };
    return [{ ...file, receipt: signature(file, projectId) }];
  });
}

export function verifyScanEvidence(value: unknown, projectId: number): ScanEvidenceFile {
  const fail = () => { throw new Error("扫描依据已失效或被修改，请重新扫描后选择"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const file = value as ScanEvidenceFile;
  if (typeof file.locator !== "string" || file.locator.length > 1000 || typeof file.content !== "string"
    || file.content.length > 180_000 || typeof file.truncated !== "boolean" || typeof file.capturedAt !== "string"
    || typeof file.receipt !== "string" || !/^[a-f0-9]{64}$/.test(file.receipt)) return fail();
  const age = Date.now() - Date.parse(file.capturedAt);
  if (!Number.isFinite(age) || age < 0 || age > 60 * 60 * 1000
    || !timingSafeEqual(Buffer.from(file.receipt, "hex"), Buffer.from(signature(file, projectId), "hex"))) return fail();
  return file;
}
