import fs from "node:fs";

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
