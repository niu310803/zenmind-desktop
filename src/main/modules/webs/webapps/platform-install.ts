import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { getDesktopWebappStateRoot, getDesktopWebappInstallStagingRoot } from "../../../infrastructure/filesystem/user-paths";
import { PLATFORM_PACKAGE_ENTRIES, webappPlatformLayout, readPlatformProcessSnapshot, platformProcessIsAlive } from "./platform-layout";
import { removeWebappDirectory, renameWebappPath } from "./remove-directory";

export type PlatformInstallTransaction = {
  schemaVersion: 2; id: string; phase: "prepared" | "activated" | "rolling-back" | "committed";
  installPath: string; stagingPath: string; backupPath: string;
  entries: { name: string; hadExisting: boolean }[];
};
const activeInstalls = new Set<string>();
const journalPath = (app: App, id: string) => path.join(getDesktopWebappStateRoot(app, id), "platform-install.json");
export const releasePlatformInstall = (app: App, id: string) => activeInstalls.delete(journalPath(app, id));
export const hasActivePlatformInstall = (app: App, id: string) => activeInstalls.has(journalPath(app, id));
export const hasPendingPlatformInstall = (app: App, id: string) => fs.existsSync(journalPath(app, id));

async function write(app: App, tx: PlatformInstallTransaction, exclusive = false) {
  const file = journalPath(app, tx.id);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  if (exclusive) {
    await fs.promises.writeFile(file, JSON.stringify(tx), { flag: "wx" });
    return;
  }
  const temporary = `${file}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(tx), { flag: "wx" });
    await renameWebappPath(temporary, file);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function activatePlatformInstall(app: App, id: string, stagingPath: string): Promise<PlatformInstallTransaction> {
  if (hasActivePlatformInstall(app, id) || hasPendingPlatformInstall(app, id)) {
    throw new Error("A Platform install is in progress or pending recovery.");
  }
  const layout = webappPlatformLayout(app, id);
  await fs.promises.mkdir(path.join(layout.runtime, ".staging"), { recursive: true });
  const backupPath = await fs.promises.mkdtemp(path.join(layout.runtime, ".staging", "install-"));
  const tx: PlatformInstallTransaction = {
    schemaVersion: 2, id, phase: "prepared", installPath: layout.runtime, stagingPath, backupPath,
    entries: PLATFORM_PACKAGE_ENTRIES.map(name => ({ name, hadExisting: fs.existsSync(path.join(layout.runtime, name)) }))
  };
  await write(app, tx, true);
  activeInstalls.add(journalPath(app, id));
  try {
    for (const entry of tx.entries) {
      if (entry.hadExisting) await renameWebappPath(path.join(tx.installPath, entry.name), path.join(backupPath, entry.name));
      const incoming = path.join(stagingPath, entry.name);
      if (fs.existsSync(incoming)) await renameWebappPath(incoming, path.join(tx.installPath, entry.name));
    }
    await write(app, { ...tx, phase: "activated" });
    tx.phase = "activated";
    return tx;
  } catch (error) {
    try {
      await rollbackPlatformInstall(app, tx);
    } catch (restoreError) {
      console.warn("failed to restore Platform WebApp after activation error", id, restoreError);
    } finally {
      releasePlatformInstall(app, id);
    }
    throw error;
  }
}

export async function markPlatformInstallRollback(app: App, tx: PlatformInstallTransaction) {
  if (tx.phase === "committed") throw new Error("Cannot roll back a committed Platform install.");
  if (tx.phase === "rolling-back") return;
  await write(app, { ...tx, phase: "rolling-back" });
  tx.phase = "rolling-back";
}

export async function rollbackPlatformInstall(app: App, tx: PlatformInstallTransaction) {
  await markPlatformInstallRollback(app, tx);
  // Filesystem evidence makes per-entry rollback resumable after interrupted renames.
  for (const entry of tx.entries) {
    const current = path.join(tx.installPath, entry.name), backup = path.join(tx.backupPath, entry.name);
    if (fs.existsSync(backup)) {
      await removeWebappDirectory(current);
      await renameWebappPath(backup, current);
    } else if (!entry.hadExisting) {
      await removeWebappDirectory(current);
    } else if (!fs.existsSync(current)) {
      throw new Error(`Cannot restore Platform package entry: ${entry.name}`);
    }
  }
  await removeWebappDirectory(tx.stagingPath);
  await removeWebappDirectory(tx.backupPath);
  await fs.promises.rm(journalPath(app, tx.id), { force: true });
  releasePlatformInstall(app, tx.id);
}

export async function commitPlatformInstall(app: App, tx: PlatformInstallTransaction) {
  await write(app, { ...tx, phase: "committed" });
  tx.phase = "committed";
  try {
    await removeWebappDirectory(tx.backupPath);
    await removeWebappDirectory(tx.stagingPath);
    await fs.promises.rm(journalPath(app, tx.id), { force: true });
  } catch (error) {
    // The candidate is already committed. Retain the journal for cleanup, never roll it back.
    console.warn("failed to clean committed Platform WebApp install", tx.id, error);
  } finally {
    releasePlatformInstall(app, tx.id);
  }
}

export function readPlatformInstallTransaction(app: App, id: string): PlatformInstallTransaction | null {
  const file = journalPath(app, id);
  if (!fs.existsSync(file)) return null;
  const tx = JSON.parse(fs.readFileSync(file, "utf8")) as PlatformInstallTransaction;
  const layout = webappPlatformLayout(app, id);
  const inside = (root: string, candidate: string) => {
    if (typeof candidate !== "string") return false;
    const rel = path.relative(root, candidate);
    return rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  if (tx.schemaVersion !== 2 || tx.id !== id || tx.installPath !== layout.runtime || !inside(path.join(layout.runtime, ".staging"), tx.backupPath) || !inside(getDesktopWebappInstallStagingRoot(app), tx.stagingPath) ||
    !["prepared", "activated", "rolling-back", "committed"].includes(tx.phase) || !Array.isArray(tx.entries) || tx.entries.length !== PLATFORM_PACKAGE_ENTRIES.length ||
    tx.entries.some((entry, index) => !entry || entry.name !== PLATFORM_PACKAGE_ENTRIES[index] || typeof entry.hadExisting !== "boolean")) throw new Error(`Invalid Platform install journal: ${file}`);
  for (const dir of [layout.root, layout.runtime, path.join(layout.runtime, ".staging"), tx.backupPath, tx.stagingPath]) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Symbolic link in Platform install journal: ${dir}`);
  }
  return tx;
}

export async function recoverPlatformInstall(app: App, id: string) {
  if (hasActivePlatformInstall(app, id)) return false;
  const tx = readPlatformInstallTransaction(app, id);
  if (!tx) return false;
  if (tx.phase !== "committed") {
    let pid = 0;
    const runtimeState = path.join(getDesktopWebappStateRoot(app, id), "runtime.json");
    if (fs.existsSync(runtimeState)) pid = JSON.parse(fs.readFileSync(runtimeState, "utf8")).pid ?? 0;
    if ((Number.isSafeInteger(pid) && pid > 0 && platformProcessIsAlive(pid)) || readPlatformProcessSnapshot(app, id).some(platformProcessIsAlive)) throw new Error("Stop the independent Platform process tree before recovering its install journal.");
  }
  if (tx.phase === "committed") await commitPlatformInstall(app, tx);
  else await rollbackPlatformInstall(app, tx);
  return true;
}
