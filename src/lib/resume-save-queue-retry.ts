import { HttpError } from "@/lib/fetcher";

const RETRY_BASE_DELAYS = [1_000, 2_000, 4_000, 8_000];

export function isRetryable(error: unknown) {
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status <= 599);
  }
  return error instanceof Error && error.name !== "AbortError";
}

export function retryDelay(attempt: number, random: number): number {
  const baseDelay = RETRY_BASE_DELAYS[attempt - 1] ?? RETRY_BASE_DELAYS[RETRY_BASE_DELAYS.length - 1]!;
  return baseDelay * (0.9 + random * 0.2);
}
