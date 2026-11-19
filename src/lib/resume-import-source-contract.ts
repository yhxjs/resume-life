/** Small browser recovery reference. The source metadata stays on the server. */
export type ResumeImportSourceReceipt = { version: 1; id: string; expiresAt: number };

export function isResumeImportSourceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function readResumeImportSourceReceipt(value: unknown): ResumeImportSourceReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).length !== 3 || receipt.version !== 1 || !isResumeImportSourceId(receipt.id)
      || typeof receipt.expiresAt !== "number" || !Number.isSafeInteger(receipt.expiresAt)
      || receipt.expiresAt <= 0 || receipt.expiresAt > 8_640_000_000_000_000) return null;
  // Do not discard expired references on recovery: the user must explicitly choose
  // whether to upload again or continue as ordinary text.
  return { version: 1, id: receipt.id, expiresAt: receipt.expiresAt };
}
