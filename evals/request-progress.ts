import type { LlmRequestProgress } from "@/lib/llm-request-progress";

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return nonnegativeNumber(value) && Number.isSafeInteger(value);
}

function nullableTime(value: unknown): value is number | null {
  return value === null || nonnegativeNumber(value);
}

/** Copy only finite metadata primitives; malformed diagnostics must not affect the model call. */
function parseProgress(value: unknown): LlmRequestProgress | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { requestIndex, attempt, stream, phase, elapsedMs, httpStatus, headersMs, firstByteMs, lastByteMs,
      responseBytes, firstContentMs, lastContentMs, contentBytes, outcome, abortKind } = value as LlmRequestProgress;
    if (!nonnegativeInteger(requestIndex) || requestIndex >= 16 || !nonnegativeInteger(attempt)
      || typeof stream !== "boolean" || !["started", "headers", "first-byte", "first-content", "ended"].includes(phase)
      || !nonnegativeNumber(elapsedMs)
      || !(httpStatus === null || (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599))
      || ![headersMs, firstByteMs, lastByteMs, firstContentMs, lastContentMs].every(nullableTime)
      || !nonnegativeInteger(responseBytes) || !nonnegativeInteger(contentBytes)
      || !(outcome === null || outcome === "complete" || outcome === "error")
      || !(abortKind === null || abortKind === "client" || abortKind === "idle" || abortKind === "total")) return null;
    return { requestIndex, attempt, stream, phase, elapsedMs, httpStatus, headersMs, firstByteMs, lastByteMs,
      responseBytes, firstContentMs, lastContentMs, contentBytes, outcome, abortKind };
  } catch {
    // Even a diagnostic object with throwing getters cannot turn a valid response into an error.
    return null;
  }
}

/** Keep the latest snapshot for at most 16 requests, without sparse arrays or post-call updates. */
export function createEvaluationRequestProgress() {
  const requests: LlmRequestProgress[] = [];
  let closed = false;
  return {
    requests,
    onProgress(value: unknown) {
      if (closed) return;
      const event = parseProgress(value);
      if (!event) return;
      const index = requests.findIndex(request => request.requestIndex === event.requestIndex);
      if (index < 0) {
        requests.push(event);
        requests.sort((left, right) => left.requestIndex - right.requestIndex);
      } else if (requests[index]?.phase !== "ended") {
        requests[index] = event;
      }
    },
    close() { closed = true; },
  };
}
