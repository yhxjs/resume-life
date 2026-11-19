// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS, normalizeContent } from "../modules";
import { discardResumeImportDraft, emptyResumeImportEditor, readResumeImportSession, redactResumeImportRecovery, replaceResumeImportSession, RESUME_IMPORT_SESSION_KEY, saveResumeImportSession, type ResumeImportSession } from "../resume-import-session";
const state = vi.hoisted(() => ({ generation: "first" }));
vi.mock("../api-fetch", () => ({ documentDataGeneration: () => state.generation }));
afterEach(() => { sessionStorage.clear(); state.generation = "first"; vi.restoreAllMocks(); });
function fixture(): ResumeImportSession {
  const text = String.raw`完整原文 Array<T> &amp; C:\new\resume
尚未上线，收益未统计。`;
  const modules = Object.fromEntries(MODULE_KEYS.map(key => [key, normalizeContent(key, key === "summary" ? { text } : undefined)]));
  return { editor: { ...emptyResumeImportEditor(), source: "file", text: "旧粘贴稿", recoveredText: text, ocrInfo: { engine: "vision", pageCount: 2, sourceType: "pdf" },
    manualDraft: false, draft: { title: "  修改后的标题  ", modules } },
    pending: { token: crypto.randomUUID(), snapshot: { title: "修改后的标题", modules }, id: 42, receipt: true } };
}

describe("当前标签页的简历导入恢复协议", () => {
  it("来源回执与完整原文、过期选择和原pending成组恢复，不进入创建草稿", () => {
    const value = fixture();
    value.editor.sourceReceipt = { version: 1, id: "a".repeat(43), expiresAt: 1 };
    value.editor.sourceIssue = "expired";
    const raw = saveResumeImportSession(value);
    expect(readResumeImportSession()).toEqual(value);
    expect(JSON.stringify(value.pending!.snapshot)).not.toContain("sourceReceipt");
    expect(redactResumeImportRecovery(raw)).not.toContain(value.editor.sourceReceipt.id);
    expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
    replaceResumeImportSession(raw, null);
    expect(readResumeImportSession()).toBeNull();
  });
  it.each(["missing-text", "bad-receipt", "extra-field", "bad-issue"])("来源恢复 %s 拒绝损坏记录，不能静默降级", mode => {
    const value = fixture();
    value.editor.sourceReceipt = { version: 1, id: "a".repeat(43), expiresAt: 1 };
    const broken = value.editor as unknown as Record<string, unknown>;
    if (mode === "missing-text") broken.recoveredText = null;
    if (mode === "bad-receipt") broken.sourceReceipt = { version: 1, id: "bad", expiresAt: 1 };
    if (mode === "extra-field") broken.sourceReceipt = { ...value.editor.sourceReceipt, metadata: {} };
    if (mode === "bad-issue") broken.sourceIssue = "unknown";
    const raw = saveResumeImportSession(value);
    expect(() => readResumeImportSession()).toThrow("恢复信息不完整");
    expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
  });
  it("损坏JSON的裸编号及hash脱敏而字面正文仍可复制，展示值不改变原CAS", () => {
    const raw = '{broken sourceReceipt:' + "A".repeat(43) + ' hash:' + "f".repeat(64) + ' 原文 Array<T> &amp;';
    const shown = redactResumeImportRecovery(raw);
    expect(shown).not.toContain("A".repeat(43)); expect(shown).not.toContain("f".repeat(64));
    expect(shown).toContain('原文 Array<T> &amp;');
    sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, raw);
    expect(() => replaceResumeImportSession(shown, null)).toThrow("已改变");
    expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
  });
  it("原文、富文本、空白和待核对 ID 完整恢复，不再次转义或生成经历 ID", () => {
    const value = fixture(); const before = JSON.stringify(value);
    saveResumeImportSession(value);
    expect(readResumeImportSession()).toEqual(value);
    expect(JSON.stringify(value)).toBe(before);
  });
  it("空白标题、主动清空的原文与未解析来源可恢复，不能补回旧文本", () => {
    const value = fixture(); value.pending = null;
    value.editor.draft!.title = "  "; value.editor.recoveredText = "";
    saveResumeImportSession(value); expect(readResumeImportSession()).toEqual(value);
    value.editor.draft = null; value.editor.recoveredText = null;
    saveResumeImportSession(value); expect(readResumeImportSession()).toEqual(value);
  });
  it("恢复世代改变后丢弃旧暂存，不能核对新库中的复用 ID", () => {
    saveResumeImportSession(fixture()); state.generation = "restored";
    expect(readResumeImportSession()).toBeNull();
    expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBeNull();
  });
  it("完成回调只能清理自己的待核对记录，不能删除新草稿或另一命令", () => {
    const value = fixture(); const raw = saveResumeImportSession(value);
    expect(() => replaceResumeImportSession("另一份记录", null)).toThrow("已改变");
    expect(readResumeImportSession()).toEqual(value);
    replaceResumeImportSession(raw, null); expect(readResumeImportSession()).toBeNull();
    value.pending = null; saveResumeImportSession(value);
    expect(() => replaceResumeImportSession(raw, null)).toThrow("已改变");
    expect(readResumeImportSession()).toEqual(value);
  });
  it("未知创建不能直接清除，只有普通编辑稿可以主动丢弃", () => {
    const value = fixture(); const raw = saveResumeImportSession(value);
    expect(() => discardResumeImportDraft(raw)).toThrow("仍有待核对");
    expect(readResumeImportSession()).toEqual(value);
    value.pending = null; const edited = saveResumeImportSession(value); discardResumeImportDraft(edited);
    expect(readResumeImportSession()).toBeNull();
  });
  it("更新回执后返回新的完整记录，后续只接受最后成功写入的原文", () => {
    const value = fixture(); delete value.pending!.id;
    const raw = saveResumeImportSession(value);
    const next = structuredClone(value); next.pending!.id = 42;
    const updated = replaceResumeImportSession(raw, next);
    expect(updated).toBe(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)); expect(updated).not.toBe(raw);
    expect(() => replaceResumeImportSession(raw, null)).toThrow("已改变");
    expect(readResumeImportSession()).toEqual(next);
    replaceResumeImportSession(updated, null); expect(readResumeImportSession()).toBeNull();
  });
  it("写入或移除失败不推进原记录，存储恢复后仍能按原文继续", () => {
    const value = fixture(); const raw = saveResumeImportSession(value);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("更新失败"); });
    expect(() => replaceResumeImportSession(raw, { editor: value.editor, pending: null })).toThrow("更新失败");
    write.mockRestore(); expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("清理失败"); });
    expect(() => replaceResumeImportSession(raw, null)).toThrow("清理失败"); remove.mockRestore();
    expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
    replaceResumeImportSession(raw, null); expect(readResumeImportSession()).toBeNull();
  });
  it("主动丢弃不能删除另一世代记录，不借恢复读取顺带清除", () => {
    const value = fixture(); value.pending = null; const raw = saveResumeImportSession(value);
    state.generation = "restored";
    expect(() => discardResumeImportDraft(raw)).toThrow("已改变");
    expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
  });
  it.each(["not-json", "null", "[]", "{}", '{"version":2,"generation":"first"}'])("坏存储 %j 不删除或默认解锁", raw => {
    sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, raw);
    expect(() => readResumeImportSession()).toThrow("导入恢复信息损坏");
    expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
  });
  it.each(["source", "text", "recovered", "ocr", "draft", "modules", "pending", "id", "token", "receipt", "title", "snapshot", "missing"])("拒绝 %s 损坏字段并保留原始 JSON", mode => {
    const value = fixture();
    const broken = value as unknown as { editor: Record<string, unknown>; pending?: Record<string, unknown> };
    if (mode === "source") broken.editor.source = "other";
    if (mode === "text") broken.editor.text = 42;
    if (mode === "recovered") broken.editor.recoveredText = [];
    if (mode === "ocr") broken.editor.ocrInfo = { engine: "vision", pageCount: 0 };
    if (mode === "draft") broken.editor.draft = null;
    if (mode === "modules") value.editor.draft!.modules = { basic: {} };
    if (mode === "pending") broken.pending = {};
    if (mode === "id") broken.pending!.id = "42";
    if (mode === "token") broken.pending!.token = "bad";
    if (mode === "receipt") broken.pending!.receipt = "true";
    if (mode === "title") value.pending!.snapshot.title = "另一标题";
    if (mode === "snapshot") value.pending!.snapshot = { ...value.pending!.snapshot, modules: { ...value.pending!.snapshot.modules, skills: { items: ["来自另一稿"] } } };
    if (mode === "missing") delete broken.pending;
    saveResumeImportSession(value); const raw = sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY);
    expect(() => readResumeImportSession()).toThrow();
    expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
  });
  it("存储失败向调用方报错，不伪装成暂存成功", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("synthetic quota"); });
    expect(() => saveResumeImportSession(fixture())).toThrow("synthetic quota");
    expect(readResumeImportSession()).toBeNull();
  });
});
