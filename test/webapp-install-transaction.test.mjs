import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  activateWebappInstall,
  commitWebappInstall,
  hasPendingWebappInstallTransaction,
  markWebappInstallRollback,
  recoverWebappInstallTransactions,
  rollbackWebappInstall,
  __installTransactionTestInternals: { renameWithRetry, RENAME_RETRY_COUNT, transactionPath },
} = require("../dist-electron/main/modules/webs/webapps/install-transaction.js");
const {
  getDesktopWebappInstallBackupRoot,
  getDesktopWebappInstallStagingRoot,
  getDesktopWebappsDataRoot,
} = require("../dist-electron/main/infrastructure/filesystem/user-paths.js");

function fixture(t, { existing = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-install-transaction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = {
    getPath(name) {
      if (name === "home") return path.join(root, "home");
      if (name === "appData") return path.join(root, "app-data");
      if (name === "temp") return path.join(root, "temp");
      if (name === "desktop") return path.join(root, "Desktop");
      assert.fail(`Unexpected app.getPath(${name})`);
    },
    getAppPath() { return process.cwd(); },
  };
  const id = "webapp-transaction";
  const installPath = path.join(getDesktopWebappsDataRoot(app), id);
  const stagingPath = path.join(getDesktopWebappInstallStagingRoot(app), "incoming");
  fs.mkdirSync(path.dirname(installPath), { recursive: true });
  if (existing) writeVersion(installPath, "old");
  writeVersion(stagingPath, "new");
  return {
    root, app, id, installPath, stagingPath,
    journal: transactionPath(app, id),
    activate: () => activateWebappInstall({ app, id, installPath, stagingPath }),
  };
}

function writeVersion(directory, version) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "version.txt"), version, "utf8");
}

function readVersion(directory) {
  return fs.readFileSync(path.join(directory, "version.txt"), "utf8");
}

function readJournal(view) {
  return JSON.parse(fs.readFileSync(view.journal, "utf8"));
}

function lockError(code = "EPERM", operation = "rename") {
  return Object.assign(new Error(`${operation}: directory is locked`), { code, syscall: operation });
}

function captureWarnings(t) {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => { warnings.push(args); });
  return warnings;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function transactionAtPhase(t, phase) {
  const view = fixture(t);
  let transaction;
  if (phase === "prepared") {
    transaction = {
      schemaVersion: 1, id: view.id, phase, hadExisting: true,
      installPath: view.installPath, stagingPath: view.stagingPath,
      backupPath: path.join(getDesktopWebappInstallBackupRoot(view.app), "original"),
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(view.journal), { recursive: true });
    fs.writeFileSync(view.journal, JSON.stringify(transaction));
  } else {
    transaction = await view.activate();
    if (phase === "backed-up") {
      fs.renameSync(view.installPath, view.stagingPath);
      transaction.phase = phase;
      fs.writeFileSync(view.journal, JSON.stringify(transaction));
    } else if (phase === "rolling-back") {
      await markWebappInstallRollback(view.app, transaction);
    }
  }
  return { view, transaction };
}

function transactionSnapshot(view, transaction) {
  return {
    install: fs.existsSync(view.installPath) ? readVersion(view.installPath) : null,
    staging: fs.existsSync(view.stagingPath) ? readVersion(view.stagingPath) : null,
    backup: fs.existsSync(transaction.backupPath) ? readVersion(transaction.backupPath) : null,
    journal: fs.readFileSync(view.journal, "utf8"),
  };
}

for (const code of ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]) {
  test(`Windows rename retries a temporary ${code} lock without blocking the event loop`, async t => {
    const failure = lockError(code);
    let attempts = 0;
    let eventLoopAdvanced = false;
    t.mock.method(fs.promises, "rename", async (source, target) => {
      assert.equal(source, "D:\\fixture\\old");
      assert.equal(target, "D:\\fixture\\backup");
      if (++attempts === 1) throw failure;
      assert.equal(eventLoopAdvanced, true, "handle-release work must run between attempts");
    });
    const command = renameWithRetry("D:\\fixture\\old", "D:\\fixture\\backup", "win32");
    setTimeout(() => { eventLoopAdvanced = true; }, 0);
    await command;
    assert.equal(attempts, 2);
  });
}

test("Windows rename preserves a persistent lock error after bounded retries", async t => {
  const failure = lockError();
  const rename = t.mock.method(fs.promises, "rename", async () => { throw failure; });
  await assert.rejects(renameWithRetry("old", "backup", "win32"), error => error === failure);
  assert.equal(rename.mock.callCount(), RENAME_RETRY_COUNT + 1);
});

test("Windows rename does not retry unrelated filesystem failures", async t => {
  const failure = lockError("ENOSPC");
  const rename = t.mock.method(fs.promises, "rename", async () => { throw failure; });
  await assert.rejects(renameWithRetry("old", "backup", "win32"), error => error === failure);
  assert.equal(rename.mock.callCount(), 1);
});

test("macOS rename returns a lock error without Windows retries", async t => {
  const failure = lockError();
  const rename = t.mock.method(fs.promises, "rename", async () => { throw failure; });
  await assert.rejects(renameWithRetry("old", "backup", "darwin"), error => error === failure);
  assert.equal(rename.mock.callCount(), 1);
});

test("successful activation and commit retain the new package and remove artifacts", async t => {
  const view = fixture(t);
  const transaction = await view.activate();
  assert.equal(transaction.phase, "activated");
  assert.equal(readVersion(view.installPath), "new");
  assert.equal(readVersion(transaction.backupPath), "old");
  await commitWebappInstall(view.app, transaction);
  assert.equal(readVersion(view.installPath), "new");
  assert.equal(fs.existsSync(transaction.backupPath), false);
  assert.equal(fs.existsSync(view.stagingPath), false);
  assert.equal(fs.existsSync(view.journal), false);
});

test("commit keeps its journal when backup cleanup fails and a later recovery retries cleanup", async t => {
  const view = fixture(t);
  const transaction = await view.activate();
  const failure = lockError("EPERM", "rm");
  const realRm = fs.promises.rm.bind(fs.promises);
  let locked = true;
  t.mock.method(fs.promises, "rm", async (target, options) => {
    if (locked && target === transaction.backupPath) throw failure;
    return realRm(target, options);
  });
  const warnings = captureWarnings(t);
  await commitWebappInstall(view.app, transaction);
  assert.equal(readJournal(view).phase, "activated");
  assert.equal(readVersion(view.installPath), "new");
  assert.equal(readVersion(transaction.backupPath), "old");
  assert.ok(warnings.some(args => args.includes(failure)));
  assert.deepEqual(await recoverWebappInstallTransactions(view.app), []);
  assert.equal(fs.existsSync(view.journal), true);
  locked = false;
  assert.deepEqual(await recoverWebappInstallTransactions(view.app), [view.id]);
  assert.equal(readVersion(view.installPath), "new");
  assert.equal(fs.existsSync(transaction.backupPath), false);
  assert.equal(fs.existsSync(view.journal), false);
});

test("marking rollback persists intent without touching either package directory", async t => {
  const view = fixture(t);
  const transaction = await view.activate();
  await markWebappInstallRollback(view.app, transaction);
  assert.equal(transaction.phase, "rolling-back");
  assert.equal(readJournal(view).phase, "rolling-back");
  assert.equal(readVersion(view.installPath), "new");
  assert.equal(readVersion(transaction.backupPath), "old");
});

test("rollback retains the original package and journal while the new directory is locked", async t => {
  const view = fixture(t);
  const transaction = await view.activate();
  const failure = lockError("EPERM", "rm");
  const realRm = fs.promises.rm.bind(fs.promises);
  let locked = true;
  t.mock.method(fs.promises, "rm", async (target, options) => {
    if (locked && target === view.installPath) throw failure;
    return realRm(target, options);
  });
  captureWarnings(t);
  await assert.rejects(rollbackWebappInstall(view.app, transaction), error => error === failure);
  assert.equal(readJournal(view).phase, "rolling-back");
  assert.equal(readVersion(view.installPath), "new");
  assert.equal(readVersion(transaction.backupPath), "old");
  assert.deepEqual(await recoverWebappInstallTransactions(view.app), []);
  assert.equal(readVersion(transaction.backupPath), "old", "failed recovery must not commit the rejected new package");
  locked = false;
  assert.deepEqual(await recoverWebappInstallTransactions(view.app), [view.id]);
  assert.equal(readVersion(view.installPath), "old");
  assert.equal(fs.existsSync(transaction.backupPath), false);
  assert.equal(fs.existsSync(view.journal), false);
});

for (const phase of ["prepared", "backed-up", "activated", "rolling-back"]) {
  for (const guardResult of ["false", "throw"]) {
    test(`${phase} recovery preserves all files when its runtime guard returns ${guardResult}`, async t => {
      const { view, transaction } = await transactionAtPhase(t, phase);
      const before = transactionSnapshot(view, transaction);
      captureWarnings(t);
      let guarded = 0;
      const beforeRecovery = async pending => {
        guarded += 1;
        assert.equal(pending.id, view.id);
        assert.equal(pending.phase, phase);
        if (guardResult === "throw") throw new Error("Backend has not stopped");
        return false;
      };
      assert.deepEqual(await recoverWebappInstallTransactions(view.app, { beforeRecovery }), []);
      assert.equal(guarded, 1);
      assert.deepEqual(transactionSnapshot(view, transaction), before);
      assert.deepEqual(await recoverWebappInstallTransactions(view.app, { beforeRecovery: async () => true }), [view.id]);
      assert.equal(readVersion(view.installPath), phase === "activated" ? "new" : "old");
      assert.equal(fs.existsSync(view.journal), false);
    });
  }
  test(`activation refuses to overwrite a pending ${phase} journal or its directories`, async t => {
    const { view, transaction } = await transactionAtPhase(t, phase);
    const before = transactionSnapshot(view, transaction);
    assert.equal(hasPendingWebappInstallTransaction(view.app, view.id), true);
    await assert.rejects(view.activate(), /pending recovery/u);
    assert.deepEqual(transactionSnapshot(view, transaction), before);
  });
}

test("activation also preserves an invalid journal until recovery can inspect it", async t => {
  const view = fixture(t);
  assert.equal(hasPendingWebappInstallTransaction(view.app, view.id), false);
  fs.mkdirSync(path.dirname(view.journal), { recursive: true });
  fs.writeFileSync(view.journal, "interrupted journal: preserve evidence");
  captureWarnings(t);
  await assert.rejects(view.activate(), /pending recovery/u);
  assert.deepEqual(await recoverWebappInstallTransactions(view.app), []);
  assert.equal(fs.readFileSync(view.journal, "utf8"), "interrupted journal: preserve evidence");
  assert.equal(readVersion(view.installPath), "old");
  assert.equal(readVersion(view.stagingPath), "new");
});

test("competing activation attempts cannot overwrite the winning transaction journal", async t => {
  const view = fixture(t);
  const outcomes = await Promise.allSettled([view.activate(), view.activate()]);
  const completed = outcomes.filter(outcome => outcome.status === "fulfilled");
  const rejected = outcomes.filter(outcome => outcome.status === "rejected");
  assert.equal(completed.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason.code === "EEXIST" || /pending recovery/u.test(rejected[0].reason.message));
  const transaction = completed[0].value;
  assert.equal(readJournal(view).backupPath, transaction.backupPath);
  assert.equal(readVersion(transaction.backupPath), "old");
  assert.equal(readVersion(view.installPath), "new");
  await rollbackWebappInstall(view.app, transaction);
  assert.equal(readVersion(view.installPath), "old");
  assert.equal(hasPendingWebappInstallTransaction(view.app, view.id), false);
});

test("recovery preserves an initial journal whose exclusive write has not finished", async t => {
  const view = fixture(t);
  const writing = deferred();
  const written = deferred();
  const realWrite = fs.promises.writeFile.bind(fs.promises);
  t.mock.method(fs.promises, "writeFile", async (target, content, options) => {
    if (target === view.journal && options.flag === "wx") {
      const descriptor = fs.openSync(target, "wx");
      writing.resolve();
      try {
        await written.promise;
        fs.writeFileSync(descriptor, content, "utf8");
      } finally {
        fs.closeSync(descriptor);
      }
      return;
    }
    return realWrite(target, content, options);
  });
  captureWarnings(t);
  const activation = view.activate();
  let transaction;
  try {
    await writing.promise;
    assert.equal(fs.readFileSync(view.journal, "utf8"), "");
    let admitted = false;
    assert.deepEqual(await recoverWebappInstallTransactions(view.app, {
      beforeRecovery: async () => { admitted = true; return true; },
    }), []);
    assert.equal(admitted, false, "an incomplete journal has no trusted transaction identity to admit");
    assert.equal(fs.existsSync(view.journal), true);
    assert.equal(readVersion(view.installPath), "old");
    assert.equal(readVersion(view.stagingPath), "new");
  } finally {
    written.resolve();
    transaction = await activation;
  }
  assert.equal(readJournal(view).phase, "activated");
  assert.equal(readVersion(transaction.backupPath), "old");
  await rollbackWebappInstall(view.app, transaction);
  assert.equal(readVersion(view.installPath), "old");
});

test("an unfinished phase update leaves the previous complete journal readable", async t => {
  const view = fixture(t);
  const writing = deferred();
  const written = deferred();
  const realWrite = fs.promises.writeFile.bind(fs.promises);
  let blocked = false;
  t.mock.method(fs.promises, "writeFile", async (target, content, options) => {
    if (!blocked && target !== view.journal && JSON.parse(content).phase === "backed-up") {
      blocked = true;
      const descriptor = fs.openSync(target, "wx");
      writing.resolve();
      try {
        await written.promise;
        fs.writeFileSync(descriptor, content, "utf8");
      } finally {
        fs.closeSync(descriptor);
      }
      return;
    }
    return realWrite(target, content, options);
  });
  const activation = view.activate();
  let transaction;
  try {
    await writing.promise;
    const journal = readJournal(view);
    assert.equal(journal.phase, "prepared");
    assert.equal(readVersion(journal.backupPath), "old");
    assert.equal(readVersion(view.stagingPath), "new");
    assert.deepEqual(await recoverWebappInstallTransactions(view.app, { beforeRecovery: async () => false }), []);
    assert.deepEqual(readJournal(view), journal);
    assert.equal(fs.existsSync(view.installPath), false);
    assert.equal(readVersion(journal.backupPath), "old");
  } finally {
    written.resolve();
    transaction = await activation;
  }
  assert.equal(readJournal(view).phase, "activated");
  await rollbackWebappInstall(view.app, transaction);
  assert.equal(readVersion(view.installPath), "old");
});

for (const journalChange of ["replaced", "removed"]) {
  test(`recovery ignores its stale snapshot when the journal was ${journalChange} during admission`, async t => {
    const view = fixture(t);
    const transaction = await view.activate();
    const replacement = {
      ...readJournal(view),
      backupPath: `${transaction.backupPath}-replacement`,
      updatedAt: "2001-01-01T00:00:00.000Z",
    };
    let admitted;
    let resume;
    const admissionReached = new Promise(resolve => { admitted = resolve; });
    const admissionResumed = new Promise(resolve => { resume = resolve; });
    const recovery = recoverWebappInstallTransactions(view.app, {
      beforeRecovery: async () => { admitted(); await admissionResumed; return true; },
    });
    await admissionReached;
    if (journalChange === "replaced") {
      writeVersion(replacement.backupPath, "replacement-old");
      fs.writeFileSync(view.journal, JSON.stringify(replacement));
    } else {
      fs.rmSync(view.journal);
    }
    resume();
    assert.deepEqual(await recovery, []);
    assert.equal(readVersion(view.installPath), "new");
    assert.equal(readVersion(transaction.backupPath), "old");
    if (journalChange === "replaced") {
      assert.deepEqual(readJournal(view), replacement);
      assert.equal(readVersion(replacement.backupPath), "replacement-old");
    } else {
      assert.equal(fs.existsSync(view.journal), false);
    }
  });
}

test("rollback recovery retains its journal and backup when restoring the old directory fails", async t => {
  const view = fixture(t);
  const transaction = await view.activate();
  await markWebappInstallRollback(view.app, transaction);
  const failure = lockError("EACCES");
  const realRename = fs.promises.rename.bind(fs.promises);
  let locked = true;
  t.mock.method(fs.promises, "rename", async (source, target) => {
    if (locked && source === transaction.backupPath) throw failure;
    return realRename(source, target);
  });
  captureWarnings(t);
  assert.deepEqual(await recoverWebappInstallTransactions(view.app), []);
  assert.equal(fs.existsSync(view.installPath), false);
  assert.equal(readVersion(transaction.backupPath), "old");
  assert.equal(readJournal(view).phase, "prepared", "a restart can restore the backup without stopping a removed package");
  locked = false;
  assert.deepEqual(await recoverWebappInstallTransactions(view.app), [view.id]);
  assert.equal(readVersion(view.installPath), "old");
  assert.equal(fs.existsSync(view.journal), false);
});

test("failed activation preserves its first error when restoring or cleaning staging also fails", async t => {
  const view = fixture(t);
  const activationFailure = lockError("EBUSY");
  const cleanupFailure = lockError("EPERM", "rm");
  const realRename = fs.promises.rename.bind(fs.promises);
  const realRm = fs.promises.rm.bind(fs.promises);
  let stagingLocked = true;
  t.mock.method(fs.promises, "rename", async (source, target) => {
    if (source === view.stagingPath) throw activationFailure;
    return realRename(source, target);
  });
  t.mock.method(fs.promises, "rm", async (target, options) => {
    if (stagingLocked && target === view.stagingPath) throw cleanupFailure;
    return realRm(target, options);
  });
  const warnings = captureWarnings(t);
  await assert.rejects(view.activate(), error => error === activationFailure);
  assert.equal(readVersion(view.installPath), "old");
  assert.equal(readVersion(view.stagingPath), "new");
  assert.equal(readJournal(view).phase, "prepared", "the restored package must not be mistaken for an unfinished rollback");
  assert.ok(warnings.some(args => args.includes(cleanupFailure)));
  stagingLocked = false;
  assert.deepEqual(await recoverWebappInstallTransactions(view.app), [view.id]);
  assert.equal(readVersion(view.installPath), "old");
  assert.equal(fs.existsSync(view.stagingPath), false);
  assert.equal(fs.existsSync(view.journal), false);
});

test("activation failure before moving the old directory preserves it while retaining failed-cleanup journal", async t => {
  const view = fixture(t);
  const activationFailure = lockError("EPERM");
  const cleanupFailure = lockError("EPERM", "rm");
  const realRm = fs.promises.rm.bind(fs.promises);
  let stagingLocked = true;
  t.mock.method(fs.promises, "rename", async () => { throw activationFailure; });
  t.mock.method(fs.promises, "rm", async (target, options) => {
    if (stagingLocked && target === view.stagingPath) throw cleanupFailure;
    return realRm(target, options);
  });
  captureWarnings(t);
  await assert.rejects(view.activate(), error => error === activationFailure);
  assert.equal(readVersion(view.installPath), "old");
  assert.equal(readJournal(view).phase, "prepared");
  stagingLocked = false;
  assert.deepEqual(await recoverWebappInstallTransactions(view.app), [view.id]);
  assert.equal(readVersion(view.installPath), "old");
  assert.equal(fs.existsSync(view.journal), false);
});

test("new-package rollback removes an uncommitted install without requiring a backup", async t => {
  const view = fixture(t, { existing: false });
  const transaction = await view.activate();
  assert.equal(transaction.hadExisting, false);
  await rollbackWebappInstall(view.app, transaction);
  assert.equal(fs.existsSync(view.installPath), false);
  assert.equal(fs.existsSync(view.journal), false);
});

test("rollback never deletes the active package if its required original backup is missing", async t => {
  const view = fixture(t);
  const transaction = await view.activate();
  fs.rmSync(transaction.backupPath, { recursive: true, force: true });
  captureWarnings(t);
  await assert.rejects(rollbackWebappInstall(view.app, transaction), /backup directory is missing/u);
  assert.equal(readVersion(view.installPath), "new");
  assert.equal(readJournal(view).phase, "rolling-back");
  assert.deepEqual(await recoverWebappInstallTransactions(view.app), []);
  assert.equal(readVersion(view.installPath), "new");
  assert.equal(fs.existsSync(view.journal), true);
});

test("recovery rejects a journal with paths outside the owned install roots", async t => {
  const view = fixture(t);
  const outside = path.join(view.root, "user-data");
  writeVersion(outside, "preserve");
  fs.mkdirSync(path.dirname(view.journal), { recursive: true });
  fs.writeFileSync(view.journal, JSON.stringify({
    schemaVersion: 1, id: view.id, phase: "rolling-back", hadExisting: true,
    installPath: view.installPath, stagingPath: view.stagingPath, backupPath: outside,
    updatedAt: new Date().toISOString(),
  }));
  const journalBefore = fs.readFileSync(view.journal, "utf8");
  captureWarnings(t);
  assert.deepEqual(await recoverWebappInstallTransactions(view.app), []);
  assert.equal(readVersion(outside), "preserve");
  assert.equal(readVersion(view.installPath), "old");
  assert.equal(readVersion(view.stagingPath), "new");
  assert.equal(fs.readFileSync(view.journal, "utf8"), journalBefore);
  assert.equal(fs.existsSync(getDesktopWebappInstallBackupRoot(view.app)), false);
});
