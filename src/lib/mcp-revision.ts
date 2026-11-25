import { createHash } from "node:crypto";
import { dataGeneration } from "@/lib/db";

/** 对完整领域记录计算，不能使用摘要；同毫秒修改与恢复同内容均使旧令牌失效。 */
export function mcpRevision(kind: "application" | "preparation-plan" | "preparation-resources" | "ai-source" | "interview-questions" | "notebook-note"
  | "drill-grade" | "bank-entry" | "intro-preview" | "project-target" | "mock-resume" | "mock-session" | "content-context" | "content-preview", value: object): string {
  return createHash("sha256").update(JSON.stringify([kind, dataGeneration(), value])).digest("hex");
}

/** JSON objects are unordered in submissions; arrays retain their order. */
export function canonicalMcpJson(input: object): string {
  return JSON.stringify(input, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
}

export function mockResumeRevision(resumeId: number, versionId: number | null, context: string) {
  return mcpRevision("mock-resume", [resumeId, versionId, context]);
}
