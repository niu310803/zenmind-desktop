import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const { installWebsiteAppArchiveFromPath } = require("../dist-electron/main/modules/marketplace/website-app-market.js");
const { disposeWebappInstallation } = require("../dist-electron/main/modules/webs/webapps/actions.js");
const { WebappManager } = require("../dist-electron/main/modules/webs/webapps/manager.js");
const { WebappRuntime } = require("../dist-electron/main/modules/webs/webapps/runtime.js");
const { WebappWindowManager } = require("../dist-electron/main/modules/webs/webapps/window-manager.js");
const { getWebappDir } = require("../dist-electron/main/modules/webs/webapps/store.js");
const {
  getDesktopWebappDataRoot,
  getDesktopWebappInstallBackupRoot,
  getDesktopWebappStateRoot,
  getDesktopWebappInstallStagingRoot,
} = require("../dist-electron/main/infrastructure/filesystem/user-paths.js");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, { hosting } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-zip-lifecycle-"));
  const app = {
    getPath(name) {
      const paths = { home: "home", appData: "app-data", temp: "temp", desktop: "Desktop" };
      assert.ok(paths[name], `Unexpected app.getPath(${name})`);
      return path.join(root, paths[name]);
    },
    getAppPath: () => process.cwd(),
  };
  const key = "zip-lifecycle";
  const id = `webapp-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  const manifest = version => ({
    schemaVersion: 2, id, key, label: "ZIP lifecycle", version, target: "any", appConfig: {},
    ...(hosting === "platform" ? { hosting, minPlatformVersion: "0.5.0" } : {}),
    frontend: {
      root: "frontend", index: "index.html",
      routeConfig: { backendPrefixes: [], navigationFallback: "index.html" },
    },
    desktopBridge: { version: 1 },
  });
  const { webappPlatformLayout } = require("../dist-electron/main/modules/webs/webapps/platform-layout.js");
  const installPath = hosting === "platform" ? webappPlatformLayout(app, id).runtime : getWebappDir(app, id);
  fs.mkdirSync(path.join(installPath, "frontend"), { recursive: true });
  fs.writeFileSync(path.join(installPath, "webapp.json"), JSON.stringify(manifest("1.0.0")));
  fs.writeFileSync(path.join(installPath, "frontend", "index.html"), "<!doctype html><title>old</title>");
  const dataPath = getDesktopWebappDataRoot(app, id);
  fs.mkdirSync(dataPath, { recursive: true });
  if (hosting === "platform") fs.mkdirSync(path.join(installPath, "chats"), { recursive: true });
  const sentinel = path.join(hosting === "platform" ? path.join(installPath, "chats") : dataPath, "business-data.txt");
  fs.writeFileSync(sentinel, "keep business data");
  const ports = {
    getDesktopDeviceId: () => "zip-lifecycle-fixture",
    getConfiguredDesktopActionBridgePort: () => 54321,
    readInstalledRecords: () => [],
    readTunnelHubSettings: () => ({ enabled: false, relayUrl: "", deviceId: "" }),
    getTunnelHubRuntimeStatus: () => null,
    readTunnelHubRegistrationBearerToken: () => "",
  };
  const runtime = new WebappRuntime(ports);
  const windowManager = new WebappWindowManager(ports, runtime);
  const manager = new WebappManager(ports, runtime, windowManager);
  const webs = { webappRuntime: runtime, webappWindowManager: windowManager };
  const archive = async (version = "2.0.0", archiveId = id) => {
    const zip = new JSZip();
    zip.file(`${archiveId}/webapp.json`, JSON.stringify({ ...manifest(version), id: archiveId }));
    zip.file(`${archiveId}/frontend/index.html`, `<!doctype html><title>${version}</title>`);
    const archivePath = path.join(root, `package-${version}.zip`);
    fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    return archivePath;
  };
  const install = (archivePath, options = {}) => installWebsiteAppArchiveFromPath(app, archivePath, { webs, recordInstallation: false, ...options });
  const version = () => JSON.parse(fs.readFileSync(path.join(installPath, "webapp.json"), "utf8")).version;
  const journalPath = path.join(getDesktopWebappStateRoot(app, id), "install-transaction.json");
  t.after(async () => {
    t.mock.restoreAll();
    await runtime.stopAll(app);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, app, id, runtime, windowManager, manager, archive, install, installPath, version, sentinel, journalPath };
}

for (const hosting of ["desktop", "platform"]) {
  test(`same-version overwrite replaces ${hosting} package contents and preserves business data`, async t => {
    const f = fixture(t, { hosting });
    if (hosting === "platform") mockPlatform(t, f);
    const archive = await f.archive("1.0.0");
    await assert.rejects(f.install(archive), error => error.code === "version_content_conflict");
    await assert.rejects(f.install(archive, { overwrite: false }), error => error.code === "version_content_conflict");
    const start = t.mock.method(f.runtime, "startRuntime", f.runtime.startRuntime.bind(f.runtime));
    assert.equal((await f.install(archive, { overwrite: true })).ok, true);
    assert.equal(start.mock.callCount(), 1);
    assert.equal(f.version(), "1.0.0");
    assert.equal(fs.readFileSync(path.join(f.installPath, "frontend", "index.html"), "utf8"), "<!doctype html><title>1.0.0</title>");
    assert.equal(fs.readFileSync(f.sentinel, "utf8"), "keep business data");
    assert.equal(fs.existsSync(f.journalPath), false);
    await assert.rejects(f.install(await f.archive("0.9.0"), { overwrite: true }), error => error.code === "downgrade_not_allowed");
  });

  test(`failed same-version overwrite rolls back ${hosting} contents`, async t => {
    const f = fixture(t, { hosting });
    if (hosting === "platform") mockPlatform(t, f);
    t.mock.method(f.runtime, "startRuntime", async () => ({ ok: false, message: "candidate unhealthy" }));
    await assert.rejects(f.install(await f.archive("1.0.0"), { overwrite: true }), error => error.code === "startup_failed");
    assert.equal(f.version(), "1.0.0");
    assert.equal(fs.readFileSync(path.join(f.installPath, "frontend", "index.html"), "utf8"), "<!doctype html><title>old</title>");
    assert.equal(fs.readFileSync(f.sentinel, "utf8"), "keep business data");
    assert.equal(fs.existsSync(f.journalPath), false);
  });
}

test("ZIP replacement waits for stop and guest destruction, and blocks competing starts and mutations", async t => {
  const f = fixture(t);
  assert.equal((await f.runtime.start(f.app, f.id)).ok, true);
  const closing = deferred();
  const closed = deferred();
  const events = [];
  let restored;
  f.windowManager.setDisposalListener(async (id, change) => {
    if (change?.phase === "replacement-finished") {
      restored = change.state;
      events.push("presentation-restored");
      return;
    }
    assert.equal(id, f.id);
    assert.equal(change?.phase, "replacing");
    assert.equal(f.runtime.getStatus(f.app, f.id).status, "stopped");
    events.push("stopped");
    closing.resolve();
    await closed.promise;
    events.push("guest-destroyed");
  });
  const rename = fs.promises.rename.bind(fs.promises);
  t.mock.method(fs.promises, "rename", async (source, destination) => {
    if (source === f.installPath) {
      assert.deepEqual(events, ["stopped", "guest-destroyed"]);
      events.push("package-replaced");
    }
    return rename(source, destination);
  });
  const archive = await f.archive();
  const installing = f.install(archive);
  try {
    await closing.promise;
    assert.equal(f.version(), "1.0.0");
    assert.equal((await f.runtime.start(f.app, f.id)).ok, false);
    assert.equal((await f.runtime.restart(f.app, f.id)).ok, false);
    await assert.rejects(f.install(archive), error => error.code === "webapp_busy");
    const removed = await disposeWebappInstallation(f.app, { id: f.id, label: "ZIP lifecycle" }, "Removed", undefined, {
      runtime: f.runtime, windowManager: f.windowManager,
    });
    assert.equal(removed.ok, false);
    assert.equal(f.version(), "1.0.0");
  } finally {
    closed.resolve();
    await installing;
  }
  assert.equal(f.version(), "2.0.0");
  assert.equal(f.runtime.getStatus(f.app, f.id).status, "running");
  assert.deepEqual(events, ["stopped", "guest-destroyed", "package-replaced", "presentation-restored"]);
  assert.equal(restored.version, "2.0.0");
  assert.match(await (await fetch(restored.webUrl)).text(), /<title>2\.0\.0<\/title>/u);
  assert.equal(fs.readFileSync(f.sentinel, "utf8"), "keep business data");
  assert.equal(f.runtime.isDisposing(f.id), false);
});

test("concurrent ZIPs with the same key cannot both install under different IDs", async t => {
  const f = fixture(t);
  fs.rmSync(f.installPath, { recursive: true });
  const otherId = "webapp-0123456789abcdef";
  const firstArchive = await f.archive();
  const secondArchive = await f.archive("3.0.0", otherId);
  const transactionStarted = deferred();
  const release = deferred();
  const mkdir = fs.promises.mkdir.bind(fs.promises);
  const backupRoot = getDesktopWebappInstallBackupRoot(f.app);
  let first = true;
  t.mock.method(fs.promises, "mkdir", async (target, options) => {
    if (first && target === backupRoot) {
      first = false;
      transactionStarted.resolve();
      await release.promise;
    }
    return mkdir(target, options);
  });
  const installing = f.install(firstArchive);
  try {
    await transactionStarted.promise;
    assert.equal(fs.existsSync(f.installPath), false, "the first ZIP has not published its directory");
    await assert.rejects(f.install(secondArchive), error => error.code === "webapp_busy");
    assert.equal(fs.existsSync(getWebappDir(f.app, otherId)), false);
  } finally {
    release.resolve();
    await installing;
  }
  await assert.rejects(f.install(secondArchive), error => error.code === "key_conflict");
  assert.equal(f.version(), "2.0.0");
});

test("ZIP replacement does not close guests or change the old package if stopping fails", async t => {
  const f = fixture(t);
  let closed = false;
  f.windowManager.setDisposalListener(() => { closed = true; });
  t.mock.method(f.runtime, "stop", async () => ({ ok: false, message: "backend still owns the directory" }));
  await assert.rejects(f.install(await f.archive()), error => error.code === "existing_runtime_stop_failed");
  assert.equal(closed, false);
  assert.equal(f.version(), "1.0.0");
  assert.equal(fs.existsSync(f.sentinel), true);
  assert.equal(f.runtime.isDisposing(f.id), false);
  assert.equal(fs.existsSync(f.journalPath), false);
});

test("ZIP guest closure failure preserves the old package and restores its running state", async t => {
  const f = fixture(t);
  await f.runtime.start(f.app, f.id);
  let restored;
  f.windowManager.setDisposalListener((_id, change) => {
    if (change?.phase === "replacing") throw new Error("guest did not close");
    if (change?.phase === "replacement-finished") restored = change.state;
  });
  await assert.rejects(f.install(await f.archive()), /guest did not close/);
  assert.equal(f.version(), "1.0.0");
  assert.equal(f.runtime.getStatus(f.app, f.id).status, "running");
  assert.equal(restored.version, "1.0.0");
  assert.equal(restored.status, "running");
  assert.equal(fs.existsSync(f.sentinel), true);
  assert.equal(fs.existsSync(f.journalPath), false);
  assert.equal(f.runtime.isDisposing(f.id), false);
});

test("ZIP startup failure rolls back only after a successful stop and keeps business data", async t => {
  const f = fixture(t);
  assert.equal((await f.runtime.start(f.app, f.id)).ok, true);
  const originalStart = f.runtime.startRuntime.bind(f.runtime);
  t.mock.method(f.runtime, "startRuntime", async (...args) => f.version() === "1.0.0"
    ? originalStart(...args)
    : { ok: false, message: "new backend failed health validation" });
  let restored;
  f.windowManager.setDisposalListener((_id, change) => {
    if (change?.phase === "replacement-finished") restored = change.state;
  });
  await assert.rejects(f.install(await f.archive()), error => error.code === "startup_failed");
  assert.equal(f.version(), "1.0.0");
  assert.equal(restored.version, "1.0.0");
  assert.match(await (await fetch(restored.webUrl)).text(), /<title>old<\/title>/u);
  assert.equal(fs.readFileSync(f.sentinel, "utf8"), "keep business data");
  assert.equal(fs.existsSync(f.journalPath), false);
  assert.equal(f.runtime.isDisposing(f.id), false);
});

test("startup recovery cannot commit a ZIP replacement that is still being health validated", async t => {
  const f = fixture(t);
  const starting = deferred();
  const validated = deferred();
  t.mock.method(f.runtime, "startRuntime", async () => {
    starting.resolve();
    await validated.promise;
    return { ok: false, message: "health validation failed" };
  });
  const installing = f.install(await f.archive());
  const rejected = assert.rejects(installing, error => error.code === "startup_failed");
  try {
    await starting.promise;
    const journal = JSON.parse(fs.readFileSync(f.journalPath, "utf8"));
    assert.equal(journal.phase, "activated");
    assert.deepEqual(await f.manager.recoverInstallations(f.app), []);
    assert.equal(fs.existsSync(journal.backupPath), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.journalPath, "utf8")), journal);
  } finally {
    validated.resolve();
    await rejected;
  }
  assert.equal(f.version(), "1.0.0");
  assert.equal(fs.existsSync(f.journalPath), false);
});

test("ZIP rollback stop failure retains both packages and recovery waits for stop and guest release", async t => {
  const f = fixture(t);
  const originalStop = f.runtime.stop.bind(f.runtime);
  let stopCalls = 0;
  t.mock.method(f.runtime, "startRuntime", async () => ({ ok: false, message: "new backend failed health validation" }));
  const stopMock = t.mock.method(f.runtime, "stop", async (...args) => {
    if (++stopCalls === 1) return originalStop(...args);
    return { ok: false, message: "process is still running" };
  });
  await assert.rejects(f.install(await f.archive()), error => {
    assert.equal(error.code, "startup_failed");
    assert.match(error.message, /new backend failed health validation/);
    assert.match(error.details.recovery.message, /process is still running/);
    return true;
  });
  assert.equal(f.version(), "2.0.0");
  assert.equal(fs.existsSync(f.sentinel), true);
  const journal = JSON.parse(fs.readFileSync(f.journalPath, "utf8"));
  assert.equal(journal.phase, "rolling-back");
  assert.equal(JSON.parse(fs.readFileSync(path.join(journal.backupPath, "webapp.json"), "utf8")).version, "1.0.0");
  await assert.rejects(f.install(await f.archive()), error => error.code === "installation_recovery_required");
  const uninstall = await f.manager.dispose(f.app, {
    id: f.id, label: "ZIP lifecycle", preserveUserData: true
  }, "Removed");
  assert.equal(uninstall.ok, false, "uninstall must not remove a package while startup recovery could restore it");
  assert.equal(f.version(), "2.0.0");
  assert.equal(fs.existsSync(journal.backupPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.journalPath, "utf8")), journal);
  assert.deepEqual(await f.manager.recoverInstallations(f.app), []);
  assert.equal(f.version(), "2.0.0");
  stopMock.mock.restore();
  const closing = deferred();
  const closed = deferred();
  f.windowManager.setDisposalListener(async () => {
    closing.resolve();
    await closed.promise;
  });
  const recovery = f.manager.recoverInstallations(f.app);
  try {
    await closing.promise;
    assert.equal(f.version(), "2.0.0");
    assert.equal((await f.runtime.start(f.app, f.id)).ok, false);
  } finally {
    closed.resolve();
  }
  assert.deepEqual(await recovery, [f.id]);
  assert.equal(f.version(), "1.0.0");
  assert.equal(fs.existsSync(f.journalPath), false);
  assert.equal(fs.existsSync(f.sentinel), true);
  assert.equal(f.runtime.isDisposing(f.id), false);
});

test("a gateway close failure stays visible to the next stop attempt", async t => {
  const f = fixture(t);
  assert.equal((await f.runtime.start(f.app, f.id)).ok, true);
  const gateway = f.runtime.records.get(f.id).gateway;
  const failedClose = t.mock.method(gateway, "close", async () => { throw new Error("gateway is still closing"); });
  for (let attempt = 0; attempt < 2; attempt++) {
    const stopped = await f.runtime.stop(f.app, f.id);
    assert.equal(stopped.ok, false);
    assert.match(stopped.message, /gateway is still closing/);
  }
  assert.equal(failedClose.mock.callCount(), 2);
  failedClose.mock.restore();
  assert.equal((await f.runtime.stop(f.app, f.id)).ok, true);
});

test("ZIP staging cleanup errors keep the original structured install failure", async t => {
  const f = fixture(t);
  const archive = await f.archive("0.9.0");
  const rm = fs.promises.rm.bind(fs.promises);
  const stagingRoot = getDesktopWebappInstallStagingRoot(f.app);
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(fs.promises, "rm", async (target, options) => {
    if (path.dirname(target) === stagingRoot) {
      throw Object.assign(new Error("temporary directory is still locked"), { code: "EPERM" });
    }
    return rm(target, options);
  });
  await assert.rejects(f.install(archive), error => error.code === "downgrade_not_allowed");
  assert.equal(f.version(), "1.0.0");
  assert.equal(f.runtime.isDisposing(f.id), false);
});

test("a ZIP can be imported, uninstalled while running, and imported again", async t => {
  const f = fixture(t);
  const archive = await f.archive();
  let restored;
  f.windowManager.setDisposalListener((_id, change) => {
    if (change?.phase === "replacement-finished") restored = change.state;
  });
  await f.install(archive);
  assert.equal(restored.status, "stopped", "replacing a stopped app must finish stopped after health validation");
  assert.equal(restored.webUrl, "");
  assert.deepEqual(f.windowManager.openIds(), []);
  assert.equal((await f.runtime.start(f.app, f.id)).ok, true);
  let closed = false;
  f.windowManager.setDisposalListener(() => {
    assert.equal(f.runtime.getStatus(f.app, f.id).status, "stopped");
    closed = true;
  });
  const removed = await f.manager.remove(f.app, f.id);
  assert.equal(removed.ok, true, removed.message);
  assert.equal(closed, true);
  assert.equal(fs.existsSync(f.installPath), false);
  assert.equal(fs.existsSync(f.sentinel), false);
  assert.equal((await f.install(archive)).ok, true);
  assert.equal(f.version(), "2.0.0");
  assert.equal(f.runtime.getStatus(f.app, f.id).status, "stopped");
  assert.equal(fs.existsSync(f.journalPath), false);
});

test("installation validation permits only its live exclusive lease to start", async t => {
  const f = fixture(t);
  const lease = f.runtime.beginInstallation(` ${f.id} `);
  assert.ok(lease);
  assert.equal(f.runtime.beginInstallation(f.id), null);
  assert.equal((await f.runtime.start(f.app, f.id)).ok, false);
  const releaseStop = f.runtime.beginDisposal(f.id);
  assert.equal((await lease.start(f.app)).ok, false, "an additional stop lease must also block validation");
  releaseStop();
  assert.equal((await lease.start(f.app)).ok, true);
  lease.release();
  lease.release();
  assert.equal((await lease.start(f.app)).ok, false, "an expired installation lease cannot bypass admission");
  assert.equal((await f.runtime.start(f.app, f.id)).ok, true);
});

function mockPlatform(t, f, { failVersion = "" } = {}) {
  let state = null;
  t.mock.method(f.runtime.platformInstances, "check", () => ({
    ok: true, launcher: "platform", ownership: "desktop", runtimeVersion: "0.5.46",
    externalId: "fixture", backendUrl: "", backendPort: null, issues: [],
  }));
  t.mock.method(f.runtime.platformInstances, "status", () => state);
  t.mock.method(f.runtime.platformInstances, "start", async (_app, item) => {
    if (item.version === failVersion) return { ok: false, item, state, message: "candidate unhealthy" };
    state = { id: item.id, version: item.version, status: "running", webUrl: "http://127.0.0.1:43211/", pid: null };
    return { ok: true, item, state, message: "Started" };
  });
  t.mock.method(f.runtime.platformInstances, "stop", async (_app, item) => {
    state = { id: item.id, version: item.version, status: "stopped", webUrl: "", pid: null };
    return { ok: true, item, state, message: "Stopped" };
  });
}

test("Platform ZIP replacement uses the installation lease and restores runtime and presentation without replacing chats", async t => {
  const f = fixture(t, { hosting: "platform" });
  mockPlatform(t, f);
  assert.equal((await f.runtime.start(f.app, f.id)).ok, true);
  const phases = [];
  f.windowManager.setDisposalListener((_id, change) => { phases.push(change); });
  await f.install(await f.archive());
  assert.equal(f.version(), "2.0.0");
  assert.equal(f.runtime.getStatus(f.app, f.id).status, "running");
  assert.equal(phases[0].phase, "replacing");
  assert.equal(phases[1].phase, "replacement-finished");
  assert.equal(phases[1].state.version, "2.0.0");
  assert.equal(fs.readFileSync(f.sentinel, "utf8"), "keep business data");
  assert.equal(f.runtime.isDisposing(f.id), false);
});

test("Platform ZIP validation failure rolls back package entries and restarts the verified old instance", async t => {
  const f = fixture(t, { hosting: "platform" });
  mockPlatform(t, f, { failVersion: "2.0.0" });
  await f.runtime.start(f.app, f.id);
  await assert.rejects(f.install(await f.archive()), /candidate unhealthy/);
  assert.equal(f.version(), "1.0.0");
  assert.equal(f.runtime.getStatus(f.app, f.id).status, "running");
  assert.equal(f.runtime.getStatus(f.app, f.id).version, "1.0.0");
  assert.equal(fs.readFileSync(f.sentinel, "utf8"), "keep business data");
  assert.equal(f.runtime.isDisposing(f.id), false);
});

test("Platform uninstall preserves runtime data for reinstall and explicit data deletion removes the independent root", async t => {
  const f = fixture(t, { hosting: "platform" });
  mockPlatform(t, f);
  const { webappPlatformLayout } = require("../dist-electron/main/modules/webs/webapps/platform-layout.js");
  const layout = webappPlatformLayout(f.app, f.id);
  const dispose = preserveUserData => disposeWebappInstallation(f.app,
    { id: f.id, label: "Platform", installPath: layout.runtime, preserveUserData }, "Removed", f.ports,
    { runtime: f.runtime, windowManager: f.windowManager });
  assert.equal((await dispose(true)).ok, true);
  assert.equal(fs.existsSync(path.join(layout.runtime, "webapp.json")), false);
  assert.equal(fs.readFileSync(f.sentinel, "utf8"), "keep business data");
  await f.install(await f.archive());
  assert.equal(f.version(), "2.0.0");
  assert.equal(fs.readFileSync(f.sentinel, "utf8"), "keep business data");
  assert.equal((await dispose(false)).ok, true);
  assert.equal(fs.existsSync(layout.root), false);
});
