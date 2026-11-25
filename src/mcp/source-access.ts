import type { toolAccess } from "./config.mjs";
import type { McpTools } from "./tools";
import { McpOperationError } from "@/lib/mcp-errors";

export function requireReads(tools: McpTools, ...names: (keyof typeof toolAccess)[]) {
  if (!tools.permits(...names)) throw new McpOperationError("FORBIDDEN", "对应来源读取工具未获授权");
}
export function gradeAccess(tools: McpTools) {
  requireReads(tools, "get_practice_question", "list_practice_sessions");
  return (source: string, includesProject: boolean) => {
    if (includesProject) requireReads(tools, "get_project", "list_project_materials");
    if (source === "interview") requireReads(tools, "get_interview");
  };
}
