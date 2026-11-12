import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const RENAME_RETRY_COUNT = 5;
const RENAME_RETRY_DELAY_MS = 100;
const WINDOWS_RENAME_LOCK_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);

export function removeWebappDirectory(
  directory: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform === "win32") {
    // Windows can retain file locks briefly after a process or guest exits.
    return fs.promises.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
  }
  if (platform === "darwin") {
    return fs.promises.rm(directory, { recursive: true, force: true });
  }
  return fs.promises.rm(directory, { recursive: true, force: true });
}

export async function renameWebappPath(
  sourcePath: string,
  targetPath: string,
  platform: NodeJS.Platform = process.platform
) {
  if (platform === "darwin") {
    await fs.promises.rename(sourcePath, targetPath);
    return;
  }
  if (platform !== "win32") {
    await fs.promises.rename(sourcePath, targetPath);
    return;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.rename(sourcePath, targetPath);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "";
      if (attempt >= RENAME_RETRY_COUNT || typeof code !== "string" || !WINDOWS_RENAME_LOCK_CODES.has(code)) {
        throw error;
      }
      // Let Electron finish releasing handles while Windows retains a short lock.
      await delay(RENAME_RETRY_DELAY_MS);
    }
  }
}
