/** Transport/parsed-content metadata only; never contains response text or configuration. */
export type LlmRequestProgress = {
  requestIndex: number;
  attempt: number;
  stream: boolean;
  phase: "started" | "headers" | "first-byte" | "first-content" | "ended";
  elapsedMs: number;
  httpStatus: number | null;
  headersMs: number | null;
  firstByteMs: number | null;
  lastByteMs: number | null;
  responseBytes: number;
  firstContentMs: number | null;
  lastContentMs: number | null;
  contentBytes: number;
  /** complete means reply parsing returned non-empty text, before requireJson/business validation. */
  outcome: "complete" | "error" | null;
  /** First request cancellation source. client includes a caller-supplied evaluation deadline. */
  abortKind: "client" | "idle" | "total" | null;
};

export type LlmProgressObserver = (progress: Readonly<LlmRequestProgress>) => void | Promise<void>;

/** At most five notifications per request; observer failures cannot alter the call. */
export function observeLlmRequest(
  identity: Pick<LlmRequestProgress, "requestIndex" | "attempt" | "stream">,
  observer?: LlmProgressObserver,
) {
  if (!observer) return;
  const started = performance.now();
  const elapsed = () => Math.max(0, performance.now() - started);
  const state = {
    ...identity, httpStatus: null, headersMs: null, firstByteMs: null, lastByteMs: null,
    responseBytes: 0, firstContentMs: null, lastContentMs: null, contentBytes: 0,
    outcome: null, abortKind: null,
  } as Omit<LlmRequestProgress, "phase" | "elapsedMs">;
  const emit = (phase: LlmRequestProgress["phase"]) => {
    // Copy primitives; neither mutation nor an unresolved Promise affects reader state.
    try { void Promise.resolve(observer({ ...state, phase, elapsedMs: elapsed() })).catch(() => {}); } catch {}
  };
  emit("started");
  return {
    headers(status: number) { state.httpStatus = status; state.headersMs = elapsed(); emit("headers"); },
    bytes(count: number) {
      if (count <= 0) return;
      state.responseBytes += count;
      state.lastByteMs = elapsed();
      if (state.firstByteMs === null) { state.firstByteMs = state.lastByteMs; emit("first-byte"); }
    },
    content(count: number) {
      if (count <= 0) return;
      state.contentBytes += count;
      state.lastContentMs = elapsed();
      if (state.firstContentMs === null) { state.firstContentMs = state.lastContentMs; emit("first-content"); }
    },
    end(outcome: "complete" | "error", abortKind: LlmRequestProgress["abortKind"]) {
      state.outcome = outcome; state.abortKind = abortKind; emit("ended");
    },
  };
}
