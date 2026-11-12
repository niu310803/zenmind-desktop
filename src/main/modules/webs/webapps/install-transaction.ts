import { releasePlatformInstall, activatePlatformInstall, commitPlatformInstall, rollbackPlatformInstall, recoverPlatformInstall, readPlatformInstallTransaction, hasPendingPlatformInstall, markPlatformInstallRollback, type PlatformInstallTransaction } from "./platform-install";
import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import {
  getDesktopWebappInstallBackupRoot,
  getDesktopWebappInstallStagingRoot,
  getDesktopWebappStateRoot,
  getDesktopWebappsDataRoot,
  getDesktopWebappsStateRoot
} from "../../../infrastructure/filesystem/user-paths";
import { removeWebappDirectory, renameWebappPath } from "./remove-directory";

const TRANSACTION_FILE = "install-transaction.json";
const RENAME_RETRY_COUNT = 5;

type InstallTransactionPhase = "prepared" | "backed-up" | "activated" | "rolling-back";

type DesktopInstallTransaction = {
  schemaVersion: 1;
  id: string;
  phase: InstallTransactionPhase;
  hadExisting: boolean;
  installPath: string;
  stagingPath: string;
  backupPath: string;
  updatedAt: string;
};

export type WebappInstallTransaction = DesktopInstallTransaction | PlatformInstallTransaction;

function transactionPath(app: App, id: string) {
  return path.join(getDesktopWebappStateRoot(app, id), TRANSACTION_FILE);
}

export function hasPendingWebappInstallTransaction(app: App, id: string) {
  return fs.existsSync(transactionPath(app, id)) || hasPendingPlatformInstall(app, id);
}

async function writeTransaction(app: App, transaction: DesktopInstallTransaction, exclusive = false) {
  const filePath = transactionPath(app, transaction.id);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const content = `${JSON.stringify(transaction, null, 2)}\n`;
  if (exclusive) {
    await fs.promises.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
    return;
  }
  const temporaryPath = `${filePath}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await renameWithRetry(temporaryPath, filePath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch((cleanupError) => {
      console.warn("failed to clean temporary WebApp install journal", transaction.id, cleanupError);
    });
    throw error;
  }
}

async function setTransactionPhase(
  app: App,
  transaction: DesktopInstallTransaction,
  phase: InstallTransactionPhase
) {
  const updated = { ...transaction, phase, updatedAt: new Date().toISOString() };
  await writeTransaction(app, updated);
  Object.assign(transaction, updated);
}

const renameWithRetry = renameWebappPath;

function removeIfExists(targetPath: string) {
  return removeWebappDirectory(targetPath);
}

function pathIsInside(parentPath: string, candidatePath: string) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function isSafeTransaction(app: App, transaction: DesktopInstallTransaction) {
  const expectedInstallPath = path.join(getDesktopWebappsDataRoot(app), transaction.id);
  return path.resolve(transaction.installPath) === path.resolve(expectedInstallPath) &&
    pathIsInside(getDesktopWebappInstallStagingRoot(app), transaction.stagingPath) &&
    pathIsInside(getDesktopWebappInstallBackupRoot(app), transaction.backupPath);
}

export async function markWebappInstallRollback(app: App, transaction: WebappInstallTransaction) {
  if (transaction.schemaVersion === 2) return markPlatformInstallRollback(app, transaction);
  if (transaction.phase === "rolling-back") return;
  await setTransactionPhase(app, transaction, "rolling-back");
}

export async function activateWebappInstall(options: {
  app: App;
  id: string;
  installPath: string;
  stagingPath: string;
  hosting?: "desktop" | "platform";
}) {
  if (hasPendingWebappInstallTransaction(options.app, options.id)) {
    throw new Error(`Cannot install WebApp ${options.id}: an installation transaction is pending recovery.`);
  }
  if (options.hosting === "platform") return activatePlatformInstall(options.app, options.id, options.stagingPath);
  const backupRoot = getDesktopWebappInstallBackupRoot(options.app);
  await fs.promises.mkdir(backupRoot, { recursive: true });
  const backupPath = path.join(
    backupRoot,
    `${options.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const transaction: DesktopInstallTransaction = {
    schemaVersion: 1,
    id: options.id,
    phase: "prepared",
    hadExisting: fs.existsSync(options.installPath),
    installPath: options.installPath,
    stagingPath: options.stagingPath,
    backupPath,
    updatedAt: new Date().toISOString()
  };
  // Never overwrite recovery evidence left by a failed or competing install.
  await writeTransaction(options.app, transaction, true);

  try {
    if (fs.existsSync(options.installPath)) {
      await renameWithRetry(options.installPath, backupPath);
    }
    await setTransactionPhase(options.app, transaction, "backed-up");

    await renameWithRetry(options.stagingPath, options.installPath);
    await setTransactionPhase(options.app, transaction, "activated");
    return transaction;
  } catch (error) {
    try {
      await rollbackWebappInstall(options.app, transaction);
    } catch (restoreError) {
      console.warn("failed to restore WebApp after install activation error", options.id, restoreError);
    }
    throw error;
  }
}

export function preserveWebappInstallForRecovery(app: App, transaction: WebappInstallTransaction) {
  if (transaction.schemaVersion === 2) releasePlatformInstall(app, transaction.id);
}

export async function commitWebappInstall(app: App, transaction: WebappInstallTransaction) {
  if (transaction.schemaVersion === 2) return commitPlatformInstall(app, transaction);
  let cleaned = true;
  for (const targetPath of [transaction.backupPath, transaction.stagingPath]) {
    try {
      await removeIfExists(targetPath);
    } catch (error) {
      cleaned = false;
      console.warn("failed to clean committed WebApp install artifact", transaction.id, targetPath, error);
    }
  }
  // A later startup must still be able to find artifacts whose locks outlived commit.
  if (!cleaned) return;
  try {
    await fs.promises.rm(transactionPath(app, transaction.id), { force: true });
  } catch (error) {
    console.warn("failed to remove committed WebApp install journal", transaction.id, error);
  }
}

export async function rollbackWebappInstall(app: App, transaction: WebappInstallTransaction) {
  if (transaction.schemaVersion === 2) return rollbackPlatformInstall(app, transaction);
  if (transaction.phase === "prepared" && !fs.existsSync(transaction.backupPath)) {
    if (transaction.hadExisting && !fs.existsSync(transaction.installPath)) {
      throw new Error(`Cannot rollback WebApp ${transaction.id}: original directory is missing.`);
    }
    await removeIfExists(transaction.stagingPath);
    await fs.promises.rm(transactionPath(app, transaction.id), { force: true });
    return;
  }
  await markWebappInstallRollback(app, transaction);
  if (fs.existsSync(transaction.backupPath)) {
    await removeIfExists(transaction.installPath);
    // With the failed package gone, prepared recovery can restore the backup
    // whether the process exits before or after the rename below.
    await setTransactionPhase(app, transaction, "prepared");
    await renameWithRetry(transaction.backupPath, transaction.installPath);
  } else if (!transaction.hadExisting) {
    await removeIfExists(transaction.installPath);
    await setTransactionPhase(app, transaction, "prepared");
  } else {
    throw new Error(`Cannot rollback WebApp ${transaction.id}: backup directory is missing.`);
  }
  await removeIfExists(transaction.stagingPath);
  await fs.promises.rm(transactionPath(app, transaction.id), { force: true });
}

function readTransaction(filePath: string): DesktopInstallTransaction | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DesktopInstallTransaction>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.id !== "string" ||
      (value.phase !== "prepared" && value.phase !== "backed-up" && value.phase !== "activated" && value.phase !== "rolling-back") ||
      typeof value.installPath !== "string" ||
      typeof value.stagingPath !== "string" ||
      typeof value.backupPath !== "string"
    ) {
      return null;
    }
    return {
      ...value,
      hadExisting: value.hadExisting === true
    } as DesktopInstallTransaction;
  } catch {
    return null;
  }
}

function isSameTransaction(left: DesktopInstallTransaction, right: DesktopInstallTransaction) {
  return left.id === right.id && left.phase === right.phase && left.hadExisting === right.hadExisting &&
    left.installPath === right.installPath && left.stagingPath === right.stagingPath &&
    left.backupPath === right.backupPath && left.updatedAt === right.updatedAt;
}

export async function recoverWebappInstallTransactions(
  app: App,
  options: { beforeRecovery?: (transaction: WebappInstallTransaction) => Promise<boolean> } = {}
) {
  const stateRoot = getDesktopWebappsStateRoot(app);
  if (!fs.existsSync(stateRoot)) {
    return [];
  }
  const recovered: string[] = [];
  for (const entry of await fs.promises.readdir(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const platformTransaction = readPlatformInstallTransaction(app, entry.name);
      if (platformTransaction && (!options.beforeRecovery || await options.beforeRecovery(platformTransaction))) {
        if (await recoverPlatformInstall(app, entry.name)) recovered.push(entry.name);
      }
    } catch (error) {
      console.warn("failed to recover Platform WebApp install transaction", entry.name, error);
    }
    const filePath = path.join(stateRoot, entry.name, TRANSACTION_FILE);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    let transaction = readTransaction(filePath);
    if (
      !transaction ||
      transaction.id !== entry.name ||
      !isSafeTransaction(app, transaction)
    ) {
      // An exclusive journal creation can still be writing its first bytes.
      // Malformed or unsafe evidence must never be deleted by recovery.
      console.warn("ignored invalid WebApp install transaction journal", filePath);
      continue;
    }
    try {
      if (options.beforeRecovery && !await options.beforeRecovery(transaction)) continue;
      const current = readTransaction(filePath);
      // Admission may wait for runtime cleanup. Do not apply an old snapshot to
      // a journal another operation has replaced or already completed.
      if (!current || !isSameTransaction(transaction, current) || !isSafeTransaction(app, current)) continue;
      transaction = current;
      if (transaction.phase === "rolling-back") {
        await rollbackWebappInstall(app, transaction);
      } else {
        if (!fs.existsSync(transaction.installPath) && fs.existsSync(transaction.backupPath)) {
          await renameWithRetry(transaction.backupPath, transaction.installPath);
        } else if (fs.existsSync(transaction.installPath)) {
          await removeIfExists(transaction.backupPath);
        }
        await removeIfExists(transaction.stagingPath);
        await fs.promises.rm(filePath, { force: true });
      }
      recovered.push(transaction.id);
    } catch (error) {
      console.warn("failed to recover WebApp install transaction", transaction.id, error);
    }
  }
  return recovered;
}

export const __installTransactionTestInternals = {
  TRANSACTION_FILE,
  transactionPath,
  renameWithRetry,
  RENAME_RETRY_COUNT
};
