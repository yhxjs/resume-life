import { logServerEvent } from "@/lib/server-errors";

let restoreCleanupTimer: ReturnType<typeof setInterval> | undefined;

export async function logNodeStartup(): Promise<void> {
  logServerEvent("info", "startup", {
    context: {
      node: process.version,
      platform: process.platform,
    },
  });
  const { cleanupStaleRestoreDirectories } = await import("@/lib/backup-staging-cleanup");
  cleanupStaleRestoreDirectories();
  if (!restoreCleanupTimer) {
    restoreCleanupTimer = setInterval(cleanupStaleRestoreDirectories, 60 * 60 * 1000);
    restoreCleanupTimer.unref();
  }
}
