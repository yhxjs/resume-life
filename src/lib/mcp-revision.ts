import { createHash } from "node:crypto";
import { dataGeneration } from "@/lib/db";

/** 对完整领域记录计算，不能使用摘要；同毫秒修改与恢复同内容均使旧令牌失效。 */
export function mcpRevision(kind: "application" | "preparation-plan" | "ai-source" | "interview-questions", value: object): string {
  return createHash("sha256").update(JSON.stringify([kind, dataGeneration(), value])).digest("hex");
}
