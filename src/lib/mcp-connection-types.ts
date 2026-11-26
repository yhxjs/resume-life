export type McpConnectionPreset = "readonly" | "preparation" | "collaboration" | "training" | "authoring";
export type McpConnectionFormat = "json" | "codex";
export type McpConnectionCheck = { id: string; label: string; state: "pass" | "warning" | "error"; detail: string; repair: string };
export type McpConnectionConfig = {
  preset: McpConnectionPreset; format: McpConnectionFormat; text: string; toolCount: number;
  writeEnabled: boolean; firstCallAvailable: boolean;
};
export type McpConnectionReport = {
  node: string; nodePath: string; projectRoot: string; dataDirectory: string; repositoryRoots: string[];
  presets: { name: McpConnectionPreset; label: string; description: string }[];
  checks: McpConnectionCheck[]; canGenerate: boolean;
  // Summary only: this is Web's current database state, never proof of a Host handshake.
  status: { databaseVersion: number; workspaceBinding?: string; operationLogCount: number; drafts: { total: number; available: number; expired: number }; generationRequests: { pending: number; interrupted: number; succeeded: number; failed: number };
    jobs?: { running: number; waiting: number; interrupted: number; succeeded: number; failed: number; cancelled: number; invalidated: number };
    leases?: { resource: "render" | "capture" | "parse"; active: number }[];
    cache?: { totalBytes: number; maxBytes: number; ttlHours: number };
  } | null;
};
