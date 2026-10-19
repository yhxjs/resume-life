export function errorMessage(error: unknown, fallback = "操作失败，请重试"): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error || fallback;
  return fallback;
}
