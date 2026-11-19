// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { MODULE_KEYS, normalizeContent } from "@/lib/modules";
import { useResumeImportCreation } from "../use-resume-import-creation";
import { readResumeImportSession, RESUME_IMPORT_SESSION_KEY } from "@/lib/resume-import-session";
import { StrictMode, type PropsWithChildren } from "react";

vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.resetAllMocks(); });
const draft = () => ({ title: "  导入原稿  ", modules: Object.fromEntries(MODULE_KEYS.map(key => [key, normalizeContent(key,
  key === "work" ? [{ id: "w1", company: "合成公司", descriptionItems: ["尚未上线 Array<T> &amp;"] }] : undefined)])) });
function saved(input = draft()) {
  return { resume: { id: 42, title: input.title.trim() }, warnings: [], corruptedKeys: [],
    modules: MODULE_KEYS.filter(key => key !== "custom").map(key => ({ key, type: key, content: input.modules[key] })) };
}
const rows = [{ id: 9, title: "已有同名草稿 Array<T> &amp;", versions: [] }];
const posts = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST");
const receipt = () => ({ request_id: new Headers(posts().at(-1)?.[1]?.headers).get("Idempotency-Key"), status: "succeeded", id: 42 });

describe("确认导入的互斥与只读恢复", () => {
  describe.each(["posting", "receipt", "detail"] as const)("%s 等待期间的暂存归属", stage => {
    it.each(["foreign", "changed", "broken", "removed", "generation"])("暂存 %s 后旧响应和另建确认不能覆盖或清除当前数据", async mode => {
      const pending = Promise.withResolvers<unknown>(); const navigate = vi.fn();
      vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
        if (init?.method === "POST") return stage === "posting" ? pending.promise : { id: 42 };
        if (String(url).includes("/requests/")) return stage === "receipt" ? pending.promise : receipt();
        if (url === "/api/resumes") return rows;
        return stage === "detail" ? pending.promise : saved();
      });
      const { result } = renderHook(() => useResumeImportCreation(navigate));
      let done!: Promise<void>; act(() => { done = result.current.start(draft()); });
      await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(stage === "posting" ? 1 : stage === "receipt" ? 2 : 3));
      const value = JSON.parse(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)!);
      const completion = stage === "posting" ? { id: 42 } : stage === "receipt" ? receipt() : saved();
      if (mode === "foreign") value.pending.token = crypto.randomUUID();
      if (mode === "changed") value.editor.text += "后来补充的原文 <T> &amp;";
      if (mode === "generation") value.generation = "another-generation";
      if (mode === "removed") sessionStorage.removeItem(RESUME_IMPORT_SESSION_KEY);
      else sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, mode === "broken" ? "{后来损坏但必须保留的原文" : JSON.stringify(value));
      const raw = sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY);
      await act(async () => { pending.resolve(completion); await done; });
      expect(navigate).not.toHaveBeenCalled(); expect(result.current.phase).toBe("unknown");
      expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
      vi.mocked(confirmDialog).mockResolvedValue(true);
      await act(async () => { await result.current.allowRetry(); });
      expect(result.current.canStart()).toBe(false); expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
      expect(posts()).toHaveLength(1);
    });
  });

  it.each(["pending", "broken"])("%s 恢复的另建确认等待期间记录被替换，不能覆盖新暂存", async mode => {
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => init?.method === "POST" ? {} : rows);
    if (mode === "broken") sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, "{最初损坏原文");
    const { result } = renderHook(() => useResumeImportCreation(vi.fn()));
    if (mode === "pending") await act(async () => { await result.current.start(draft()); });
    else {
      await waitFor(() => expect(result.current.phase).toBe("unknown"));
      act(() => result.current.reread()); await waitFor(() => expect(result.current.recovery).toEqual(rows));
    }
    const confirmation = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise);
    let done!: Promise<void>; act(() => { done = result.current.allowRetry(); });
    const raw = "{确认期间换入的另一份原始记录";
    sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, raw);
    await act(async () => { confirmation.resolve(true); await done; });
    expect(result.current.canStart()).toBe(false); expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
  });

  it("普通草稿清除确认期间暂存改变，保留当前暂存和页面原稿", async () => {
    const confirmation = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise);
    const restore = vi.fn();
    const editor = { source: "paste" as const, text: "原稿", recoveredText: null, draft: null, manualDraft: false, ocrInfo: null };
    const { result } = renderHook(() => useResumeImportCreation(vi.fn(), { getEditor: () => editor, onRestore: restore }));
    act(() => result.current.saveEditor(editor));
    let done!: Promise<void>; act(() => { done = result.current.discard(); });
    const value = JSON.parse(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)!); value.editor.text = "确认期间的新稿";
    const raw = JSON.stringify(value); sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, raw);
    await act(async () => { confirmation.resolve(true); await done; });
    expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw); expect(restore).not.toHaveBeenCalled();
    expect(jsonFetch).not.toHaveBeenCalled();
  });

  it("初始化无法读取暂存时，后续人工另建不能覆盖未经核对的新记录", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("初始化读取被拒绝"); });
    const { result } = renderHook(() => useResumeImportCreation(vi.fn()));
    await waitFor(() => expect(result.current.phase).toBe("unknown")); get.mockRestore();
    const raw = "{后来出现的新原文"; sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, raw);
    vi.mocked(jsonFetch).mockResolvedValue(rows); act(() => result.current.reread());
    await waitFor(() => expect(result.current.recovery).toEqual(rows));
    vi.mocked(confirmDialog).mockResolvedValue(true);
    await act(async () => { await result.current.allowRetry(); });
    expect(result.current.canStart()).toBe(false); expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
    expect(result.current.error).toContain("请刷新页面"); expect(posts()).toHaveLength(0);
  });

  it("明确拒绝只能释放自己的暂存，等待期间换入的另一稿不能被覆盖", async () => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => init?.method === "POST" ? pending.promise : rows);
    const { result } = renderHook(() => useResumeImportCreation(vi.fn()));
    let done!: Promise<void>; act(() => { done = result.current.start(draft()); });
    const raw = "{新的原始记录"; sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, raw);
    await act(async () => { pending.reject(new HttpError("明确拒绝旧稿", 400)); await done; });
    expect(result.current.canStart()).toBe(false); expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
    expect(posts()).toHaveLength(1);
  });

  it("首次请求未到达服务端时可主动重试原命令；双击不并发，编号与正文快照不变", async () => {
    let writes = 0; const pending = Promise.withResolvers<unknown>(); const navigate = vi.fn();
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        if (++writes === 1) throw new Error("发送前连接中断");
        return pending.promise;
      }
      if (String(url).includes("/requests/")) {
        if (writes === 1) throw new HttpError("未找到", 404);
        return receipt();
      }
      return url === "/api/resumes" ? rows : saved();
    });
    const { result } = renderHook(() => useResumeImportCreation(navigate));
    await act(async () => { await result.current.start(draft()); });
    expect(result.current.retryAvailable).toBe(true);
    const snapshot = readResumeImportSession(); let done!: Promise<void>;
    act(() => { done = result.current.replay(); void result.current.replay(); result.current.reread(); void result.current.allowRetry(); });
    expect(posts()).toHaveLength(2); expect(confirmDialog).not.toHaveBeenCalled();
    expect(posts()[1]![1]!.body).toBe(posts()[0]![1]!.body);
    expect(new Headers(posts()[1]![1]!.headers).get("Idempotency-Key")).toBe(snapshot!.pending!.token);
    expect(readResumeImportSession()).toEqual(snapshot); expect(result.current.canStart()).toBe(false);
    await act(async () => { pending.resolve({ id: 42 }); await done; });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(42);
    expect(readResumeImportSession()).toBeNull();
  });

  it("原命令重试被拒也保留未知锁和编号，不能把原请求当成已撤销", async () => {
    let writes = 0;
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") throw ++writes === 1 ? new Error("响应中断") : new HttpError("合成拒绝", 400);
      if (String(url).includes("/requests/")) throw new HttpError("未找到", 404);
      return rows;
    });
    const { result } = renderHook(() => useResumeImportCreation(vi.fn()));
    await act(async () => { await result.current.start(draft()); });
    const before = readResumeImportSession();
    await act(async () => { await result.current.replay(); });
    expect(result.current.phase).toBe("unknown"); expect(result.current.locked).toBe(true);
    expect(readResumeImportSession()).toEqual(before); expect(posts()).toHaveLength(2);
  });

  it.each(["removed", "foreign", "changed", "broken", "unreadable", "generation"])("重试前暂存 %s 时不提交、不覆盖恢复数据", async mode => {
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") throw new Error("响应中断");
      if (String(url).includes("/requests/")) throw new HttpError("未找到", 404);
      return rows;
    });
    const { result } = renderHook(() => useResumeImportCreation(vi.fn()));
    await act(async () => { await result.current.start(draft()); });
    const raw = JSON.parse(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)!);
    if (mode === "removed") sessionStorage.removeItem(RESUME_IMPORT_SESSION_KEY);
    if (mode === "foreign") { raw.pending.token = crypto.randomUUID(); sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, JSON.stringify(raw)); }
    if (mode === "changed") { raw.editor.draft.title = raw.pending.snapshot.title = "另一稿"; sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, JSON.stringify(raw)); }
    if (mode === "broken") sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, "{原文保留");
    if (mode === "generation") { raw.generation = "another-generation"; sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, JSON.stringify(raw)); }
    const before = sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY);
    if (mode === "unreadable") vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("合成存储读取失败"); });
    const calls = vi.mocked(jsonFetch).mock.calls.length;
    await act(async () => { await result.current.replay(); });
    expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(calls);
    expect(result.current.error).toContain("本次未提交"); expect(result.current.phase).toBe("unknown");
    expect(result.current.locked).toBe(true);
    vi.restoreAllMocks(); expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(before);
  });

  it("重试等待期间卸载，迟到响应不能导航或清除原命令暂存", async () => {
    let writes = 0; const pending = Promise.withResolvers<unknown>(); const navigate = vi.fn();
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        if (++writes === 1) throw new Error("响应中断");
        return pending.promise;
      }
      if (String(url).includes("/requests/")) throw new HttpError("未找到", 404);
      return rows;
    });
    const { result, unmount } = renderHook(() => useResumeImportCreation(navigate));
    await act(async () => { await result.current.start(draft()); });
    let done!: Promise<void>; act(() => { done = result.current.replay(); });
    const before = readResumeImportSession(); const oldReplay = result.current.replay;
    const calls = vi.mocked(jsonFetch).mock.calls.length;
    const signal = posts()[1]![1]!.signal!;
    unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve({ id: 42 }); await done; await oldReplay(); });
    expect(navigate).not.toHaveBeenCalled(); expect(readResumeImportSession()).toEqual(before);
    expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(calls);
  });

  it("已确认回执但正文被改动时只能核对，不重试写入", async () => {
    const changed = saved(); changed.resume.title = "其他窗口已编辑";
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => init?.method === "POST" ? { id: 42 }
      : String(url).includes("/requests/") ? receipt() : url === "/api/resumes" ? rows : changed);
    const { result } = renderHook(() => useResumeImportCreation(vi.fn()));
    await act(async () => { await result.current.start(draft()); });
    expect(result.current.retryAvailable).toBe(false); expect(result.current.retrySupported).toBe(false);
    await act(async () => { await result.current.replay(); });
    expect(posts()).toHaveLength(1); expect(result.current.locked).toBe(true);
  });
  it("创建响应丢失后凭同编号回执找到存档，零重复提交；刷新沿用原编号", async () => {
    let available = false; const navigate = vi.fn();
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") throw new Error("响应丢失");
      if (String(url).includes("/requests/")) {
        if (!available) throw new HttpError("回执暂不可读", 503);
        return receipt();
      }
      return url === "/api/resumes" ? rows : saved();
    });
    const previous = renderHook(() => useResumeImportCreation(navigate));
    await act(async () => { await previous.result.current.start(draft()); });
    const token = readResumeImportSession()!.pending!.token;
    expect(new Headers(posts()[0]![1]!.headers).get("Idempotency-Key")).toBe(token);
    expect(readResumeImportSession()!.pending!.receipt).toBe(true);
    previous.unmount(); const calls = vi.mocked(jsonFetch).mock.calls.length;
    const current = renderHook(() => useResumeImportCreation(navigate));
    await waitFor(() => expect(current.result.current.phase).toBe("unknown"));
    expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(calls);
    available = true; act(() => current.result.current.reread());
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith(42));
    expect(posts()).toHaveLength(1);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([url]) => String(url).includes("/requests/")).map(([url]) => url)).toEqual([`/api/resumes/requests/${token}`, `/api/resumes/requests/${token}`]);
  });

  it.each(["foreign", "deleted", "invalid"])("%s 回执不认领创建响应中的 ID，仍保留草稿并人工核对", async mode => {
    const navigate = vi.fn();
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") return { id: 42 };
      if (String(url).includes("/requests/")) return mode === "foreign" ? { ...receipt(), request_id: crypto.randomUUID() }
        : mode === "deleted" ? { ...receipt(), status: "deleted" } : { ...receipt(), id: "42" };
      if (url === "/api/resumes") return rows;
      return saved();
    });
    const { result } = renderHook(() => useResumeImportCreation(navigate));
    await act(async () => { await result.current.start(draft()); });
    expect(result.current.phase).toBe("unknown"); expect(result.current.recovery).toEqual(rows);
    if (mode === "deleted") {
      expect(result.current.retryAvailable).toBe(false);
      await act(async () => { await result.current.replay(); });
    }
    expect(vi.mocked(jsonFetch).mock.calls.some(([url]) => url === "/api/resumes/42")).toBe(false);
    expect(navigate).not.toHaveBeenCalled(); expect(posts()).toHaveLength(1);
  });

  it("旧版本本地待核对稿没有服务端回执时仍可读取原 ID，不伪造归属", async () => {
    const { saveResumeImportSession } = await import("@/lib/resume-import-session");
    saveResumeImportSession({ editor: { source: "paste", text: "原稿", recoveredText: null, manualDraft: false, ocrInfo: null, draft: draft() }, pending: { token: crypto.randomUUID(), snapshot: { ...draft(), title: draft().title.trim() }, id: 42 } });
    vi.mocked(jsonFetch).mockResolvedValue(saved());
    const navigate = vi.fn(); const { result } = renderHook(() => useResumeImportCreation(navigate));
    await waitFor(() => expect(result.current.phase).toBe("unknown"));
    expect(result.current.retryAvailable).toBe(false);
    await act(async () => { await result.current.replay(); });
    expect(jsonFetch).not.toHaveBeenCalled();
    act(() => result.current.reread());
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith(42));
    expect(jsonFetch).toHaveBeenCalledExactlyOnceWith("/api/resumes/42", expect.anything());
  });
  it("清除暂存确认同步互斥，取消保留原稿，确认后只清本页暂存", async () => {
    const pending = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValue(pending.promise);
    const restore = vi.fn();
    const { result } = renderHook(() => useResumeImportCreation(vi.fn(), { getEditor: () => ({ source: "paste", text: "全文", recoveredText: null, draft: null, manualDraft: false, ocrInfo: null }), onRestore: restore }));
    act(() => result.current.saveEditor({ source: "paste", text: "全文", recoveredText: null, draft: null, manualDraft: false, ocrInfo: null }));
    let done!: Promise<void>;
    act(() => { done = result.current.discard(); void result.current.discard(); void result.current.start(draft()); });
    expect(confirmDialog).toHaveBeenCalledOnce(); expect(result.current.canStart()).toBe(false);
    await act(async () => { pending.resolve(false); await done; });
    expect(readResumeImportSession()?.editor.text).toBe("全文"); expect(restore).not.toHaveBeenCalled();
    vi.mocked(confirmDialog).mockResolvedValue(true);
    await act(async () => { await result.current.discard(); });
    expect(readResumeImportSession()).toBeNull(); expect(restore.mock.calls[0]![0].text).toBe("");
    expect(jsonFetch).not.toHaveBeenCalled();
  });
  it("创建前暂存失败则不提交，原稿仍可编辑", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("synthetic quota"); });
    const { result } = renderHook(() => useResumeImportCreation(vi.fn()));
    await act(async () => { await result.current.start(draft()); });
    expect(jsonFetch).not.toHaveBeenCalled(); expect(result.current.locked).toBe(false);
    expect(result.current.error).toContain("本次未提交");
  });

  it("明确允许另建但更新暂存失败时继续锁定，旧待核对快照不丢失", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => init?.method === "POST" ? {} : rows);
    vi.mocked(confirmDialog).mockResolvedValue(true);
    const { result } = renderHook(() => useResumeImportCreation(vi.fn()));
    await act(async () => { await result.current.start(draft()); });
    const before = readResumeImportSession();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("合成暂存错误"); });
    await act(async () => { await result.current.allowRetry(); });
    expect(result.current.locked).toBe(true); expect(readResumeImportSession()).toEqual(before);
    expect(result.current.error).toContain("尚未允许再次创建"); expect(posts()).toHaveLength(1);
  });

  it("一般编辑暂存失败保留页面权限并明确告知未保存，不改写旧快照", async () => {
    const { result } = renderHook(() => useResumeImportCreation(vi.fn()));
    const old = { source: "paste" as const, text: "旧原文", recoveredText: null, draft: null, manualDraft: false, ocrInfo: null };
    act(() => result.current.saveEditor(old));
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("合成配额不足"); });
    act(() => result.current.saveEditor({ ...old, text: "页面内最新原文" }));
    expect(result.current.canStart()).toBe(true); expect(readResumeImportSession()?.editor.text).toBe("旧原文");
    expect(result.current.storageError).toContain("刷新或离页可能丢失");
    write.mockRestore(); act(() => result.current.saveEditor({ ...old, text: "页面内最新原文" }));
    expect(result.current.storageError).toBe(""); expect(readResumeImportSession()?.editor.text).toBe("页面内最新原文");
  });

  it("恢复待核对 ID 仅主动读取，StrictMode 不丢原稿也不自动发请求", async () => {
    let detail = false;
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") return { id: 42 };
      if (String(url).includes("/requests/")) return receipt();
      if (url === "/api/resumes") return rows;
      if (!detail) throw new Error("存档暂不可读");
      return saved();
    });
    const previous = renderHook(() => useResumeImportCreation(vi.fn()));
    await act(async () => { await previous.result.current.start(draft()); });
    expect(readResumeImportSession()?.pending?.id).toBe(42);
    previous.unmount(); const calls = vi.mocked(jsonFetch).mock.calls.length;
    const restore = vi.fn(); const navigate = vi.fn();
    const current = renderHook(() => useResumeImportCreation(navigate, { getEditor: () => { throw new Error("不应重新取稿"); }, onRestore: restore }), {
      wrapper: ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>,
    });
    await waitFor(() => expect(current.result.current.phase).toBe("unknown"));
    expect(restore).toHaveBeenCalledOnce(); expect(restore.mock.calls[0]![0].draft).toEqual(draft());
    expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(calls);
    detail = true; act(() => current.result.current.reread());
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith(42));
    expect(posts()).toHaveLength(1); expect(readResumeImportSession()).toBeNull();
  });

  it("损坏存储原样保留，必须有效读取列表并确认才能清除", async () => {
    const raw = "{损坏的恢复信息 Array<T> &amp;";
    sessionStorage.setItem(RESUME_IMPORT_SESSION_KEY, raw);
    vi.mocked(jsonFetch).mockResolvedValue(rows);
    vi.mocked(confirmDialog).mockResolvedValue(false);
    const { result } = renderHook(() => useResumeImportCreation(vi.fn()));
    await waitFor(() => expect(result.current.phase).toBe("unknown"));
    expect(result.current.rawRecovery).toBe(raw); expect(result.current.canStart()).toBe(false);
    await act(async () => { await result.current.start(draft()); await result.current.allowRetry(); });
    expect(jsonFetch).not.toHaveBeenCalled(); expect(confirmDialog).not.toHaveBeenCalled();
    act(() => result.current.reread());
    await waitFor(() => expect(result.current.recovery).toEqual(rows));
    await act(async () => { await result.current.allowRetry(); });
    expect(sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY)).toBe(raw);
    vi.mocked(confirmDialog).mockResolvedValue(true);
    await act(async () => { await result.current.allowRetry(); });
    expect(result.current.canStart()).toBe(true); expect(readResumeImportSession()?.pending).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("已完成回读但清除恢复信息失败时不导航，修复存储后只读再核对", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => init?.method === "POST" ? { id: 42 } : String(url).includes("/requests/") ? receipt() : url === "/api/resumes" ? rows : saved());
    const clear = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("无法清理暂存"); });
    const navigate = vi.fn(); const { result } = renderHook(() => useResumeImportCreation(navigate));
    await act(async () => { await result.current.start(draft()); });
    expect(result.current.phase).toBe("unknown"); expect(navigate).not.toHaveBeenCalled();
    expect(readResumeImportSession()?.pending?.id).toBe(42);
    clear.mockRestore(); act(() => result.current.reread());
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith(42));
    expect(posts()).toHaveLength(1);
  });
  it("结果不明后重新挂载仍锁定创建，不自动重发或读取", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => init?.method === "POST" ? {} : rows);
    const previous = renderHook(() => useResumeImportCreation(vi.fn()));
    await act(async () => { await previous.result.current.start(draft()); });
    previous.unmount();
    const calls = vi.mocked(jsonFetch).mock.calls.length;
    const restored = renderHook(() => useResumeImportCreation(vi.fn()));
    await waitFor(() => expect(restored.result.current.phase).toBe("unknown"));
    expect(restored.result.current.canStart()).toBe(false);
    expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(calls);
    await act(async () => { await restored.result.current.start(draft()); });
    expect(posts()).toHaveLength(1);
  });
  it("同步双提交只创建一次；深拷贝原稿，保存回读一致后才导航", async () => {
    const pending = Promise.withResolvers<unknown>();
    const original = draft(); const expected = saved(original); const navigate = vi.fn();
    vi.mocked(jsonFetch).mockImplementation(async (url) => String(url).includes("/requests/") ? receipt() : url === "/api/resumes" ? pending.promise : expected);
    const { result } = renderHook(() => useResumeImportCreation(navigate));
    let done!: Promise<void>;
    act(() => { done = result.current.start(original); void result.current.start(original); });
    expect(posts()).toHaveLength(1);
    expect(result.current.canStart()).toBe(false);
    original.title = "被改动";
    expect(JSON.parse(posts()[0]![1]!.body as string).title).toBe("导入原稿");
    await act(async () => { pending.resolve({ id: 42 }); await done; });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(42);
    expect(vi.mocked(jsonFetch).mock.calls[1]![1]).toMatchObject({ cache: "no-store" });
    expect(result.current.phase).toBe("navigating");
    act(() => result.current.reread());
    expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(3);
  });

  it.each([null, {}, [], { id: 0 }, { id: -1 }, { id: 1.5 }, { id: "42" }, { id: Number.MAX_SAFE_INTEGER + 1 }])("坏创建响应 %j 不跳转，不凭列表认领同文记录", async (raw) => {
    const navigate = vi.fn();
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => init?.method === "POST" ? raw : rows);
    const { result } = renderHook(() => useResumeImportCreation(navigate));
    await act(async () => { await result.current.start(draft()); });
    expect(result.current.phase).toBe("unknown"); expect(result.current.recovery).toEqual(rows);
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { await result.current.start(draft()); });
    expect(posts()).toHaveLength(1);
  });

  it("存档回读串 ID 或正文均不导航；重新读取有效存档后只导航一次", async () => {
    const navigate = vi.fn(); let reads = 0;
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") return { id: 42 };
      if (String(url).includes("/requests/")) return receipt();
      if (url === "/api/resumes") return rows;
      const value = saved();
      if (reads++ === 0) value.resume.id = 9;
      else if (reads === 2) value.resume.title = "另一份草稿";
      return value;
    });
    const { result } = renderHook(() => useResumeImportCreation(navigate));
    await act(async () => { await result.current.start(draft()); });
    expect(result.current.phase).toBe("unknown"); expect(navigate).not.toHaveBeenCalled();
    act(() => result.current.reread());
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(result.current.phase).toBe("unknown"));
    expect(navigate).not.toHaveBeenCalled();
    act(() => result.current.reread());
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith(42));
    expect(posts()).toHaveLength(1);
  });

  it("核对开始作废旧列表，失败不能允许再建；确认、取消和重读同步互斥", async () => {
    const reading = Promise.withResolvers<unknown>(); const confirming = Promise.withResolvers<boolean>(); let reads = 0;
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") throw new Error("保存后连接中断");
      if (String(url).includes("/requests/")) return {};
      if (++reads === 2) return reading.promise;
      return rows;
    });
    vi.mocked(confirmDialog).mockReturnValue(confirming.promise);
    const { result } = renderHook(() => useResumeImportCreation(vi.fn()));
    await act(async () => { await result.current.start(draft()); });
    act(() => { result.current.reread(); result.current.reread(); void result.current.allowRetry(); });
    expect(result.current.recovery).toBeNull();
    await waitFor(() => expect(reads).toBe(2)); expect(confirmDialog).not.toHaveBeenCalled();
    await act(async () => { reading.reject(new Error("读取失败")); });
    await act(async () => { await result.current.allowRetry(); });
    expect(confirmDialog).not.toHaveBeenCalled(); expect(result.current.locked).toBe(true);
    act(() => result.current.reread());
    await waitFor(() => expect(result.current.recovery).toEqual(rows));
    let done!: Promise<void>;
    act(() => { done = result.current.allowRetry(); void result.current.allowRetry(); result.current.reread(); });
    expect(confirmDialog).toHaveBeenCalledOnce(); expect(reads).toBe(3);
    await act(async () => { confirming.resolve(false); await done; });
    expect(result.current.locked).toBe(true);
    vi.mocked(confirmDialog).mockResolvedValue(true);
    await act(async () => { await result.current.allowRetry(); });
    expect(result.current.locked).toBe(false); expect(posts()).toHaveLength(1);
  });

  it.each([null, {}, [{ ...rows[0], id: 0.5 }], [rows[0], rows[0]], [{ ...rows[0], versions: null }]])("坏列表 %j 不解锁另建资格", async (value) => {
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => init?.method === "POST" ? {} : value);
    const { result } = renderHook(() => useResumeImportCreation(vi.fn()));
    await act(async () => { await result.current.start(draft()); await result.current.allowRetry(); });
    expect(result.current.recovery).toBeNull(); expect(result.current.locked).toBe(true); expect(confirmDialog).not.toHaveBeenCalled();
  });

  it.each([400, 403, 408, 409, 500])("HTTP %i 只在明确拒绝时解锁，未知结果只读恢复", async (status) => {
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => {
      if (init?.method === "POST") throw new HttpError("合成错误", status);
      return rows;
    });
    const { result } = renderHook(() => useResumeImportCreation(vi.fn()));
    await act(async () => { await result.current.start(draft()); });
    expect(result.current.locked).toBe(![400, 403].includes(status));
    expect(posts()).toHaveLength(1);
  });

  it("离页取消核对请求，迟到列表不能解锁旧命令或导航", async () => {
    const pending = Promise.withResolvers<unknown>(); const navigate = vi.fn();
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => init?.method === "POST" ? {} : pending.promise);
    const { result, unmount } = renderHook(() => useResumeImportCreation(navigate));
    let done!: Promise<void>;
    act(() => { done = result.current.start(draft()); });
    await waitFor(() => expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(2));
    const reread = result.current.reread; const start = result.current.start;
    const signal = vi.mocked(jsonFetch).mock.calls[1]![1]!.signal!;
    unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(rows); await done; reread(); await start(draft()); });
    expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(2); expect(navigate).not.toHaveBeenCalled();
  });

  it("离页后的迟到再次创建确认不能发起新写入或解锁旧命令", async () => {
    const confirmation = Promise.withResolvers<boolean>();
    vi.mocked(confirmDialog).mockReturnValue(confirmation.promise);
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => init?.method === "POST" ? {} : rows);
    const { result, unmount } = renderHook(() => useResumeImportCreation(vi.fn()));
    await act(async () => { await result.current.start(draft()); });
    let done!: Promise<void>; const oldStart = result.current.start;
    act(() => { done = result.current.allowRetry(); });
    unmount();
    await act(async () => { confirmation.resolve(true); await done; await oldStart(draft()); });
    expect(posts()).toHaveLength(1);
  });
});
