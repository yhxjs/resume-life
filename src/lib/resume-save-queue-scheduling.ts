export type ScheduledSave = {
  version: number;
  mode: "queued" | "direct";
  transportDrain: Promise<void>;
  callerPromise: Promise<void>;
  cancelLogically: () => void;
  takeOverDirect: () => Promise<void>;
  start: () => void;
};

export type DeferredSave = {
  version: number;
  callerPromise: Promise<void>;
  cancelLogically: () => void;
  start: () => void;
};

export function cancellationError() {
  const error = new Error("保存操作已取消");
  error.name = "AbortError";
  return error;
}

export function createDeferredSave(
  version: number,
  canStart: () => boolean,
  startSave: () => Promise<void>,
  onSettled: (save: DeferredSave) => void,
): DeferredSave {
  let logicallyCancelled = false;
  let started = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: unknown) => void;
  let rejectCancellation!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  void cancellation.catch(() => {});
  const deferred: DeferredSave = {
    version,
    callerPromise: Promise.resolve(),
    cancelLogically: () => {
      if (logicallyCancelled) return;
      logicallyCancelled = true;
      rejectCancellation(cancellationError());
    },
    start: () => {
      if (started) return;
      started = true;
      onSettled(deferred);
      if (logicallyCancelled || !canStart()) {
        rejectCompletion(cancellationError());
        return;
      }
      startSave().then(resolveCompletion, rejectCompletion);
    },
  };
  deferred.callerPromise = Promise.race([completion, cancellation]);
  deferred.callerPromise.then(() => onSettled(deferred), () => onSettled(deferred));
  return deferred;
}

export function createScheduledSave(
  version: number,
  mode: ScheduledSave["mode"],
  canRun: () => boolean,
  saveAttempt: () => Promise<void>,
  enqueue: (operation: () => Promise<void>) => Promise<void>,
  onSettled: (save: ScheduledSave) => void,
): ScheduledSave {
  let logicallyCancelled = false;
  let queuedOperationCancelled = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  void cancellation.catch(() => {});
  const operation = () => {
    if (logicallyCancelled || !canRun()) return Promise.resolve();
    return saveAttempt();
  };
  const completeFrom = (transport: Promise<void>) => {
    transport.then(resolveCompletion, rejectCompletion);
    return transport;
  };
  const scheduled: ScheduledSave = {
    version,
    mode,
    transportDrain: Promise.resolve(),
    callerPromise: Promise.resolve(),
    cancelLogically: () => {
      if (logicallyCancelled) return;
      logicallyCancelled = true;
      queuedOperationCancelled = true;
      rejectCancellation(cancellationError());
    },
    takeOverDirect: () => {
      if (scheduled.mode === "direct") return scheduled.transportDrain;
      queuedOperationCancelled = true;
      scheduled.mode = "direct";
      scheduled.transportDrain = completeFrom(operation());
      return scheduled.transportDrain;
    },
    start: () => {
      scheduled.transportDrain = mode === "queued"
        ? enqueue(() => queuedOperationCancelled ? Promise.resolve() : completeFrom(operation()))
        : completeFrom(operation());
    },
  };
  scheduled.callerPromise = Promise.race([completion, cancellation]);
  scheduled.callerPromise.then(() => onSettled(scheduled), () => onSettled(scheduled));
  return scheduled;
}
