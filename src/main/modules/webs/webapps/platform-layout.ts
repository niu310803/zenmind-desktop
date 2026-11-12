import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { getDesktopRoot } from "../../../infrastructure/filesystem/user-paths";
import { assertInstalledWebappId } from "./identity";

export const PLATFORM_PACKAGE_ENTRIES = ["webapp.json", "assets", "frontend", "backend", "agents", "skills-center", "connectors-center"] as const;

export function webappPlatformsRoot(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopRoot(app, platform), "data", "webapp-platforms");
}
export function webappPlatformLayout(app: App, id: string, platform: NodeJS.Platform = process.platform) {
  const root = path.join(webappPlatformsRoot(app, platform), assertInstalledWebappId(id));
  return { root, runtime: path.join(root, "runtime"), config: path.join(root, "config"), run: path.join(root, "run"), ready: path.join(root, "run", "ready.json"), processes: path.join(root, "run", "process-tree.json"), logs: path.join(root, "logs") };
}

export function readPlatformProcessSnapshot(app: App, id: string): number[] {
  const file = webappPlatformLayout(app, id).processes;
  if (!fs.existsSync(file)) return [];
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as { schemaVersion: number; pids: number[] };
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.pids) || snapshot.pids.length > 10000 || snapshot.pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error("Invalid independent Platform process snapshot.");
  return snapshot.pids;
}
export function platformProcessIsAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
