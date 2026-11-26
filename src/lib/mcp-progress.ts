import { AsyncLocalStorage } from "node:async_hooks";

export type McpProgress = { phase: "starting" | "waiting_resource" | "reading" | "parsing" | "rendering" | "packaging" | "committing" | "succeeded";
  completed: number; total: number | null; unit: "steps" | "files" | "bytes" | "pages" };
const scope = new AsyncLocalStorage<(progress: McpProgress) => void>();
export function withMcpProgress<T>(report: (progress: McpProgress) => void, run: () => T): T { return scope.run(report, run); }
export function hasMcpProgressReporter() { return !!scope.getStore(); }
export function reportMcpProgress(phase: McpProgress["phase"], completed = 0, total: number | null = null, unit: McpProgress["unit"] = "steps") {
  scope.getStore()?.({ phase, completed, total, unit });
}
