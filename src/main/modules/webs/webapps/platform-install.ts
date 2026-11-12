import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { getDesktopWebappStateRoot, getDesktopWebappInstallStagingRoot } from "../../../infrastructure/filesystem/user-paths";
import { PLATFORM_PACKAGE_ENTRIES, webappPlatformLayout, readPlatformProcessSnapshot, platformProcessIsAlive } from "./platform-layout";

export type PlatformInstallTransaction = {
  schemaVersion: 2; id: string; phase: "prepared" | "activated" | "committed";
  installPath: string; stagingPath: string; backupPath: string;
  entries: { name: string; hadExisting: boolean }[];
};
const activeInstalls = new Set<string>();
export const releasePlatformInstall = (app: App, id: string) => activeInstalls.delete(journalPath(app, id));
export const hasActivePlatformInstall = (app: App, id: string) => activeInstalls.has(journalPath(app, id));
const journalPath = (app: App, id: string) => path.join(getDesktopWebappStateRoot(app, id), "platform-install.json");
function write(app: App, tx: PlatformInstallTransaction) {
  const file = journalPath(app, tx.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(tx));
  fs.renameSync(`${file}.tmp`, file);
}
function moveEntry(source: string, destination: string) {
  // Windows can transiently retain handles after a verified process exit.
  const attempts = process.platform === "win32" ? 5 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { fs.renameSync(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt === attempts - 1 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
export function activatePlatformInstall(app: App, id: string, stagingPath: string): PlatformInstallTransaction {
  if (hasActivePlatformInstall(app, id)) throw new Error("A Platform install is already in progress.");
  recoverPlatformInstall(app, id);
  const layout = webappPlatformLayout(app, id);
  fs.mkdirSync(path.join(layout.runtime, ".staging"), { recursive: true });
  const backupPath = fs.mkdtempSync(path.join(layout.runtime, ".staging", "install-"));
  const tx: PlatformInstallTransaction = { schemaVersion: 2, id, phase: "prepared", installPath: layout.runtime, stagingPath, backupPath,
    entries: PLATFORM_PACKAGE_ENTRIES.map(name => ({ name, hadExisting: fs.existsSync(path.join(layout.runtime, name)) })) };
  write(app, tx);
  activeInstalls.add(journalPath(app, id));
  try {
    for (const entry of tx.entries) {
      if (entry.hadExisting) moveEntry(path.join(tx.installPath, entry.name), path.join(backupPath, entry.name));
      const incoming = path.join(stagingPath, entry.name);
      if (fs.existsSync(incoming)) moveEntry(incoming, path.join(tx.installPath, entry.name));
    }
    tx.phase = "activated"; write(app, tx); return tx;
  } catch (error) { rollbackPlatformInstall(app, tx); throw error; }
}
export function rollbackPlatformInstall(app: App, tx: PlatformInstallTransaction) {
  // Filesystem evidence makes rollback resumable even after interruption between renames.
  for (const entry of tx.entries) {
    const current = path.join(tx.installPath, entry.name), backup = path.join(tx.backupPath, entry.name);
    if (fs.existsSync(backup)) {
      fs.rmSync(current, { recursive: true, force: true });
      moveEntry(backup, current);
    } else if (!entry.hadExisting) fs.rmSync(current, { recursive: true, force: true });
  }
  fs.rmSync(tx.stagingPath, { recursive: true, force: true });
  fs.rmSync(journalPath(app, tx.id), { force: true });
  activeInstalls.delete(journalPath(app, tx.id));
  fs.rmSync(tx.backupPath, { recursive: true, force: true });
}
export function commitPlatformInstall(app: App, tx: PlatformInstallTransaction) {
  tx.phase = "committed"; write(app, tx);
  fs.rmSync(tx.backupPath, { recursive: true, force: true });
  fs.rmSync(tx.stagingPath, { recursive: true, force: true });
  fs.rmSync(journalPath(app, tx.id), { force: true });
  activeInstalls.delete(journalPath(app, tx.id));
}
export function recoverPlatformInstall(app: App, id: string) {
  const file = journalPath(app, id);
  if (!fs.existsSync(file)) return false;
  const tx = JSON.parse(fs.readFileSync(file, "utf8")) as PlatformInstallTransaction;
  const layout = webappPlatformLayout(app, id);
  const inside = (root: string, candidate: string) => { const rel = path.relative(root, candidate); return rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
  if (tx.schemaVersion !== 2 || tx.id !== id || tx.installPath !== layout.runtime || !inside(path.join(layout.runtime, ".staging"), tx.backupPath) || !inside(getDesktopWebappInstallStagingRoot(app), tx.stagingPath) ||
    !["prepared", "activated", "committed"].includes(tx.phase) || !Array.isArray(tx.entries) || tx.entries.length !== PLATFORM_PACKAGE_ENTRIES.length ||
    tx.entries.some((entry, index) => entry.name !== PLATFORM_PACKAGE_ENTRIES[index] || typeof entry.hadExisting !== "boolean")) throw new Error(`Invalid Platform install journal: ${file}`);
  for (const dir of [layout.root, layout.runtime, path.join(layout.runtime, ".staging"), tx.backupPath, tx.stagingPath]) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Symbolic link in Platform install journal: ${dir}`);
  }
  if (tx.phase !== "committed") {
    let pid = 0;
    const runtimeState = path.join(getDesktopWebappStateRoot(app, id), "runtime.json");
    if (fs.existsSync(runtimeState)) pid = JSON.parse(fs.readFileSync(runtimeState, "utf8")).pid ?? 0;
    if ((Number.isSafeInteger(pid) && pid > 0 && platformProcessIsAlive(pid)) || readPlatformProcessSnapshot(app, id).some(platformProcessIsAlive)) throw new Error("Stop the independent Platform process tree before recovering its install journal.");
  }
  if (tx.phase === "committed") commitPlatformInstall(app, tx);
  else rollbackPlatformInstall(app, tx);
  return true;
}
