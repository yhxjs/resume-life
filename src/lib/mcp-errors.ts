/** Stable machine codes for MCP clients; messages contain no model/provider payloads. */
export const MCP_ERROR_CODES = ["INVALID_ARGUMENT", "NOT_FOUND", "CONFLICT", "FORBIDDEN", "CONFIGURATION", "BUSY", "CANCELLED", "TIMEOUT", "MODEL_OUTPUT", "INTERNAL"] as const;
export type McpErrorCode = typeof MCP_ERROR_CODES[number];

export class McpOperationError extends Error {
  constructor(public code: McpErrorCode, message: string) { super(message); }
}
