export function cleanupErrorMessage(error: unknown): string {
  if (error instanceof Error) return "Error";
  if (error === null) return "null";
  return typeof error;
}
