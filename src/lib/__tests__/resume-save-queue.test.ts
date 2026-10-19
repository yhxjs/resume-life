import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/fetcher";
import {
  getResumeSaveQueue,
  ResumeSaveQueue,
  type QueueOptions,
  type ResumeDocument,
  type SaveState,
} from "@/lib/resume-save-queue";

const document = (): ResumeDocument => ({
  resume: { title: "测试简历" },
  modules: [
    { key: "basic", type: "basic", label: "基本信息", sort: 0, content: { name: "旧姓名" } },
    { key: "summary", type: "summary", label: "个人简介", sort: 1, content: { text: "简介" } },
  ],
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function setup(options: QueueOptions = {}) {
  let stored = "";
  let server = document();
  const storage = { read: () => stored, write: (value: string) => { stored = value; } };
  const patch = vi.fn(async (body: Record<string, unknown>, signal: AbortSignal) => {
    void signal;
    const modules = body.modules as Record<string, unknown> | undefined;
    if (modules) server.modules = server.modules.map((m) => m.key in modules ? { ...m, content: modules[m.key] } : m);
    if (typeof body.title === "string") server.resume.title = body.title;
    const rename = body.renameModule as { key: string; label: string } | undefined;
    if (rename) server.modules = server.modules.map((m) => m.key === rename.key ? { ...m, label: rename.label } : m);
    if (Array.isArray(body.moduleOrder)) {
      server.modules = body.moduleOrder.flatMap((key) => {
        const found = server.modules.find((m) => m.key === key);
        return found ? [found] : [];
      });
    }
    return structuredClone(server);
  });
  const queue = new ResumeSaveQueue(patch, storage, options);
  return {
    queue,
    patch,
    storage,
    read: async () => structuredClone(server),
    setServer: (value: ResumeDocument) => { server = value; },
  };
}

function observe(queue: ResumeSaveQueue) {
  let current: SaveState | undefined;
  const unsubscribe = queue.subscribe((state) => { current = state; });
  return { get current() { return current; }, unsubscribe };
}

it("结构写入携带页面加载的世代，不从恢复后的服务端重新取令牌", async () => {
  const { queue, patch, read, setServer } = setup();
  const initial = document();
  Object.assign(initial.resume, { dataGeneration: "original-generation" });
  setServer(initial);
  await queue.load(read);
  const restored = document();
  Object.assign(restored.resume, { dataGeneration: "restored-generation" });
  setServer(restored);
  await queue.mutate({ template: "modern" });
  expect(patch.mock.calls[0]![0]).toMatchObject({ template: "modern", dataGeneration: "original-generation" });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

it("正文保存不能推进未显示的排版版本，自身排版保存才推进", async () => {
  const { queue, patch, read, setServer } = setup();
  const initial = document();
  Object.assign(initial.resume, { styleRevision: "style-initial" });
  setServer(initial);
  await queue.load(read);
  const changedElsewhere = document();
  Object.assign(changedElsewhere.resume, { styleRevision: "style-other-page" });
  setServer(changedElsewhere);
  queue.edit({ title: "改标题" });
  await queue.flush();
  await queue.mutate({ styleOverrides: { pageMargin: 20 } });
  expect(patch.mock.calls.at(-1)![0]).toMatchObject({ styleRevision: "style-initial" });
  await queue.mutate({ styleOverrides: { pageMargin: 21 } });
  expect(patch.mock.calls.at(-1)![0]).toMatchObject({ styleRevision: "style-other-page" });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("resume save queue state machine", () => {
  it("清除本机草稿后，晚到保存响应不能重新写回敏感内容", async () => {
    const { queue, patch, storage, read } = setup();
    await queue.load(read);
    const pending = deferred<ResumeDocument>();
    patch.mockReturnValueOnce(pending.promise);
    queue.edit({ title: "合成敏感草稿" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(patch).toHaveBeenCalledOnce();
    expect(queue.clearLocalDraft()).toBe(true);
    expect(storage.read()).toBe("");
    expect(queue.hasPending).toBe(false);
    pending.resolve(document());
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.read()).toBe("");
    expect(queue.needsUnloadWarning).toBe(false);
  });
  it("drain waits for an in-flight template mutation even without a dirty draft", async () => {
    const { queue, patch } = setup();
    const write = deferred<ResumeDocument>();
    patch.mockImplementationOnce(() => write.promise);
    const mutation = queue.mutate({ template: "modern" });
    await vi.advanceTimersByTimeAsync(0);
    let drained = false;
    const completion = queue.drain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    write.resolve(document());
    await mutation;
    await completion;
    expect(drained).toBe(true);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("concurrent drain callers both wait for the same outstanding work", async () => {
    const { queue, patch } = setup();
    const write = deferred<ResumeDocument>();
    patch.mockImplementationOnce(() => write.promise);
    queue.edit({ title: "发布标题" });
    let completed = 0;
    const first = queue.drain().then(() => { completed += 1; });
    const second = queue.drain().then(() => { completed += 1; });
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(0);
    write.resolve(document());
    await Promise.all([first, second]);
    expect(completed).toBe(2);
    expect(patch).toHaveBeenCalledOnce();
  });

  it("drain propagates a settled mutation failure until a successful server reload", async () => {
    const { queue, patch, read } = setup();
    const error = new HttpError("模板保存失败", 409);
    patch.mockRejectedValueOnce(error);
    await expect(queue.mutate({ template: "modern" })).rejects.toBe(error);
    await queue.mutate({ renameModule: { key: "basic", label: "新名称" } });
    await expect(queue.drain()).rejects.toBe(error);
    await expect(queue.drain()).rejects.toBe(error);
    await expect(queue.load(async () => { throw new Error("读取失败"); })).rejects.toThrow("读取失败");
    await expect(queue.drain()).rejects.toBe(error);
    await queue.load(read);
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it("drain includes drafts edited during a mutation and again during their save", async () => {
    const { queue, patch, storage } = setup();
    const mutationWrite = deferred<ResumeDocument>();
    const draftWrite = deferred<ResumeDocument>();
    patch.mockImplementationOnce(() => mutationWrite.promise).mockImplementationOnce(() => draftWrite.promise);
    const mutation = queue.mutate({ template: "modern" });
    await vi.advanceTimersByTimeAsync(0);
    const completion = queue.drain();
    queue.edit({ title: "第一份编辑" });
    mutationWrite.resolve(document());
    await mutation;
    await vi.advanceTimersByTimeAsync(0);
    expect(patch.mock.calls[1]?.[0]).toEqual({ title: "第一份编辑" });
    queue.edit({ title: "最后一份编辑" });
    draftWrite.resolve(document());
    await completion;
    expect(patch.mock.calls[2]?.[0]).toEqual({ title: "最后一份编辑" });
    expect(queue.hasPending).toBe(false);
    expect(storage.read()).toBe("");
  });

  it("drain waits for a logically cancelled autosave before saving the latest draft", async () => {
    const { queue, patch } = setup();
    const write = deferred<ResumeDocument>();
    patch.mockImplementationOnce(() => write.promise);
    queue.edit({ title: "旧编辑" });
    const oldSave = queue.flush().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const completion = queue.drain();
    queue.edit({ title: "新编辑" });
    expect(await oldSave).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(patch).toHaveBeenCalledOnce();
    write.resolve(document());
    await completion;
    expect(patch.mock.calls[1]?.[0]).toEqual({ title: "新编辑" });
    expect(queue.hasPending).toBe(false);
  });

  it("drain also waits for mutations queued while its draft save is in flight", async () => {
    const { queue, patch } = setup();
    const draftWrite = deferred<ResumeDocument>();
    const mutationWrite = deferred<ResumeDocument>();
    patch.mockImplementationOnce(() => draftWrite.promise).mockImplementationOnce(() => mutationWrite.promise);
    queue.edit({ title: "已编辑" });
    let drained = false;
    const completion = queue.drain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    const mutation = queue.mutate({ moduleOrder: ["summary", "basic"] });
    draftWrite.resolve(document());
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    expect(patch).toHaveBeenCalledTimes(2);
    mutationWrite.resolve(document());
    await mutation;
    await completion;
  });

  it("drain rejects a mutation failure that arrives while waiting", async () => {
    const { queue, patch } = setup();
    const write = deferred<ResumeDocument>();
    patch.mockImplementationOnce(() => write.promise);
    const mutationResult = queue.mutate({ template: "modern" }).catch((error: unknown) => error);
    const completion = queue.drain().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const failure = new HttpError("模板保存失败", 409);
    write.reject(failure);
    expect(await mutationResult).toBe(failure);
    expect(await completion).toBe(failure);
  });

  it("drain rejects a failed draft save and preserves the draft", async () => {
    const { queue, patch, storage } = setup();
    patch.mockRejectedValueOnce(new HttpError("保存冲突", 409));
    queue.edit({ title: "本地标题" });
    await expect(queue.drain()).rejects.toThrow("保存冲突");
    expect(queue.hasPending).toBe(true);
    expect(JSON.parse(storage.read()).title).toBe("本地标题");
  });

  it("disposing cancels drain promptly without aborting an in-flight mutation", async () => {
    const { queue, patch } = setup();
    const write = deferred<ResumeDocument>();
    patch.mockImplementationOnce(() => write.promise);
    const mutationResult = queue.mutate({ template: "modern" }).catch((error: unknown) => error);
    const completion = queue.drain().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    queue.disposeAutoWork();
    expect(await completion).toMatchObject({ name: "AbortError" });
    expect(await mutationResult).toMatchObject({ name: "AbortError" });
    expect(patch.mock.calls[0]?.[1].aborted).toBe(false);
    write.resolve(document());
    await vi.advanceTimersByTimeAsync(0);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("drain does not revive a disposed queue, while an explicit load can", async () => {
    const { queue, patch, read } = setup();
    queue.edit({ title: "恢复草稿" });
    queue.disposeAutoWork();
    await expect(queue.drain()).rejects.toMatchObject({ name: "AbortError" });
    expect(patch).not.toHaveBeenCalled();
    await queue.load(read);
    await queue.drain();
    expect(patch).toHaveBeenCalledOnce();
    expect(queue.hasPending).toBe(false);
  });

  it("收到跨标签页冲突后保留草稿及原始模块版本", async () => {
    const { queue, patch, read, storage } = setup();
    patch.mockRejectedValueOnce(new HttpError("简历已在其他页面修改", 409));
    const original = await read();
    original.modules[0]!.revision = "a".repeat(64);
    await queue.load(async () => original);
    queue.edit({ modules: { basic: { name: "本页草稿" } } });
    await expect(queue.flush()).rejects.toThrow("简历已在其他页面修改");
    expect(patch.mock.calls[0]![0]).toEqual({
      modules: { basic: { name: "本页草稿" } }, moduleRevisions: { basic: "a".repeat(64) },
    });
    expect(JSON.parse(storage.read()).modules.basic).toEqual({ name: "本页草稿" });
    expect(queue.needsUnloadWarning).toBe(true);
  });
  it("标题草稿随读取版本提交，冲突后仍留在本地", async () => {
    const { queue, patch, read, storage } = setup();
    const original = await read();
    original.resume.titleRevision = "b".repeat(64);
    await queue.load(async () => original);
    patch.mockRejectedValueOnce(new HttpError("标题已变化", 409));
    queue.edit({ title: "本页标题" });
    await expect(queue.flush()).rejects.toThrow("标题已变化");
    expect(patch.mock.calls[0]![0]).toEqual({ title: "本页标题", titleRevision: "b".repeat(64) });
    expect(JSON.parse(storage.read()).title).toBe("本页标题");
  });
  it("blocks a non-retryable 400 response after one request", async () => {
    const { queue, patch } = setup({ random: () => 0.5 });
    const state = observe(queue);
    patch.mockRejectedValue(new HttpError("请求有误", 400));

    queue.edit({ modules: { basic: { name: "待保存" } } });
    await expect(queue.flush()).rejects.toThrow("请求有误");

    expect(patch).toHaveBeenCalledTimes(1);
    expect(state.current).toMatchObject({
      phase: "blocked",
      attempt: 1,
      nextRetryAt: null,
      error: "请求有误",
      status: { basic: "err" },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("does not treat a status outside the 5xx range as retryable", async () => {
    const { queue, patch } = setup({ random: () => 0.5 });
    const state = observe(queue);
    patch.mockRejectedValue(new HttpError("非标准状态", 600));

    queue.edit({ title: "待保存" });
    await expect(queue.flush()).rejects.toThrow("非标准状态");

    expect(patch).toHaveBeenCalledTimes(1);
    expect(state.current!.phase).toBe("blocked");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 response at exactly 1, 2, 4, and 8 seconds, then blocks", async () => {
    const { queue, patch } = setup({ now: () => Date.now(), random: () => 0.5 });
    const state = observe(queue);
    patch.mockRejectedValue(new HttpError("服务暂不可用", 503));
    queue.edit({ title: "重试标题" });

    await expect(queue.flush()).rejects.toThrow("服务暂不可用");
    expect(state.current).toMatchObject({ phase: "retry-wait", attempt: 1, nextRetryAt: Date.now() + 1_000 });

    await vi.advanceTimersByTimeAsync(999);
    expect(patch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(state.current).toMatchObject({ phase: "retry-wait", attempt: 2, nextRetryAt: Date.now() + 2_000 });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(patch).toHaveBeenCalledTimes(3);
    expect(state.current).toMatchObject({ phase: "retry-wait", attempt: 3, nextRetryAt: Date.now() + 4_000 });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(patch).toHaveBeenCalledTimes(4);
    expect(state.current).toMatchObject({ phase: "retry-wait", attempt: 4, nextRetryAt: Date.now() + 8_000 });

    await vi.advanceTimersByTimeAsync(8_000);
    expect(patch).toHaveBeenCalledTimes(5);
    expect(state.current).toMatchObject({ phase: "blocked", attempt: 5, nextRetryAt: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(patch).toHaveBeenCalledTimes(5);
  });

  it("limits ordinary network errors to the first request plus four retries", async () => {
    const { queue, patch } = setup({ random: () => 0.5 });
    const state = observe(queue);
    patch.mockRejectedValue(new Error("无法连接服务器"));
    queue.edit({ title: "离线标题" });

    await expect(queue.flush()).rejects.toThrow("无法连接服务器");
    await vi.advanceTimersByTimeAsync(15_000);

    expect(patch).toHaveBeenCalledTimes(5);
    expect(state.current).toMatchObject({ phase: "blocked", attempt: 5, nextRetryAt: null });
  });

  it("logically cancels the old flush without aborting its in-flight autosave transport", async () => {
    const firstStarted = deferred();
    const firstWrite = deferred<ResumeDocument>();
    const { queue, patch } = setup();
    patch.mockImplementationOnce(() => {
      firstStarted.resolve(undefined);
      return firstWrite.promise;
    });

    queue.edit({ modules: { basic: { name: "第一版" } } });
    const first = queue.flush();
    const firstResult = first.catch((error: unknown) => error);
    await firstStarted.promise;
    const firstSignal = patch.mock.calls[0]![1];

    queue.edit({ modules: { basic: { name: "第二版" } } });
    expect(firstSignal.aborted).toBe(false);
    await expect(firstResult).resolves.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(patch).toHaveBeenCalledTimes(1);
    firstWrite.resolve(document());
    await vi.advanceTimersByTimeAsync(0);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1]![0]).toEqual({ modules: { basic: { name: "第二版" } } });
  });

  it.each(["success", "failure"] as const)(
    "waits for a stale request to settle, then ignores its %s result",
    async (outcome) => {
      const oldRequest = deferred<ResumeDocument>();
      const currentRequest = deferred<ResumeDocument>();
      const { queue, patch, storage } = setup();
      const state = observe(queue);
      patch
        .mockImplementationOnce(() => oldRequest.promise)
        .mockImplementationOnce(() => currentRequest.promise);
      queue.edit({ modules: { basic: { name: "第一版" } } });
      const first = queue.flush();
      const firstResult = first.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);

      queue.edit({ modules: { basic: { name: "第二版" } } });
      expect(patch.mock.calls[0]![1].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(patch).toHaveBeenCalledTimes(1);
      expect(storage.read()).toContain("第二版");
      expect(state.current).toMatchObject({ phase: "dirty", error: "", attempt: 0 });
      await expect(firstResult).resolves.toMatchObject({ name: "AbortError" });

      if (outcome === "success") oldRequest.resolve(document());
      else oldRequest.reject(new Error("stale failure"));
      await vi.advanceTimersByTimeAsync(0);

      expect(patch).toHaveBeenCalledTimes(2);
      expect(patch.mock.calls[1]![0]).toEqual({ modules: { basic: { name: "第二版" } } });
      expect(storage.read()).toContain("第二版");
      expect(state.current).toMatchObject({ phase: "saving", error: "", attempt: 1 });
      currentRequest.resolve(document());
      await vi.advanceTimersByTimeAsync(0);
      expect(storage.read()).toBe("");
      expect(state.current!.phase).toBe("saved");
    },
  );

  it("manual retry resets attempts, cancels the old timer, and saves immediately", async () => {
    const { queue, patch } = setup({ random: () => 0.5 });
    const state = observe(queue);
    patch.mockRejectedValueOnce(new Error("offline"));
    queue.edit({ title: "手动重试" });
    await expect(queue.flush()).rejects.toThrow("offline");
    expect(state.current).toMatchObject({ phase: "retry-wait", attempt: 1 });

    const retry = queue.retry();
    await vi.advanceTimersByTimeAsync(0);
    await retry;

    expect(patch).toHaveBeenCalledTimes(2);
    expect(state.current).toMatchObject({ phase: "saved", attempt: 1, nextRetryAt: null, error: "" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it("disposeAutoWork clears retry timers and logically cancels autosaves without aborting transport", async () => {
    const { queue, patch, storage } = setup({ random: () => 0.5 });
    const state = observe(queue);
    patch.mockRejectedValueOnce(new Error("offline"));
    queue.edit({ title: "保留草稿" });
    await expect(queue.flush()).rejects.toThrow("offline");

    queue.disposeAutoWork();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(storage.read()).toContain("保留草稿");

    const activeWrite = deferred<ResumeDocument>();
    patch.mockImplementationOnce(() => activeWrite.promise);
    const retry = queue.retry();
    const retryResult = retry.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const activeSignal = patch.mock.calls[1]![1];
    queue.disposeAutoWork();

    expect(activeSignal.aborted).toBe(false);
    await expect(retryResult).resolves.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(storage.read()).toContain("保留草稿");
    expect(queue.needsUnloadWarning).toBe(true);
    expect(state.current).toMatchObject({
      phase: "retry-wait",
      attempt: 0,
      nextRetryAt: null,
      error: expect.stringContaining("服务器仍在处理"),
    });
    activeWrite.resolve(document());
    await vi.advanceTimersByTimeAsync(0);
    expect(state.current).toMatchObject({ phase: "dirty", attempt: 0, nextRetryAt: null, error: "" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["late failure", "late success"] as const)(
    "dispose prevents a mutate waiting for a dirty save from continuing after %s",
    async (outcome) => {
      const dirtySave = deferred<ResumeDocument>();
      const { queue, patch } = setup();
      const apply = vi.fn();
      patch.mockImplementationOnce(() => dirtySave.promise);
      queue.edit({ modules: { basic: { name: "待保存" } } });
      const mutation = queue.mutate({ moduleOrder: ["summary", "basic"] }, apply);
      const mutationResult = mutation.catch((error: unknown) => error);
      let mutationSettled = false;
      void mutationResult.then(() => { mutationSettled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(patch.mock.calls[0]![0]).toEqual({ modules: { basic: { name: "待保存" } } });

      queue.disposeAutoWork();
      expect(patch.mock.calls[0]![1].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(mutationSettled).toBe(true);
      await expect(mutationResult).resolves.toMatchObject({ name: "AbortError" });
      if (outcome === "late success") dirtySave.resolve(document());
      else dirtySave.reject(new Error("late failure"));
      await vi.advanceTimersByTimeAsync(0);

      expect(patch).toHaveBeenCalledTimes(1);
      expect(apply).not.toHaveBeenCalled();
    },
  );

  it("dispose prevents an in-flight structure response from applying", async () => {
    const structureWrite = deferred<ResumeDocument>();
    const { queue, patch } = setup();
    const apply = vi.fn();
    patch.mockImplementationOnce(() => structureWrite.promise);
    const mutation = queue.mutate({ moduleOrder: ["summary", "basic"] }, apply);
    const mutationResult = mutation.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(patch.mock.calls[0]![0]).toEqual({ moduleOrder: ["summary", "basic"] });
    const structureSignal = patch.mock.calls[0]![1];

    queue.disposeAutoWork();

    expect(structureSignal.aborted).toBe(false);
    await expect(mutationResult).resolves.toMatchObject({ name: "AbortError" });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    structureWrite.resolve(document());
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it("logically cancels every queued mutate on dispose without starting later requests", async () => {
    const structureWrite = deferred<ResumeDocument>();
    const { queue, patch } = setup();
    const firstApply = vi.fn();
    const secondApply = vi.fn();
    patch.mockImplementationOnce(() => structureWrite.promise);
    const first = queue.mutate({ renameModule: { key: "basic", label: "第一版" } }, firstApply);
    const second = queue.mutate({ renameModule: { key: "basic", label: "第二版" } }, secondApply);
    const firstResult = first.catch((error: unknown) => error);
    const secondResult = second.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const activeSignal = patch.mock.calls[0]![1];

    queue.disposeAutoWork();

    expect(activeSignal.aborted).toBe(false);
    await expect(firstResult).resolves.toMatchObject({ name: "AbortError" });
    await expect(secondResult).resolves.toMatchObject({ name: "AbortError" });
    expect(patch).toHaveBeenCalledTimes(1);
    structureWrite.resolve(document());
    await vi.advanceTimersByTimeAsync(0);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(firstApply).not.toHaveBeenCalled();
    expect(secondApply).not.toHaveBeenCalled();
  });

  it("does not abort an in-flight structure request when the user edits", async () => {
    const structureWrite = deferred<ResumeDocument>();
    const { queue, patch, read } = setup();
    const apply = vi.fn();
    patch.mockImplementationOnce((_body, signal) => new Promise<ResumeDocument>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
      void structureWrite.promise.then(resolve, reject);
    }));
    const mutation = queue.mutate({ moduleOrder: ["summary", "basic"] }, apply);
    const mutationResult = mutation.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const structureSignal = patch.mock.calls[0]![1];

    queue.edit({ modules: { basic: { name: "结构操作期间" } } });
    expect(structureSignal.aborted).toBe(false);
    structureWrite.resolve(document());

    const result = await mutationResult;
    expect(result).toHaveProperty("value");
    expect(apply).toHaveBeenCalledTimes(1);
    const applied = apply.mock.calls[0]![0] as ResumeDocument;
    expect(applied.modules.find((module) => module.key === "basic")?.content)
      .toEqual({ name: "结构操作期间" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await read()).modules.find((module) => module.key === "basic")?.content)
      .toEqual({ name: "结构操作期间" });
  });

  it("continues a mutate with the newest draft after edit logically cancels its dirty save", async () => {
    const firstStarted = deferred();
    const firstWrite = deferred<ResumeDocument>();
    const { queue, patch } = setup();
    const save = patch.getMockImplementation()!;
    patch.mockImplementationOnce(() => {
      firstStarted.resolve(undefined);
      return firstWrite.promise;
    });
    queue.edit({ modules: { basic: { name: "第一版" } } });
    const mutation = queue.mutate({ moduleOrder: ["summary", "basic"] });
    await firstStarted.promise;

    queue.edit({ modules: { basic: { name: "第二版" } } });
    expect(patch.mock.calls[0]![1].aborted).toBe(false);
    patch.mockImplementation(save);
    firstWrite.resolve(document());
    await mutation;

    expect(patch.mock.calls.map(([body]) => body)).toEqual([
      { modules: { basic: { name: "第一版" } } },
      { modules: { basic: { name: "第二版" } } },
      { moduleOrder: ["summary", "basic"] },
    ]);
  });

  it("keeps the current autosave transport intact when a stale request finally settles", async () => {
    const oldRequest = deferred<ResumeDocument>();
    const currentRequest = deferred<ResumeDocument>();
    const { queue, patch } = setup();
    patch
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => currentRequest.promise);
    queue.edit({ modules: { basic: { name: "第一版" } } });
    const firstResult = queue.flush().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);

    queue.edit({ modules: { basic: { name: "第二版" } } });
    const secondResult = queue.flush().catch((error: unknown) => error);
    expect(patch).toHaveBeenCalledTimes(1);
    oldRequest.resolve(document());
    await vi.advanceTimersByTimeAsync(0);
    expect(patch).toHaveBeenCalledTimes(2);
    const currentSignal = patch.mock.calls[1]![1];

    queue.edit({ modules: { basic: { name: "第三版" } } });
    expect(currentSignal.aborted).toBe(false);
    await expect(firstResult).resolves.toMatchObject({ name: "AbortError" });
    await expect(secondResult).resolves.toMatchObject({ name: "AbortError" });
    currentRequest.resolve(document());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(patch).toHaveBeenCalledTimes(3);
  });

  it("does not run a cancelled queued save after direct takeover fails", async () => {
    const loadGate = deferred<ResumeDocument>();
    const { queue, patch } = setup({ random: () => 0.5 });
    patch.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(document());
    const load = queue.load(() => loadGate.promise);
    queue.edit({ modules: { basic: { name: "待保存" } } });
    const mutation = queue.mutate({ moduleOrder: ["summary", "basic"] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(patch).not.toHaveBeenCalled();

    loadGate.resolve(document());
    await load;
    await expect(mutation).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(0);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]![0]).toEqual({ modules: { basic: { name: "待保存" } } });
    await vi.advanceTimersByTimeAsync(999);
    expect(patch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it("keeps the latest caller successful when mutation direct-save takes over its queued successor", async () => {
    const firstWrite = deferred<ResumeDocument>();
    const { queue, patch } = setup();
    patch.mockImplementationOnce(() => firstWrite.promise);
    queue.edit({ modules: { basic: { name: "第一版" } } });
    const firstResult = queue.flush().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const mutation = queue.mutate({ moduleOrder: ["summary", "basic"] });

    queue.edit({ modules: { basic: { name: "第二版" } } });
    const latest = queue.flush();
    const latestResult = latest.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    firstWrite.resolve(document());
    await mutation;

    await expect(firstResult).resolves.toMatchObject({ name: "AbortError" });
    await expect(latestResult).resolves.toEqual({ ok: true });
    expect(patch.mock.calls.map(([body]) => body)).toEqual([
      { modules: { basic: { name: "第一版" } } },
      { modules: { basic: { name: "第二版" } } },
      { moduleOrder: ["summary", "basic"] },
    ]);
  });

  it("forwards a direct takeover failure to the latest caller", async () => {
    const firstWrite = deferred<ResumeDocument>();
    const directError = new Error("direct save failed");
    const { queue, patch } = setup();
    patch
      .mockImplementationOnce(() => firstWrite.promise)
      .mockRejectedValueOnce(directError);
    queue.edit({ modules: { basic: { name: "第一版" } } });
    const firstResult = queue.flush().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const mutation = queue.mutate({ moduleOrder: ["summary", "basic"] });

    queue.edit({ modules: { basic: { name: "第二版" } } });
    const latestResult = queue.flush().catch((error: unknown) => error);
    firstWrite.resolve(document());

    await expect(mutation).rejects.toBe(directError);
    await expect(firstResult).resolves.toMatchObject({ name: "AbortError" });
    await expect(latestResult).resolves.toBe(directError);
    expect(patch.mock.calls.map(([body]) => body)).toEqual([
      { modules: { basic: { name: "第一版" } } },
      { modules: { basic: { name: "第二版" } } },
    ]);
  });

  it("shows a transport wait without releasing autosave order and recovers after drain", async () => {
    const stalledWrite = deferred<ResumeDocument>();
    const { queue, patch, read } = setup();
    const state = observe(queue);
    patch.mockImplementationOnce(() => stalledWrite.promise);
    queue.edit({ modules: { basic: { name: "第一版" } } });
    const staleResult = queue.flush().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    queue.edit({ modules: { basic: { name: "第二版" } } });
    const queued = queue.flush();
    const queuedResult = queued.catch((error: unknown) => error);
    const load = queue.load(read);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(state.current!.phase).not.toBe("retry-wait");
    await vi.advanceTimersByTimeAsync(1);

    expect(state.current).toMatchObject({
      phase: "retry-wait",
      error: expect.stringContaining("服务器仍在处理"),
      nextRetryAt: null,
    });
    expect(patch).toHaveBeenCalledTimes(1);
    const retry = queue.retry();
    expect(state.current).toMatchObject({
      phase: "retry-wait",
      error: expect.stringContaining("服务器仍在处理"),
      nextRetryAt: null,
    });
    expect(patch).toHaveBeenCalledTimes(1);

    stalledWrite.resolve(document());
    await expect(staleResult).resolves.toMatchObject({ name: "AbortError" });
    await expect(queuedResult).resolves.toMatchObject({ name: "AbortError" });
    await load;
    await retry;

    expect(patch).toHaveBeenCalledTimes(2);
    expect(state.current).toMatchObject({ phase: "saved", error: "", nextRetryAt: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows and clears the transport wait for a stalled mutation", async () => {
    const stalledWrite = deferred<ResumeDocument>();
    const { queue, patch } = setup();
    const state = observe(queue);
    patch.mockImplementationOnce(() => stalledWrite.promise);
    const mutation = queue.mutate({ renameModule: { key: "basic", label: "等待确认" } });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(patch.mock.calls[0]![1].aborted).toBe(false);
    expect(state.current).toMatchObject({
      phase: "retry-wait",
      error: expect.stringContaining("服务器仍在处理"),
      nextRetryAt: null,
    });
    expect(patch).toHaveBeenCalledTimes(1);
    await queue.retry();
    expect(state.current).toMatchObject({
      phase: "retry-wait",
      error: expect.stringContaining("服务器仍在处理"),
      nextRetryAt: null,
    });
    expect(patch).toHaveBeenCalledTimes(1);
    stalledWrite.resolve(document());
    await mutation;

    expect(state.current).toMatchObject({ phase: "idle", error: "", nextRetryAt: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces repeated save intents during a stalled autosave into one latest successor", async () => {
    const stalledWrite = deferred<ResumeDocument>();
    const successorStarted = deferred();
    const { queue, patch } = setup();
    const save = patch.getMockImplementation()!;
    patch
      .mockImplementationOnce(() => stalledWrite.promise)
      .mockImplementation((body, signal) => {
        successorStarted.resolve(undefined);
        return save(body, signal);
      });
    queue.edit({ modules: { basic: { name: "第一版" } } });
    const firstResult = queue.flush().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const internals = queue as unknown as {
      enqueue: (operation: () => Promise<unknown>) => Promise<unknown>;
    };
    const enqueue = vi.spyOn(internals, "enqueue");
    await vi.advanceTimersByTimeAsync(30_000);

    const callerResults: Promise<unknown>[] = [];
    for (let index = 2; index <= 20; index += 1) {
      queue.edit({ modules: { basic: { name: `第${index}版` } } });
      callerResults.push(queue.flush().catch((error: unknown) => error));
      callerResults.push(queue.retry().catch((error: unknown) => error));
    }

    expect(enqueue).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledTimes(1);
    stalledWrite.resolve(document());
    await successorStarted.promise;
    await Promise.all(callerResults);
    await expect(firstResult).resolves.toMatchObject({ name: "AbortError" });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1]![0]).toEqual({ modules: { basic: { name: "第20版" } } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces edits during an active mutation transport into one latest autosave", async () => {
    const mutationWrite = deferred<ResumeDocument>();
    const successorStarted = deferred();
    const { queue, patch } = setup();
    const save = patch.getMockImplementation()!;
    patch
      .mockImplementationOnce(() => mutationWrite.promise)
      .mockImplementation((body, signal) => {
        successorStarted.resolve(undefined);
        return save(body, signal);
      });
    const mutation = queue.mutate({ template: "modern" });
    await vi.advanceTimersByTimeAsync(0);
    const internals = queue as unknown as {
      enqueue: (operation: () => Promise<unknown>) => Promise<unknown>;
    };
    const enqueue = vi.spyOn(internals, "enqueue");
    const callerResults: Promise<unknown>[] = [];

    for (let index = 1; index <= 20; index += 1) {
      queue.edit({ modules: { basic: { name: `结构写期间${index}` } } });
      callerResults.push(queue.flush().catch((error: unknown) => error));
    }

    expect(enqueue).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledTimes(1);
    mutationWrite.resolve(document());
    await mutation;
    await successorStarted.promise;
    await Promise.all(callerResults);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1]![0]).toEqual({ modules: { basic: { name: "结构写期间20" } } });
  });
});

describe("resume save queue contracts", () => {
  it("warns before closing any unsaved draft even when session storage works", async () => {
    const { queue, patch, storage } = setup();
    expect(queue.needsUnloadWarning).toBe(false);
    queue.edit({ title: "尚未保存" });
    expect(queue.needsUnloadWarning).toBe(true);
    patch.mockRejectedValueOnce(new Error("offline"));
    await expect(queue.flush()).rejects.toThrow("offline");
    expect(storage.read()).toContain("尚未保存");
    expect(queue.needsUnloadWarning).toBe(true);
    queue.disposeAutoWork();
    const reloaded = new ResumeSaveQueue(patch, storage);
    expect(reloaded.needsUnloadWarning).toBe(true);
    await reloaded.flush();
    expect(reloaded.needsUnloadWarning).toBe(false);
  });

  it("keeps debounced changes after the editor unsubscribes and saves them", async () => {
    const { queue, patch, read, storage } = setup();
    const unsubscribe = queue.subscribe(() => {});
    queue.edit({ modules: { basic: { name: "离页草稿" } } });
    expect(storage.read()).toContain("离页草稿");
    unsubscribe();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(patch).toHaveBeenCalledTimes(1);
    expect((await queue.load(read)).modules[0]!.content).toEqual({ name: "离页草稿" });
    expect(storage.read()).toBe("");
  });

  it("restores a failed draft after a reload and removes it only after success", async () => {
    const { queue, patch, read, storage } = setup();
    patch.mockRejectedValueOnce(new Error("offline"));
    queue.edit({ title: "新标题", modules: { basic: { name: "恢复草稿" } } });
    await expect(queue.flush()).rejects.toThrow("offline");
    expect(storage.read()).toContain("恢复草稿");
    queue.disposeAutoWork();
    const reloaded = new ResumeSaveQueue(patch, storage);
    const restored = await reloaded.load(read);
    expect(restored.resume.title).toBe("新标题");
    expect(restored.modules[0]!.content).toEqual({ name: "恢复草稿" });
    await reloaded.flush();
    expect(storage.read()).toBe("");
    expect((await read()).modules[0]!.content).toEqual({ name: "恢复草稿" });
  });

  it("keeps autosave transport alive so delayed server writes finish before the newest write", async () => {
    const firstServerWrite = deferred();
    let serverName = "旧姓名";
    let callCount = 0;
    const storage = { read: () => "", write: () => {} };
    const applyServerWrite = (body: Record<string, unknown>) => {
      const modules = body.modules as Record<string, { name?: string }> | undefined;
      if (modules?.basic?.name) serverName = modules.basic.name;
      const updated = document();
      updated.modules[0] = { ...updated.modules[0]!, content: { name: serverName } };
      return updated;
    };
    const patch = vi.fn((body: Record<string, unknown>, signal: AbortSignal) => {
      callCount += 1;
      if (callCount > 1) return Promise.resolve(applyServerWrite(body));
      return new Promise<ResumeDocument>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
        void firstServerWrite.promise.then(() => resolve(applyServerWrite(body)), reject);
      });
    });
    const queue = new ResumeSaveQueue(patch, storage);
    queue.edit({ modules: { basic: { name: "第一版" } } });
    const first = queue.flush();
    const firstResult = first.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    queue.edit({ modules: { basic: { name: "第二版" } } });
    const second = queue.flush();
    await vi.advanceTimersByTimeAsync(0);

    expect(patch.mock.calls[0]![1].aborted).toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);
    await expect(firstResult).resolves.toMatchObject({ name: "AbortError" });
    firstServerWrite.resolve(undefined);
    await second;

    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls.map(([body]) => (body.modules as Record<string, unknown>).basic))
      .toEqual([{ name: "第一版" }, { name: "第二版" }]);
    expect(serverName).toBe("第二版");
  });

  it("drains an autosave before a remounted editor can load and save a newer draft", async () => {
    const firstServerWrite = deferred();
    let serverName = "旧姓名";
    let callCount = 0;
    const storage = { read: () => "", write: () => {} };
    const patch = vi.fn(async (body: Record<string, unknown>, signal: AbortSignal) => {
      void signal;
      callCount += 1;
      if (callCount === 1) await firstServerWrite.promise;
      const modules = body.modules as Record<string, { name?: string }> | undefined;
      if (modules?.basic?.name) serverName = modules.basic.name;
      const updated = document();
      updated.modules[0] = { ...updated.modules[0]!, content: { name: serverName } };
      return updated;
    });
    const queue = new ResumeSaveQueue(patch, storage);
    queue.edit({ modules: { basic: { name: "离开前版本" } } });
    const firstResult = queue.flush().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const firstSignal = patch.mock.calls[0]![1];

    queue.disposeAutoWork();
    await expect(firstResult).resolves.toMatchObject({ name: "AbortError" });
    const load = queue.load(async () => {
      const loaded = document();
      loaded.modules[0] = { ...loaded.modules[0]!, content: { name: serverName } };
      return loaded;
    });
    queue.edit({ modules: { basic: { name: "重挂载新版" } } });
    const latest = queue.flush();
    await vi.advanceTimersByTimeAsync(0);

    expect(firstSignal.aborted).toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);
    firstServerWrite.resolve(undefined);
    await load;
    await latest;

    expect(patch).toHaveBeenCalledTimes(2);
    expect(serverName).toBe("重挂载新版");
  });

  it("drains a disposed mutation before a remounted editor can send a newer mutation", async () => {
    const firstServerWrite = deferred();
    let serverLabel = "基本信息";
    let callCount = 0;
    const storage = { read: () => "", write: () => {} };
    const applyServerWrite = (body: Record<string, unknown>) => {
      const rename = body.renameModule as { key: string; label: string } | undefined;
      if (rename?.key === "basic") serverLabel = rename.label;
      const updated = document();
      updated.modules[0] = { ...updated.modules[0]!, label: serverLabel };
      return updated;
    };
    const patch = vi.fn((body: Record<string, unknown>, signal: AbortSignal) => {
      callCount += 1;
      if (callCount > 1) return Promise.resolve(applyServerWrite(body));
      return new Promise<ResumeDocument>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
        void firstServerWrite.promise.then(() => resolve(applyServerWrite(body)), reject);
      });
    });
    const queue = new ResumeSaveQueue(patch, storage);
    const oldMutation = queue.mutate({ renameModule: { key: "basic", label: "离开前名称" } });
    const oldResult = oldMutation.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const oldSignal = patch.mock.calls[0]![1];

    queue.disposeAutoWork();
    await expect(oldResult).resolves.toMatchObject({ name: "AbortError" });
    const load = queue.load(async () => {
      const loaded = document();
      loaded.modules[0] = { ...loaded.modules[0]!, label: serverLabel };
      return loaded;
    });
    const latest = queue.mutate({ renameModule: { key: "basic", label: "重挂载新版" } });
    await vi.advanceTimersByTimeAsync(0);

    expect(oldSignal.aborted).toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);
    firstServerWrite.resolve(undefined);
    await load;
    await latest;

    expect(patch).toHaveBeenCalledTimes(2);
    expect(serverLabel).toBe("重挂载新版");
  });

  it.each([
    { renameModule: { key: "basic", label: "联系方式" } },
    { moduleOrder: ["summary", "basic"] },
  ])("waits for dirty saves before structure changes and preserves edits during the response: %j", async (operation) => {
    const { queue, patch, read } = setup();
    const gate = deferred();
    const save = patch.getMockImplementation()!;
    patch.mockImplementation(async (body, signal) => {
      if (!body.modules) await gate.promise;
      return save(body, signal);
    });
    queue.edit({ modules: { basic: { name: "操作前" } } });
    let displayed: ResumeDocument | undefined;
    const mutation = queue.mutate(operation, (updated) => { displayed = updated; });
    await vi.advanceTimersByTimeAsync(0);
    expect(patch.mock.calls[0]![0]).toEqual({ modules: { basic: { name: "操作前" } } });
    queue.edit({ modules: { basic: { name: "操作期间" } } });
    gate.resolve(undefined);
    await mutation;
    expect(displayed?.modules.find((m) => m.key === "basic")?.content).toEqual({ name: "操作期间" });
    await queue.flush();
    expect((await read()).modules.find((m) => m.key === "basic")?.content).toEqual({ name: "操作期间" });
  });

  it("does not run a structure write when the preceding dirty save fails", async () => {
    const { queue, patch } = setup();
    patch.mockRejectedValueOnce(new Error("offline"));
    queue.edit({ modules: { basic: { name: "待保存" } } });
    await expect(queue.mutate({ moduleOrder: ["summary", "basic"] }, () => {})).rejects.toThrow("offline");
    expect(patch).toHaveBeenCalledTimes(1);
    queue.disposeAutoWork();
  });

  it("keeps an empty-title draft and blocks without making a request", async () => {
    const { queue, storage, patch } = setup();
    const state = observe(queue);
    queue.edit({ title: "", modules: { basic: { name: "保留姓名" } } });
    await expect(queue.flush()).rejects.toThrow("标题不能为空");
    expect(state.current).toMatchObject({ phase: "blocked", attempt: 0 });
    expect(storage.read()).toContain("保留姓名");
    expect(patch).not.toHaveBeenCalled();
    queue.edit({ title: "补全标题" });
    await queue.flush();
    expect(storage.read()).toBe("");
  });
});

it("passes an AbortSignal and saves large Unicode drafts without keepalive", async () => {
  let keepalive: boolean | undefined;
  let signal: AbortSignal | null | undefined;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    keepalive = init?.keepalive;
    signal = init?.signal;
    return new Response(JSON.stringify(document()));
  });
  const values = new Map<string, string>();
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  const queue = getResumeSaveQueue("large-unicode-test");
  queue.edit({ modules: { summary: { text: "字".repeat(24_000) } } });
  await queue.flush();
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(keepalive).toBe(false);
  expect(values.size).toBe(0);
});

it("keeps the browser unload guard after an editor unsubscribes until pending saves succeed", async () => {
  const browser = new EventTarget();
  vi.stubGlobal("window", browser);
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ error: "offline" }, { status: 503 }))
    .mockResolvedValue(new Response(JSON.stringify(document())));
  vi.stubGlobal("fetch", fetch);
  const queue = getResumeSaveQueue("away-from-editor");
  const unsubscribe = queue.subscribe(() => {});
  queue.edit({ title: "离线草稿" });
  unsubscribe();
  await expect(queue.flush()).rejects.toThrow("offline");
  const warning = new Event("beforeunload", { cancelable: true });
  browser.dispatchEvent(warning);
  expect(warning.defaultPrevented).toBe(true);
  await queue.flush();
  const saved = new Event("beforeunload", { cancelable: true });
  browser.dispatchEvent(saved);
  expect(saved.defaultPrevented).toBe(false);
});
