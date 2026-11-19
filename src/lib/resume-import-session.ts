import { RESUME_IMPORT_SESSION_KEY } from "./browser-draft-keys";
import { documentDataGeneration } from "./api-fetch";
import { INITIAL_DATA_GENERATION } from "./data-generation-contract";
import { readImportedResumeDraft, readImportedResumeOcr, type ImportedResumeDraft, type ImportedResumeOcr } from "./resume-import-response";
import { readResumeImportSourceReceipt, type ResumeImportSourceReceipt } from "./resume-import-source-contract";

export { RESUME_IMPORT_SESSION_KEY };
export type ResumeImportEditorState = {
  source: "paste" | "file";
  text: string;
  recoveredText: string | null;
  sourceReceipt?: ResumeImportSourceReceipt | null;
  sourceIssue?: "expired" | "mismatch" | "unavailable" | null;
  ocrInfo: ImportedResumeOcr | null;
  manualDraft: boolean;
  draft: ImportedResumeDraft | null;
};
export type PendingResumeImport = { token: string; snapshot: ImportedResumeDraft; id?: number; receipt?: true };
export type ResumeImportSession = { editor: ResumeImportEditorState; pending: PendingResumeImport | null };
const generation = () => documentDataGeneration() ?? INITIAL_DATA_GENERATION;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const positiveId = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function emptyResumeImportEditor(): ResumeImportEditorState {
  return { source: "paste", text: "", recoveredText: null, ocrInfo: null, manualDraft: false, draft: null };
}

/** 编辑中允许空白标题，恢复时不替换用户字面量；模块仍按导入编辑器协议完整验证。 */
function validDraft(value: unknown): value is ImportedResumeDraft {
  return record(value) && typeof value.title === "string" && Boolean(readImportedResumeDraft({ ...value, title: value.title.trim() || "导入的简历" }));
}
function validEditor(value: unknown): value is ResumeImportEditorState {
  return record(value) && ["paste", "file"].includes(value.source as string) && typeof value.text === "string" &&
    (value.recoveredText === null || typeof value.recoveredText === "string") && typeof value.manualDraft === "boolean" &&
    (value.ocrInfo === null || Boolean(readImportedResumeOcr(value.ocrInfo))) && (value.draft === null || validDraft(value.draft)) &&
    (value.sourceReceipt == null || (typeof value.recoveredText === "string" && Boolean(readResumeImportSourceReceipt(value.sourceReceipt)))) &&
    (value.sourceIssue == null || (typeof value.recoveredText === "string" && ["expired", "mismatch", "unavailable"].includes(value.sourceIssue as string)));
}

/** Display only. CAS must always retain the original stored bytes, including corrupt JSON. */
export function redactResumeImportRecovery(raw: string): string {
  let display = raw;
  try {
    display = JSON.stringify(JSON.parse(raw), (key, value) =>
      /sourceReceipt|tokenHash|textSha256|sessionHash|receiptHash/i.test(key) ? "[已隐藏来源信息]" : value, 2);
  } catch { /* A corrupt document remains copyable, with identifier-like text redacted below. */ }
  // Receipts are 43 base64url characters; include hashes and longer malformed values
  // because this view is specifically used when the recovery document cannot parse.
  return display.replace(/[A-Za-z0-9_-]{43,}/g, "[已隐藏来源编号]");
}

/** 仅当前标签页暂存；恢复世代变化后不把旧原稿/在途创建带入新数据库。坏数据保留供复制核对。 */
function parseResumeImportSession(raw: string | null, discardStale: boolean): ResumeImportSession | null {
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("导入恢复信息损坏"); }
  if (!record(value) || value.version !== 1 || typeof value.generation !== "string") throw new Error("导入恢复信息损坏");
  if (value.generation !== generation()) {
    if (!discardStale) throw new Error("导入恢复记录已改变，请刷新页面重新核对");
    sessionStorage.removeItem(RESUME_IMPORT_SESSION_KEY); return null;
  }
  if (!validEditor(value.editor)) throw new Error("导入原文或编辑稿恢复信息不完整");
  const pending = value.pending;
  if (pending !== null && (!record(pending) || typeof pending.token !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pending.token) ||
    !validDraft(pending.snapshot) || !pending.snapshot.title.trim() ||
    (pending.receipt !== undefined && pending.receipt !== true) ||
    (pending.id !== undefined && !positiveId(pending.id)) || value.editor.draft === null ||
    pending.snapshot.title !== (value.editor.draft.title.trim() || "导入的简历") ||
    JSON.stringify(pending.snapshot.modules) !== JSON.stringify(value.editor.draft.modules))) throw new Error("导入创建恢复信息不完整");
  return { editor: value.editor, pending: pending as PendingResumeImport | null };
}
export function readResumeImportSession(raw: string | null = sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)): ResumeImportSession | null {
  return parseResumeImportSession(raw, true);
}
export function saveResumeImportSession(value: ResumeImportSession): string {
  const raw = JSON.stringify({ version: 1, generation: generation(), ...value });
  sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, raw);
  return raw;
}
export function assertResumeImportSessionUnchanged(expectedRaw: string | null): void {
  if (sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY) !== expectedRaw) throw new Error("导入恢复记录已改变，请刷新页面重新核对");
}
/** 创建命令只更新或清除自己最后一次成功写入/恢复的完整原始记录。 */
export function replaceResumeImportSession(expectedRaw: string | null, value: ResumeImportSession | null): string | null {
  assertResumeImportSessionUnchanged(expectedRaw);
  if (value === null) { sessionStorage.removeItem(RESUME_IMPORT_SESSION_KEY); return null; }
  return saveResumeImportSession(value);
}
export function discardResumeImportDraft(expectedRaw: string | null): void {
  assertResumeImportSessionUnchanged(expectedRaw);
  if (parseResumeImportSession(expectedRaw, false)?.pending) throw new Error("仍有待核对的导入创建，不能直接清除");
  replaceResumeImportSession(expectedRaw, null);
}
