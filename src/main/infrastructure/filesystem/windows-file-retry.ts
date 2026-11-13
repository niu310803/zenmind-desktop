import { setTimeout as delay } from "node:timers/promises";

export function isWindowsFileLock(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

export async function retryWindowsFileOperation<T>(platform: NodeJS.Platform, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (platform !== "win32" || !isWindowsFileLock(error) || attempt >= 4) {
        throw error;
      }
      await delay(40 * 2 ** attempt);
    }
  }
}
