export const isResumeCreationRequestId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export type ResumeCreationReceipt = { status: "succeeded"; id: number } | { status: "deleted" };
export function readResumeCreationReceipt(value: unknown, requestId: string): ResumeCreationReceipt {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (row.request_id === requestId) {
      if (row.status === "deleted") return { status: "deleted" };
      if (row.status === "succeeded" && typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id > 0) return { status: "succeeded", id: row.id };
    }
  }
  throw new Error("创建回执无效，请重新核对导入结果");
}
