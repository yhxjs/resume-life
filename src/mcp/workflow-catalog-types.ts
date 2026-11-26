import type { toolAccess } from "./config.mjs";
export type Tool = keyof typeof toolAccess;
export type Step = { tool: Tool; purpose: string; inputs: Record<string, unknown>; output: string };
export type Workflow = { id: string; title: string; prerequisites: string[]; dependencies: Tool[]; steps: Step[] };
export const step = (tool: Tool, purpose: string, inputs: Record<string, unknown>, output: string): Step => ({ tool, purpose, inputs, output });
