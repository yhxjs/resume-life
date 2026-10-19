import { readDraft, persistDraft, mergeDraft, hasDraft, type Draft, type Storage, type ResumeDocument } from "@/lib/resume-save-queue-draft";

import { isRetryable, retryDelay } from "@/lib/resume-save-queue-retry";

import { errorMessage } from "@/lib/error-message";
import { cancellationError, createDeferredSave, createScheduledSave, type DeferredSave, type ScheduledSave } from "@/lib/resume-save-queue-scheduling";

export type SavePhase = "idle" | "dirty" | "saving" | "saved" | "retry-wait" | "blocked";
export type SaveState = {
  phase: SavePhase;
  status: Record<string, "editing" | "saving" | "saved" | "err">;
  error: string;
  storageError: boolean;
  attempt: number;
  nextRetryAt: number | null;
};

export type QueueOptions = {
  now?: () => number;
  random?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

type TransportWatchdog = {
  timer: ReturnType<typeof setTimeout> | undefined;
  timedOut: boolean;
  restore: Pick<SaveState, "phase" | "error" | "nextRetryAt">;
};

const MAX_ATTEMPTS = 5;
const TRANSPORT_WATCHDOG_MS = 30_000;
const TRANSPORT_WAIT_ERROR = "服务器仍在处理，已暂停后续写入，正在等待确认";

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

/** 已发写请求只能逻辑取消，并须留在串行槽中等待 transport drain。 */
export class ResumeSaveQueue {
  private draft: Draft = {};
  private revisions: Record<string, string> = {};
  private titleRevision?: string;
  private styleRevision?: string;
  private dataGeneration?: string | null;
  private tail: Promise<unknown> = Promise.resolve();
  private draining: Promise<void> | undefined;
  private mutationFailure: { error: unknown } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private transportWatchdog: TransportWatchdog | undefined;
  private scheduledSave: ScheduledSave | undefined;
  private deferredSave: DeferredSave | undefined;
  private pendingMutationCancellations = new Set<() => void>();
  private version = 0;
  private lifecycle = 0;
  private autoWorkEnabled = true;
  private listeners = new Set<(state: SaveState) => void>();
  private state: SaveState = {
    phase: "idle",
    status: {},
    error: "",
    storageError: false,
    attempt: 0,
    nextRetryAt: null,
  };
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(
    private patch: (body: Record<string, unknown>, signal: AbortSignal) => Promise<ResumeDocument>,
    private storage: Storage,
    options: QueueOptions = {},
    private onIdle?: (queue: ResumeSaveQueue) => void,
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimer = options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);

    const restored = readDraft(storage);
    this.draft = restored.draft;
    this.state.storageError = restored.storageError;

    if (this.hasPending) {
      this.state.phase = "dirty";
      for (const key of Object.keys(this.draft.modules ?? {})) this.state.status[key] = "editing";
    }
  }

  get hasPending() {
    return hasDraft(this.draft);
  }

  get needsUnloadWarning() {
    return this.hasPending;
  }

  /** 是否仍有 UI 订阅者；用于判断队列可否被回收 */
  get hasSubscribers() {
    return this.listeners.size > 0;
  }

  /** 是否还有在途的定时器、防抖/重试排程或传输等待 */
  get hasActiveWork() {
    return (
      this.timer !== undefined ||
      this.scheduledSave !== undefined ||
      this.deferredSave !== undefined ||
      this.transportWatchdog !== undefined
    );
  }

  subscribe(listener: (state: SaveState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
      this.onIdle?.(this);
    };
  }

  private emit() {
    this.state = { ...this.state, status: { ...this.state.status } };
    for (const listener of this.listeners) listener(this.state);
  }

  private persist() {
    this.state.storageError = !persistDraft(this.storage, this.draft);
  }

  private clearScheduledTimer() {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private cancelScheduledSaveLogically(save = this.scheduledSave) {
    if (!save) return;
    if (this.scheduledSave === save) this.scheduledSave = undefined;
    save.cancelLogically();
  }

  private cancelDeferredSaveLogically(save = this.deferredSave) {
    if (!save) return;
    if (this.deferredSave === save) this.deferredSave = undefined;
    save.cancelLogically();
  }

  private cancelPendingMutationsLogically() {
    for (const cancel of [...this.pendingMutationCancellations]) cancel();
  }

  private retainTransportWait() {
    const watchdog = this.transportWatchdog;
    if (!watchdog?.timedOut) return;
    watchdog.restore = {
      phase: this.state.phase,
      error: this.state.error,
      nextRetryAt: this.state.nextRetryAt,
    };
    this.state.phase = "retry-wait";
    this.state.error = TRANSPORT_WAIT_ERROR;
    this.state.nextRetryAt = null;
  }

  private phaseWithoutTransportWait() {
    const watchdog = this.transportWatchdog;
    return watchdog?.timedOut ? watchdog.restore.phase : this.state.phase;
  }

  private startTransportWatchdog() {
    const watchdog: TransportWatchdog = {
      timer: undefined,
      timedOut: false,
      restore: {
        phase: this.state.phase,
        error: this.state.error,
        nextRetryAt: this.state.nextRetryAt,
      },
    };
    watchdog.timer = this.setTimer(() => {
      watchdog.timer = undefined;
      if (this.transportWatchdog !== watchdog) return;
      watchdog.timedOut = true;
      watchdog.restore = {
        phase: this.state.phase,
        error: this.state.error,
        nextRetryAt: this.state.nextRetryAt,
      };
      this.state.phase = "retry-wait";
      this.state.error = TRANSPORT_WAIT_ERROR;
      this.state.nextRetryAt = null;
      this.emit();
    }, TRANSPORT_WATCHDOG_MS);
    this.transportWatchdog = watchdog;
    return watchdog;
  }

  private finishTransportWatchdog(watchdog: TransportWatchdog) {
    if (watchdog.timer !== undefined) this.clearTimer(watchdog.timer);
    if (this.transportWatchdog !== watchdog) return;
    this.transportWatchdog = undefined;
    if (watchdog.timedOut) {
      this.state.phase = watchdog.restore.phase;
      this.state.error = watchdog.restore.error;
      this.state.nextRetryAt = watchdog.restore.nextRetryAt;
      this.emit();
    }
    this.deferredSave?.start();
  }

  private assertLifecycle(lifecycle: number) {
    if (!this.autoWorkEnabled || lifecycle !== this.lifecycle) throw cancellationError();
  }

  private scheduleDebounce(version: number) {
    this.clearScheduledTimer();
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (!this.autoWorkEnabled || version !== this.version) return;
      void this.startSave(version).catch(() => {});
    }, 1_000);
  }

  private scheduleRetry(version: number, delay: number) {
    this.clearScheduledTimer();
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (!this.autoWorkEnabled || version !== this.version) return;
      void this.startSave(version).catch(() => {});
    }, delay);
  }

  edit(draft: Draft) {
    this.clearScheduledTimer();
    this.autoWorkEnabled = true;
    this.version += 1;
    this.cancelScheduledSaveLogically();
    this.cancelDeferredSaveLogically();
    if (draft.title !== undefined) {
      if (this.draft.title === undefined && this.titleRevision) this.draft.baseTitleRevision = this.titleRevision;
      this.draft.title = draft.title;
    }
    for (const key of Object.keys(draft.modules ?? {})) {
      if (!Object.hasOwn(this.draft.modules ?? {}, key) && this.revisions[key]) {
        this.draft.baseRevisions ??= {};
        this.draft.baseRevisions[key] = this.revisions[key];
      }
    }
    this.draft.modules = { ...this.draft.modules, ...draft.modules };
    for (const key of Object.keys(this.draft.modules ?? {})) this.state.status[key] = "editing";
    this.state.phase = "dirty";
    this.state.error = "";
    this.state.attempt = 0;
    this.state.nextRetryAt = null;
    this.persist();
    this.retainTransportWait();
    this.emit();
    this.scheduleDebounce(this.version);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => {});
    return next;
  }

  private async request(body: Record<string, unknown>) {
    const controller = new AbortController();
    const watchdog = this.startTransportWatchdog();
    try {
      return await this.patch(body, controller.signal);
    } finally {
      this.finishTransportWatchdog(watchdog);
    }
  }

  private deferSaveUntilTransportDrain(version: number) {
    const existing = this.deferredSave;
    if (existing?.version === version) return existing.callerPromise;
    this.cancelDeferredSaveLogically(existing);
    const deferred = createDeferredSave(
      version,
      () => this.autoWorkEnabled && version === this.version && this.hasPending,
      () => this.startSave(version),
      (save) => { if (this.deferredSave === save) this.deferredSave = undefined; },
    );
    this.deferredSave = deferred;
    return deferred.callerPromise;
  }

  private block(error: unknown, keys: string[]) {
    for (const key of keys) this.state.status[key] = "err";
    this.state.phase = "blocked";
    this.state.error = errorMessage(error);
    this.state.nextRetryAt = null;
    this.emit();
  }

  private async saveAttempt(version: number) {
    if (!this.autoWorkEnabled || version !== this.version || !this.hasPending) return;
    if (this.state.phase === "blocked") throw new Error(this.state.error || "保存已停止，请手动重试");

    const title = this.draft.title;
    const modules = { ...this.draft.modules };
    const keys = Object.keys(modules);
    const body: Record<string, unknown> = { dataGeneration: this.dataGeneration };
    if (keys.length) body.modules = modules;
    if (keys.length && (Object.keys(this.revisions).length || this.draft.baseRevisions)) {
      body.moduleRevisions = Object.fromEntries(keys.map((key) => [key, this.draft.baseRevisions?.[key] ?? null]));
    }
    if (title !== undefined) body.title = title.trim();
    if (title !== undefined && (this.titleRevision || this.draft.baseTitleRevision)) {
      body.titleRevision = this.draft.baseTitleRevision ?? null;
    }

    if (title !== undefined && !title.trim()) {
      const error = new Error("简历标题不能为空，请填写标题后重试");
      this.block(error, keys);
      throw error;
    }

    this.state.attempt += 1;
    this.state.phase = "saving";
    this.state.error = "";
    this.state.nextRetryAt = null;
    for (const key of keys) this.state.status[key] = "saving";
    this.emit();

    try {
      const updated = await this.request(body);
      this.updateRevisions(updated);
      if (title !== undefined && this.draft.title !== undefined) {
        this.draft.baseTitleRevision = this.titleRevision;
      }
      for (const key of keys) {
        const revision = this.revisions[key];
        if (revision && Object.hasOwn(this.draft.modules ?? {}, key)) {
          this.draft.baseRevisions ??= {};
          this.draft.baseRevisions[key] = revision;
        }
      }
      this.persist();
      if (version !== this.version) return;

      if (this.draft.title === title) {
        delete this.draft.title;
        delete this.draft.baseTitleRevision;
      }
      for (const key of keys) {
        if (this.draft.modules?.[key] === modules[key]) {
          delete this.draft.modules?.[key];
          delete this.draft.baseRevisions?.[key];
          this.state.status[key] = "saved";
        }
      }
      this.state.phase = this.hasPending ? "dirty" : "saved";
      this.state.error = "";
      this.state.nextRetryAt = null;
      this.persist();
      this.emit();
      if (this.hasPending) this.scheduleDebounce(version);
    } catch (error) {
      if (version !== this.version) return;
      if (isAbortError(error)) throw error;

      for (const key of keys) this.state.status[key] = "err";
      this.state.error = errorMessage(error);
      if (isRetryable(error) && this.state.attempt < MAX_ATTEMPTS) {
        // attempt 自 1 起且受 MAX_ATTEMPTS 约束，索引必然命中
        const delay = retryDelay(this.state.attempt, this.random());
        this.state.phase = "retry-wait";
        this.state.nextRetryAt = this.now() + delay;
        this.emit();
        this.scheduleRetry(version, delay);
      } else {
        this.state.phase = "blocked";
        this.state.nextRetryAt = null;
        this.emit();
      }
      throw error;
    }
  }

  private startSaveWithMode(version: number, mode: ScheduledSave["mode"], waitForTransport = false) {
    if (!this.autoWorkEnabled || version !== this.version || !this.hasPending) return Promise.resolve();
    if (this.state.phase === "blocked") {
      return Promise.reject(new Error(this.state.error || "保存已停止，请手动重试"));
    }
    const existing = this.scheduledSave;
    if (existing?.version === version) {
      if (mode !== "direct" || existing.mode === "direct") {
        return waitForTransport ? existing.transportDrain : existing.callerPromise;
      }
      // mutate 已持有串行槽，只接管 queued operation；caller 继续等待同版本 direct transport。
      return existing.takeOverDirect();
    }
    if (mode === "queued" && this.transportWatchdog !== undefined) {
      return this.deferSaveUntilTransportDrain(version);
    }

    const scheduled = createScheduledSave(
      version,
      mode,
      () => this.autoWorkEnabled && version === this.version,
      () => this.saveAttempt(version),
      (operation) => this.enqueue(operation),
      (save) => { if (this.scheduledSave === save) this.scheduledSave = undefined; },
    );
    this.scheduledSave = scheduled;
    scheduled.start();
    return waitForTransport ? scheduled.transportDrain : scheduled.callerPromise;
  }

  private startSave(version: number) {
    return this.startSaveWithMode(version, "queued");
  }

  private startSaveDirect(version: number) {
    return this.startSaveWithMode(version, "direct", true);
  }

  flush() {
    this.autoWorkEnabled = true;
    this.clearScheduledTimer();
    return this.startSave(this.version);
  }

  /** 发布前等待结构操作及最新正文；结构操作失败须重新读取服务端后才能继续。 */
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    const lifecycle = this.lifecycle;
    let rejectCancellation!: (error: Error) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const cancel = () => rejectCancellation(cancellationError());
    this.pendingMutationCancellations.add(cancel);
    const work = (async () => {
      this.assertLifecycle(lifecycle);
      this.clearScheduledTimer();
      while (true) {
        const barrier = this.enqueue(async () => {
          this.assertLifecycle(lifecycle);
          if (this.mutationFailure) throw this.mutationFailure.error;
          await this.saveDirtyBeforeMutation(lifecycle);
          this.assertLifecycle(lifecycle);
        });
        const tail = this.tail;
        await barrier;
        this.assertLifecycle(lifecycle);
        if (tail === this.tail && !this.hasPending) return;
      }
    })();
    const completion = Promise.race([work, cancellation]);
    this.draining = completion;
    const clear = () => {
      this.pendingMutationCancellations.delete(cancel);
      if (this.draining === completion) this.draining = undefined;
    };
    completion.then(clear, clear);
    return completion;
  }

  retry() {
    this.clearScheduledTimer();
    this.autoWorkEnabled = true;
    this.version += 1;
    this.cancelScheduledSaveLogically();
    this.cancelDeferredSaveLogically();
    this.state.phase = this.hasPending ? "dirty" : this.phaseWithoutTransportWait();
    this.state.error = "";
    this.state.attempt = 0;
    this.state.nextRetryAt = null;
    for (const key of Object.keys(this.draft.modules ?? {})) this.state.status[key] = "editing";
    this.retainTransportWait();
    this.emit();
    return this.startSave(this.version);
  }

  disposeAutoWork() {
    this.clearScheduledTimer();
    this.autoWorkEnabled = false;
    this.lifecycle += 1;
    this.version += 1;
    this.cancelScheduledSaveLogically();
    this.cancelDeferredSaveLogically();
    this.cancelPendingMutationsLogically();
    this.state.phase = this.hasPending ? "dirty" : this.phaseWithoutTransportWait();
    this.state.error = "";
    this.state.attempt = 0;
    this.state.nextRetryAt = null;
    for (const key of Object.keys(this.draft.modules ?? {})) this.state.status[key] = "editing";
    this.retainTransportWait();
    this.emit();
  }

  /** 用户显式清除本机副本；先失效旧工作，晚到响应只能持久化空草稿。 */
  clearLocalDraft(): boolean {
    this.disposeAutoWork();
    this.draft = {};
    this.state.status = {};
    this.state.phase = "idle";
    this.persist();
    this.emit();
    return !this.state.storageError;
  }

  private merge<T extends ResumeDocument>(document: T): T {
    return mergeDraft(document, this.draft);
  }

  private updateRevisions(document: ResumeDocument) {
    this.titleRevision = document.resume.titleRevision;
    this.dataGeneration = document.resume.dataGeneration;
    this.revisions = Object.fromEntries(document.modules
      .filter((module) => typeof module.revision === "string")
      .map((module) => [module.key, module.revision!]));
  }

  load<T extends ResumeDocument>(read: () => Promise<T>) {
    this.autoWorkEnabled = true;
    const version = this.version;
    const lifecycle = this.lifecycle;
    return this.enqueue(async () => {
      const document = await read();
      this.updateRevisions(document);
      this.styleRevision = document.resume.styleRevision;
      if (lifecycle === this.lifecycle) this.mutationFailure = undefined;
      const loaded = this.merge(document);
      if (lifecycle === this.lifecycle && this.autoWorkEnabled
        && version === this.version && this.hasPending && this.state.phase === "dirty") {
        this.scheduleDebounce(version);
      }
      return loaded;
    });
  }

  private async saveDirtyBeforeMutation(lifecycle: number) {
    this.clearScheduledTimer();
    while (this.hasPending) {
      this.assertLifecycle(lifecycle);
      const version = this.version;
      await this.startSaveDirect(version);
      this.assertLifecycle(lifecycle);
      if (version === this.version && this.state.phase === "blocked") {
        throw new Error(this.state.error || "保存已停止，请手动重试");
      }
    }
  }

  mutate(body: Record<string, unknown>, apply: (document: ResumeDocument) => void = () => {}) {
    const lifecycle = this.lifecycle;
    let logicallyCancelled = false;
    let rejectCancellation!: (error: Error) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    void cancellation.catch(() => {});
    const cancelLogically = () => {
      if (logicallyCancelled) return;
      logicallyCancelled = true;
      rejectCancellation(cancellationError());
    };
    this.pendingMutationCancellations.add(cancelLogically);
    const transportDrain = this.enqueue(async () => {
      this.assertLifecycle(lifecycle);
      await this.saveDirtyBeforeMutation(lifecycle);
      this.assertLifecycle(lifecycle);
      const changesStyle = Object.hasOwn(body, "styleOverrides");
      const updated = await this.request({ ...body, dataGeneration: this.dataGeneration,
        ...(changesStyle ? { styleRevision: this.styleRevision } : {}),
      });
      // 其他字段的回包可能带有别页新排版；未显示的排版不能推进本页保存基线。
      if (changesStyle) this.styleRevision = updated.resume.styleRevision;
      this.updateRevisions(updated);
      this.assertLifecycle(lifecycle);
      if (typeof body.removeModule === "string") {
        delete this.draft.modules?.[body.removeModule];
        delete this.draft.baseRevisions?.[body.removeModule];
        this.persist();
      }
      const merged = this.merge(updated);
      apply(merged);
      return merged;
    }).catch((error: unknown) => {
      if (lifecycle === this.lifecycle) this.mutationFailure = { error };
      throw error;
    });
    const callerPromise = Promise.race([transportDrain, cancellation]);
    const clear = () => { this.pendingMutationCancellations.delete(cancelLogically); };
    callerPromise.then(clear, clear);
    return callerPromise;
  }
}
