// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySummary } from "@/lib/summary";
import { useProjectDetail } from "../use-project-detail";

const calls = vi.hoisted(() => ({ json: vi.fn(), api: vi.fn(), confirm: vi.fn() }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<object>(), jsonFetch: calls.json }));
vi.mock("@/lib/api-fetch", () => ({ apiFetch: calls.api }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: calls.confirm, alertDialog: vi.fn() }));
const material = { id: 11, title: "本次材料", source: "paste", filename: "", content_length: 10, created_at: "2026-11-03" };
const project = { id: 1, name: "导入核对", summary: emptySummary(), summary_updated_at: "", materials: [material], materials_total: 1, materials_next_cursor: null };
beforeEach(() => {
  calls.json.mockReset().mockResolvedValue(project);
  calls.api.mockReset().mockResolvedValue(Response.json({ id: 12, title: "本次材料", source: "paste", filename: "" }, { status: 201 }));
  calls.confirm.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);
async function setup() {
  const hook = renderHook(() => useProjectDetail("1"));
  await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
  act(() => { hook.result.current.material.setMatTitle("本次材料"); hook.result.current.material.setMatContent("原稿 <T> &amp;  "); });
  return hook;
}

describe("材料导入未知结果与显式核对", () => {
  it.each([{}, null, { id: 0 }, { id: 12, title: "另一份", source: "paste", filename: "" },
    { id: 12, title: "本次材料", source: "file", filename: "" }])("坏确认 %j 保留原稿并只读核对", async body => {
    const hook = await setup();
    calls.api.mockResolvedValueOnce(Response.json(body, { status: 201 }));
    await act(async () => { await hook.result.current.material.addPaste(); });
    expect(hook.result.current.material.matContent).toBe("原稿 <T> &amp;  ");
    expect(hook.result.current.material.importRecovery?.phase).toBe("unknown");
    expect(hook.result.current.material.importLocked).toBe(true);
    expect(calls.json).toHaveBeenLastCalledWith("/api/projects/1?limit=50", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
    await act(async () => { await hook.result.current.material.addPaste(); await hook.result.current.material.addFile(); });
    expect(calls.api).toHaveBeenCalledOnce();
  });

  it.each([408, 500, 503])("HTTP %s 读取失败时锁住两种导入，读成功也不能自动认领旧同文材料", async status => {
    const hook = await setup();
    calls.api.mockResolvedValueOnce(Response.json({ error: "导入等待中断" }, { status }));
    calls.json.mockRejectedValueOnce(new Error("读取中断"));
    await act(async () => { await hook.result.current.material.addPaste(); });
    expect(hook.result.current.material.importRecovery?.message).toContain("读取中断");
    expect(hook.result.current.material.importRecovery?.page).toBeNull();
    await act(async () => { await hook.result.current.material.allowImportRetry(); });
    expect(calls.confirm).not.toHaveBeenCalled();
    await act(async () => { await hook.result.current.material.rereadImport(); });
    expect(hook.result.current.material.importRecovery?.page?.materials).toEqual([material]);
    expect(hook.result.current.material.importRecovery?.message).toContain("不能确认本次导入");
    expect(hook.result.current.material.matContent).toBe("原稿 <T> &amp;  ");
    expect(calls.api).toHaveBeenCalledOnce();
  });

  it("成功确认必须匹配粘贴标题或自动标题，保留原文并清空已提交输入", async () => {
    const hook = await setup();
    await act(async () => { await hook.result.current.material.addPaste(); });
    expect(hook.result.current.material.matContent).toBe("");
    expect(hook.result.current.material.importRecovery).toBeNull();
    act(() => { hook.result.current.material.setMatTitle("  "); hook.result.current.material.setMatContent("  自动标题 <T> &amp;  "); });
    calls.api.mockResolvedValueOnce(Response.json({ id: 13, title: "自动标题 <T> &amp;", source: "paste", filename: "" }, { status: 201 }));
    await act(async () => { await hook.result.current.material.addPaste(); });
    expect(JSON.parse(calls.api.mock.calls[1]![1].body).content).toBe("  自动标题 <T> &amp;  ");
    expect(hook.result.current.material.matContent).toBe("");
  });

  it.each(["paste", "file"])("%s 保留的提交回调使用最新输入，完成后不能重发已清空的旧稿", async kind => {
    const hook = await setup();
    const retained = hook.result.current.material;
    calls.api.mockResolvedValueOnce(Response.json({ id: 12, title: kind === "paste" ? "即时新标题" : "即时文件.txt", source: kind, filename: kind === "paste" ? "" : "即时文件.txt" }, { status: 201 }));
    await act(async () => {
      retained.setMatTitle("即时新标题"); retained.setMatContent("即时新正文"); retained.setFile(new File(["即时新正文"], "即时文件.txt"));
      if (kind === "paste") await retained.addPaste(); else await retained.addFile();
    });
    expect(hook.result.current.material.importLocked).toBe(false);
    if (kind === "paste") expect(JSON.parse(calls.api.mock.calls[0]![1].body)).toEqual({ title: "即时新标题", content: "即时新正文" });
    else expect((calls.api.mock.calls[0]![1].body as FormData).get("file")).toBeInstanceOf(File);
    await act(async () => { if (kind === "paste") await retained.addPaste(); else await retained.addFile(); });
    expect(calls.api).toHaveBeenCalledOnce();
  });

  it.each([400, 403, 413, 429])("明确 HTTP %s 即使错误正文不可读仍保留输入且解除锁定", async status => {
    const hook = await setup();
    calls.api.mockResolvedValueOnce(new Response("bad gateway body", { status }));
    await act(async () => { await hook.result.current.material.addPaste(); });
    expect(hook.result.current.error).toBe(`HTTP ${status}`);
    expect(hook.result.current.material.importLocked).toBe(false);
    expect(hook.result.current.material.matContent).toBe("原稿 <T> &amp;  ");
    expect(calls.json).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...project, id: 2 },
    { ...project, materials_total: undefined },
    { ...project, materials: [{ ...material, content_length: "10" }] },
    { ...project, materials_next_cursor: "other" },
    { ...project, materials: [material, material], materials_total: 2 },
  ])("无效或串项目列表不能获得解除锁定资格 %#", async value => {
    const hook = await setup();
    calls.api.mockRejectedValueOnce(new Error("连接中断"));
    calls.json.mockResolvedValueOnce(value);
    await act(async () => { await hook.result.current.material.addPaste(); await hook.result.current.material.allowImportRetry(); });
    expect(hook.result.current.material.importRecovery?.page).toBeNull();
    expect(hook.result.current.material.importRecovery?.message).toContain("不完整或不属于当前项目");
    expect(hook.result.current.material.importLocked).toBe(true);
    expect(calls.confirm).not.toHaveBeenCalled();
  });

  it("空列表仍未知，重复重读互斥，失败后旧快照不能用来解锁", async () => {
    const hook = await setup();
    calls.api.mockRejectedValueOnce(new Error("连接中断"));
    calls.json.mockResolvedValueOnce({ ...project, materials: [], materials_total: 0 });
    await act(async () => { await hook.result.current.material.addPaste(); });
    expect(hook.result.current.material.importRecovery?.page?.total).toBe(0);
    expect(hook.result.current.material.importLocked).toBe(true);
    const pending = Promise.withResolvers<unknown>(); calls.json.mockReturnValueOnce(pending.promise);
    let reading!: Promise<void>;
    act(() => { reading = hook.result.current.material.rereadImport(); void hook.result.current.material.rereadImport(); void hook.result.current.material.allowImportRetry(); });
    expect(hook.result.current.material.importRecovery?.page).toBeNull();
    expect(calls.json).toHaveBeenCalledTimes(3);
    expect(calls.confirm).not.toHaveBeenCalled();
    await act(async () => { pending.reject(new Error("读取又失败")); await reading; await hook.result.current.material.allowImportRetry(); });
    expect(calls.confirm).not.toHaveBeenCalled();
    expect(calls.api).toHaveBeenCalledOnce();
  });

  it("核对期间的新输入保留，取消仍锁定，确认只解除锁定且不重发", async () => {
    const hook = await setup();
    calls.api.mockResolvedValueOnce(Response.json({}, { status: 201 }));
    await act(async () => { await hook.result.current.material.addPaste(); });
    act(() => { hook.result.current.material.setMatTitle("下一份"); hook.result.current.material.setMatContent("后来的新输入"); });
    const pending = Promise.withResolvers<boolean>(); calls.confirm.mockReturnValueOnce(pending.promise);
    let confirming!: Promise<void>;
    act(() => { confirming = hook.result.current.material.allowImportRetry(); void hook.result.current.material.allowImportRetry(); void hook.result.current.material.rereadImport(); void hook.result.current.material.addPaste(); });
    expect(calls.confirm).toHaveBeenCalledOnce();
    expect(calls.json).toHaveBeenCalledTimes(2);
    expect(calls.api).toHaveBeenCalledOnce();
    expect(calls.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal), danger: true, message: expect.stringContaining("本次材料") }));
    await act(async () => { pending.resolve(false); await confirming; });
    expect(hook.result.current.material.importLocked).toBe(true);
    await act(async () => { await hook.result.current.material.allowImportRetry(); });
    expect(hook.result.current.material.importLocked).toBe(false);
    expect(hook.result.current.material.matContent).toBe("后来的新输入");
    expect(hook.result.current.material.importRecovery?.message).toContain("可能产生重复");
    expect(calls.api).toHaveBeenCalledOnce();
    calls.api.mockResolvedValueOnce(Response.json({ id: 13, title: "下一份", source: "paste", filename: "" }, { status: 201 }));
    await act(async () => { await hook.result.current.material.addPaste(); });
    expect(JSON.parse(calls.api.mock.calls[1]![1].body).content).toBe("后来的新输入");
    expect(hook.result.current.material.matContent).toBe("");
  });

  it("文件确认需匹配文件名，坏确认保留文件，解除锁定后正确确认不清空后选文件", async () => {
    const hook = await setup();
    const file = new File(["原文件正文"], "材料.txt");
    act(() => hook.result.current.material.setFile(file));
    calls.api.mockResolvedValueOnce(Response.json({ id: 12, title: "材料.txt", source: "file", filename: "另一个.txt" }, { status: 201 }));
    await act(async () => { await hook.result.current.material.addFile(); });
    expect(hook.result.current.material.file).toBe(file);
    await act(async () => { await hook.result.current.material.allowImportRetry(); });
    const pending = Promise.withResolvers<Response>(); calls.api.mockReturnValueOnce(pending.promise);
    let uploading!: Promise<void>;
    act(() => { uploading = hook.result.current.material.addFile(); void hook.result.current.material.addPaste(); });
    const nextFile = new File(["新文件"], "下一份.txt");
    act(() => hook.result.current.material.setFile(nextFile));
    await act(async () => { pending.resolve(Response.json({ id: 13, title: file.name, source: "file", filename: file.name }, { status: 201 })); await uploading; });
    expect(calls.api).toHaveBeenCalledTimes(2);
    expect(hook.result.current.material.file).toBe(nextFile);
    expect(hook.result.current.material.importLocked).toBe(false);
  });

  it.each(["post", "check", "confirm"])("%s 等待时离页中止所属命令，保留的回调不能发起新请求", async phase => {
    const hook = await setup();
    const post = Promise.withResolvers<Response>(); const read = Promise.withResolvers<unknown>(); const confirmation = Promise.withResolvers<boolean>();
    calls.api.mockReturnValueOnce(post.promise);
    if (phase === "check") calls.json.mockReturnValueOnce(read.promise);
    let submitting!: Promise<void>;
    act(() => { submitting = hook.result.current.material.addPaste(); });
    const postSignal = calls.api.mock.calls[0]![1].signal as AbortSignal;
    if (phase !== "post") {
      act(() => post.resolve(Response.json({}, { status: 201 })));
      await waitFor(() => expect(calls.json).toHaveBeenCalledTimes(2));
    }
    let confirming: Promise<void> | undefined;
    if (phase === "confirm") {
      await act(async () => { await submitting; });
      calls.confirm.mockReturnValueOnce(confirmation.promise);
      act(() => { confirming = hook.result.current.material.allowImportRetry(); });
      expect(calls.confirm.mock.calls[0]![0].signal).toBe(postSignal);
    }
    const retained = hook.result.current.material;
    const reads = calls.json.mock.calls.length;
    hook.unmount();
    expect(postSignal.aborted).toBe(true);
    await act(async () => {
      post.resolve(Response.json({}, { status: 201 })); read.resolve(project); confirmation.resolve(true);
      await submitting; await confirming; await retained.addPaste(); await retained.rereadImport(); await retained.allowImportRetry();
    });
    expect(calls.api).toHaveBeenCalledOnce();
    expect(calls.json).toHaveBeenCalledTimes(reads);
  });

  it("切项目取消旧提交，旧 finally 不释放新项目的提交锁", async () => {
    const hook = renderHook(({ id }) => useProjectDetail(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
    act(() => hook.result.current.material.setMatContent("甲材料"));
    const first = Promise.withResolvers<Response>(); const second = Promise.withResolvers<Response>();
    calls.api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let oldSaving!: Promise<void>; let newSaving!: Promise<void>;
    act(() => { oldSaving = hook.result.current.material.addPaste(); });
    const signal = calls.api.mock.calls[0]![1].signal as AbortSignal;
    calls.json.mockResolvedValue({ ...project, id: 2 }); hook.rerender({ id: "2" });
    await waitFor(() => expect(hook.result.current.data?.id).toBe(2));
    expect(signal.aborted).toBe(true);
    act(() => { hook.result.current.material.setMatContent("乙材料"); newSaving = hook.result.current.material.addPaste(); });
    await act(async () => { first.resolve(Response.json({ id: 12, title: "甲材料", source: "paste", filename: "" }, { status: 201 })); await oldSaving; });
    expect(hook.result.current.material.uploading).toBe(true);
    expect(hook.result.current.material.matContent).toBe("乙材料");
    await act(async () => { second.resolve(Response.json({ id: 13, title: "乙材料", source: "paste", filename: "" }, { status: 201 })); await newSaving; });
    expect(hook.result.current.material.matContent).toBe("");
    expect(calls.api.mock.calls.map(([url]) => url)).toEqual(["/api/projects/1/materials", "/api/projects/2/materials"]);
  });
});
