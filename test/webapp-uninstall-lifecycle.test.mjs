import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { disposeWebappInstallation } = require("../dist-electron/main/modules/webs/webapps/actions.js");
const { waitForWebappGuestsClosed } = require("../dist-electron/main/modules/webs/webapps/guest-lifecycle.js");
const { removeWebappDirectory } = require("../dist-electron/main/modules/webs/webapps/remove-directory.js");
const { getWebappDir } = require("../dist-electron/main/modules/webs/webapps/store.js");
const { WebappRuntime } = require("../dist-electron/main/modules/webs/webapps/runtime.js");
const { WebappWindowManager } = require("../dist-electron/main/modules/webs/webapps/window-manager.js");
const {
  getDesktopWebappDataRoot,
  getDesktopWebappStateRoot,
  getDesktopWebappLogsRoot,
} = require("../dist-electron/main/infrastructure/filesystem/user-paths.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function disposalFixture(t, { stop = async () => ({ ok: true }), close = async () => undefined } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-uninstall-lifecycle-"));
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
  const key = "uninstall-lifecycle";
  const id = `webapp-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  const installPath = getWebappDir(app, id);
  const roots = {
    program: installPath,
    data: getDesktopWebappDataRoot(app, id),
    state: getDesktopWebappStateRoot(app, id),
    logs: getDesktopWebappLogsRoot(app, id),
  };
  const sentinels = Object.fromEntries(Object.entries(roots).map(([name, directory]) => {
    fs.mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, `${name}-sentinel.txt`);
    fs.writeFileSync(filename, `${name}: preserve until cleanup succeeds`, "utf8");
    return [name, filename];
  }));
  fs.mkdirSync(path.join(installPath, "frontend"));
  fs.writeFileSync(path.join(installPath, "frontend", "index.html"), "<!doctype html><title>Uninstall lifecycle</title>", "utf8");
  fs.writeFileSync(path.join(installPath, "webapp.json"), JSON.stringify({
    schemaVersion: 2,
    id,
    key,
    label: "Uninstall lifecycle",
    version: "1.0.0",
    target: "any",
    appConfig: {},
    frontend: {
      root: "frontend",
      index: "index.html",
      routeConfig: { backendPrefixes: [], navigationFallback: "index.html" },
    },
    desktopBridge: { version: 1 },
  }), "utf8");
  const ports = {
    getDesktopDeviceId: () => "uninstall-lifecycle-fixture",
    getConfiguredDesktopActionBridgePort: () => 54321,
    readInstalledRecords: () => [],
    readTunnelHubSettings: () => ({ enabled: false, relayUrl: "", deviceId: "" }),
    getTunnelHubRuntimeStatus: () => null,
    readTunnelHubRegistrationBearerToken: () => "",
  };
  const events = [];
  const guard = { active: false, released: 0 };
  const stopStarted = deferred();
  const closeStarted = deferred();
  let stopped = false;
  const dependencies = {
    runtime: {
      isDisposing: () => guard.active,
      async stop(targetApp, targetId, message) {
        assert.equal(targetApp, app);
        assert.equal(targetId, id);
        assert.equal(message, "Uninstalled");
        assert.equal(guard.active, true);
        events.push("stop");
        stopStarted.resolve();
        const result = await stop();
        stopped = result.ok;
        events.push(result.ok ? "stopped" : "stop-failed");
        return result;
      },
      emitLifecycleChange(reason, targetId) {
        assert.equal(reason, "removed");
        assert.equal(targetId, id);
        assert.equal(fs.existsSync(installPath), false, "removed must be emitted after program deletion");
        events.push("removed");
      },
    },
    windowManager: {
      beginDisposal(targetId, options) {
        assert.equal(targetId, id);
        assert.equal(options.closeImmediately, false, "the disposal guard must not close the live UI");
        assert.equal(options.preventRuntimeStart, true, "uninstall must block backend restarts throughout directory deletion");
        assert.equal(guard.active, false);
        guard.active = true;
        events.push("guard");
        return () => {
          assert.equal(guard.active, true);
          guard.active = false;
          guard.released += 1;
          events.push("released");
        };
      },
      async closeForDisposal(targetId) {
        assert.equal(targetId, id);
        assert.equal(stopped, true, "guests must not close until the runtime has stopped successfully");
        assert.equal(guard.active, true);
        events.push("close");
        closeStarted.resolve();
        await close();
        events.push("closed");
      },
    },
  };
  const target = { id, label: "Uninstall lifecycle", installPath };
  return {
    app, id, ports, roots, sentinels, events, guard,
    stopStarted: stopStarted.promise,
    closeStarted: closeStarted.promise,
    run: overrides => disposeWebappInstallation(app, { ...target, ...overrides }, "Uninstalled", ports, dependencies),
  };
}

function assertSentinelsPreserved(view) {
  for (const [name, filename] of Object.entries(view.sentinels)) {
    assert.equal(fs.readFileSync(filename, "utf8"), `${name}: preserve until cleanup succeeds`);
  }
}

function assertDisposalReleased(view) {
  assert.equal(view.guard.active, false);
  assert.equal(view.guard.released, 1);
  assert.equal(view.events.at(-1), "released");
}

test("uninstall waits for runtime stop, then guest closure, then deletes files and emits removed", async t => {
  const stopping = deferred();
  const closing = deferred();
  const view = disposalFixture(t, { stop: () => stopping.promise, close: () => closing.promise });
  const command = view.run();
  await view.stopStarted;
  assert.deepEqual(view.events, ["guard", "stop"]);
  assertSentinelsPreserved(view);
  assert.equal(view.guard.active, true);
  stopping.resolve({ ok: true });
  await view.closeStarted;
  assert.deepEqual(view.events, ["guard", "stop", "stopped", "close"]);
  assertSentinelsPreserved(view);
  assert.equal(view.guard.active, true);
  closing.resolve();
  const result = await command;
  assert.equal(result.ok, true);
  assert.equal(result.message, "Uninstalled");
  for (const directory of Object.values(view.roots)) assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(view.events, ["guard", "stop", "stopped", "close", "closed", "removed", "released"]);
  assertDisposalReleased(view);
});

test("uninstall refuses to close guests or delete files after a failed runtime stop", async t => {
  const view = disposalFixture(t, { stop: async () => ({ ok: false, message: "Backend is still running" }) });
  const result = await view.run();
  assert.equal(result.ok, false);
  assert.match(result.message, /Backend is still running/u);
  assert.deepEqual(view.events, ["guard", "stop", "stop-failed", "released"]);
  assertSentinelsPreserved(view);
  assertDisposalReleased(view);
});

test("uninstall preserves guests and files when stopping throws", async t => {
  const view = disposalFixture(t, { stop: async () => { throw new Error("Stop rejected unexpectedly"); } });
  const result = await view.run();
  assert.equal(result.ok, false);
  assert.equal(result.message, "Stop rejected unexpectedly");
  assert.deepEqual(view.events, ["guard", "stop", "released"]);
  assertSentinelsPreserved(view);
  assertDisposalReleased(view);
});

test("uninstall preserves program and business data when guest closure rejects", async t => {
  const view = disposalFixture(t, { close: async () => { throw new Error("Guest did not close"); } });
  const result = await view.run();
  assert.equal(result.ok, false);
  assert.equal(result.message, "Guest did not close");
  assert.deepEqual(view.events, ["guard", "stop", "stopped", "close", "released"]);
  assertSentinelsPreserved(view);
  assertDisposalReleased(view);
});

test("data-preserving disposal deletes the program only after closure and retains business data", async t => {
  const view = disposalFixture(t);
  const result = await view.run({ preserveUserData: true });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(view.roots.program), false);
  for (const name of ["data", "state", "logs"]) {
    assert.equal(fs.readFileSync(view.sentinels[name], "utf8"), `${name}: preserve until cleanup succeeds`);
  }
  assertDisposalReleased(view);
});

test("runtime disposal guards reject start and restart until every nested lease has been released", async t => {
  const runtime = new WebappRuntime();
  const app = {};
  const id = "guarded-webapp";
  const result = { ok: true, state: { id, status: "running" } };
  const start = t.mock.method(runtime, "startRuntime", async () => result);
  const stop = t.mock.method(runtime, "stopRuntime", async () => ({ ok: true }));
  const releaseOuter = runtime.beginDisposal(` ${id} `);
  const releaseInner = runtime.beginDisposal(id);
  assert.equal(runtime.isDisposing(` ${id} `), true);
  assert.equal((await runtime.start(app, id)).ok, false);
  assert.equal((await runtime.restart(app, id)).ok, false);
  assert.equal(start.mock.callCount(), 0);
  assert.equal(stop.mock.callCount(), 0, "a rejected restart must not stop an unrelated or partially managed instance");
  releaseOuter();
  releaseOuter();
  assert.equal(runtime.isDisposing(id), true, "releasing one lease twice must not consume the inner lease");
  assert.equal((await runtime.start(app, id)).ok, false);
  releaseInner();
  releaseInner();
  assert.equal(runtime.isDisposing(id), false);
  assert.equal(await runtime.start(app, id), result);
  assert.equal(start.mock.callCount(), 1);
});

test("the default market UI lease blocks window reopening while allowing runtime health-validation starts", async t => {
  const view = disposalFixture(t);
  const runtime = new WebappRuntime(view.ports);
  const windows = new WebappWindowManager(view.ports, runtime);
  const started = { ok: true, state: { id: view.id, status: "running", webUrl: "http://127.0.0.1:54321/" } };
  const start = t.mock.method(runtime, "startRuntime", async () => started);
  const stop = t.mock.method(runtime, "stopRuntime", async () => ({ ok: true }));
  const close = t.mock.method(windows, "closeForDisposal", async () => undefined);
  const release = windows.beginDisposal(view.id);
  try {
    assert.equal(close.mock.callCount(), 1, "the market's default lease must retain its existing immediate UI closure");
    assert.equal(runtime.isDisposing(view.id), false);
    assert.equal(await runtime.start(view.app, view.id), started);
    assert.equal(await runtime.restart(view.app, view.id), started);
    assert.equal(stop.mock.callCount(), 1);
    assert.equal(start.mock.callCount(), 2);
    const opened = await windows.open(view.app, view.id);
    assert.equal(opened.ok, false);
    assert.equal(start.mock.callCount(), 2, "the UI lease must reject window opening before starting another runtime");
  } finally {
    release();
    release();
  }
  assert.equal(runtime.isDisposing(view.id), false);
});

test("explicit stop or uninstall leases block runtime starts without prematurely closing the UI", async t => {
  const view = disposalFixture(t);
  const runtime = new WebappRuntime(view.ports);
  const windows = new WebappWindowManager(view.ports, runtime);
  const started = { ok: true };
  const start = t.mock.method(runtime, "startRuntime", async () => started);
  const stop = t.mock.method(runtime, "stopRuntime", async () => ({ ok: true }));
  const close = t.mock.method(windows, "closeForDisposal", async () => undefined);
  const release = windows.beginDisposal(view.id, { closeImmediately: false, preventRuntimeStart: true });
  try {
    assert.equal(runtime.isDisposing(view.id), true);
    assert.equal(close.mock.callCount(), 0);
    assert.equal((await runtime.start(view.app, view.id)).ok, false);
    assert.equal((await runtime.restart(view.app, view.id)).ok, false);
    assert.equal((await windows.open(view.app, view.id)).ok, false);
    assert.equal(start.mock.callCount(), 0);
    assert.equal(stop.mock.callCount(), 0);
  } finally {
    release();
    release();
  }
  assert.equal(runtime.isDisposing(view.id), false);
  assert.equal(await runtime.start(view.app, view.id), started);
  assert.equal(start.mock.callCount(), 1);
});

for (const firstReleased of ["runtime", "market"]) {
  test(`nested market and explicit leases preserve their separate permissions when ${firstReleased} is released first`, async t => {
    const view = disposalFixture(t);
    const runtime = new WebappRuntime(view.ports);
    const windows = new WebappWindowManager(view.ports, runtime);
    const launchFailure = { ok: false, item: null, state: null, message: "Fixture does not create native windows" };
    const start = t.mock.method(runtime, "startRuntime", async () => launchFailure);
    t.mock.method(windows, "closeForDisposal", async () => undefined);
    const releaseMarket = windows.beginDisposal(view.id);
    const releaseFirstExplicit = windows.beginDisposal(view.id, { closeImmediately: false, preventRuntimeStart: true });
    const releaseLastExplicit = windows.beginDisposal(view.id, { closeImmediately: false, preventRuntimeStart: true });
    try {
      releaseFirstExplicit();
      releaseFirstExplicit();
      assert.equal(runtime.isDisposing(view.id), true, "repeating one release must not consume the other explicit lease");
      if (firstReleased === "runtime") {
        releaseLastExplicit();
        releaseLastExplicit();
        assert.equal(runtime.isDisposing(view.id), false);
        assert.equal(await runtime.start(view.app, view.id), launchFailure, "the remaining market lease must allow runtime startup validation");
        assert.equal(start.mock.callCount(), 1);
        assert.equal((await windows.open(view.app, view.id)).ok, false);
        assert.equal(start.mock.callCount(), 1, "the remaining market lease must still block independent-window opening");
        releaseMarket();
        releaseMarket();
      } else {
        releaseMarket();
        releaseMarket();
        assert.equal(runtime.isDisposing(view.id), true);
        assert.equal((await runtime.start(view.app, view.id)).ok, false);
        assert.equal((await runtime.restart(view.app, view.id)).ok, false);
        assert.equal((await windows.open(view.app, view.id)).ok, false);
        assert.equal(start.mock.callCount(), 0, "releasing the market lease must not release the explicit runtime lease");
        releaseLastExplicit();
        releaseLastExplicit();
      }
      assert.equal(runtime.isDisposing(view.id), false);
      const callsBeforeOpen = start.mock.callCount();
      assert.equal(await windows.open(view.app, view.id), launchFailure);
      assert.equal(start.mock.callCount(), callsBeforeOpen + 1, "after all leases end, window opening must reach runtime startup again");
    } finally {
      releaseFirstExplicit();
      releaseLastExplicit();
      releaseMarket();
    }
  });
}

test("concurrent starts share one in-flight launch and permit a fresh request after it finishes", async t => {
  const runtime = new WebappRuntime();
  const launch = deferred();
  const app = {};
  const id = "same-webapp";
  const result = { ok: true, state: { id, status: "running" } };
  const start = t.mock.method(runtime, "startRuntime", (targetApp, targetId) => {
    assert.equal(targetApp, app);
    assert.equal(targetId, id);
    return launch.promise;
  });
  const first = runtime.start(app, ` ${id} `);
  const second = runtime.start(app, id);
  assert.equal(start.mock.callCount(), 1);
  launch.resolve(result);
  const results = await Promise.all([first, second]);
  assert.equal(results[0], result);
  assert.equal(results[1], result);
  assert.equal(await runtime.start(app, id), result);
  assert.equal(start.mock.callCount(), 2, "settled launches must be removed from the pending map");
});

test("a rejected start releases its pending launch so the next request can retry", async t => {
  const runtime = new WebappRuntime();
  const launch = deferred();
  const failure = new Error("Launcher rejected");
  const result = { ok: true };
  let attempts = 0;
  t.mock.method(runtime, "startRuntime", () => ++attempts === 1 ? launch.promise : Promise.resolve(result));
  const first = runtime.start({}, "retry-webapp");
  const second = runtime.start({}, "retry-webapp");
  launch.reject(failure);
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(attempts, 1);
  assert.ok(outcomes.every(outcome => outcome.status === "rejected" && outcome.reason === failure));
  assert.equal(await runtime.start({}, "retry-webapp"), result);
  assert.equal(attempts, 2);
});

test("disposal rejects a new start even when an earlier launch is still pending", async t => {
  const runtime = new WebappRuntime();
  const launch = deferred();
  const id = "starting-webapp";
  const start = t.mock.method(runtime, "startRuntime", () => launch.promise);
  const first = runtime.start({}, id);
  const release = runtime.beginDisposal(id);
  try {
    assert.equal((await runtime.start({}, id)).ok, false);
    assert.equal((await runtime.restart({}, id)).ok, false);
    assert.equal(start.mock.callCount(), 1);
    launch.resolve({ ok: true });
    assert.equal((await first).ok, true);
  } finally {
    launch.resolve({ ok: true });
    release();
  }
});

for (const startedOk of [true, false]) {
  test(`stop waits for a pending start returning ok:${startedOk} before running cleanup`, async t => {
    const runtime = new WebappRuntime();
    const launch = deferred();
    const app = {};
    const id = "pending-start-webapp";
    const stopResult = { ok: true, state: { id, status: "stopped" } };
    const events = [];
    t.mock.method(runtime, "startRuntime", () => { events.push("start"); return launch.promise; });
    const stop = t.mock.method(runtime, "stopRuntime", async (targetApp, targetId, message) => {
      assert.equal(targetApp, app);
      assert.equal(targetId.trim(), id);
      assert.equal(message, "Stop fixture");
      events.push("stop");
      return stopResult;
    });
    const starting = runtime.start(app, id);
    const stopping = runtime.stop(app, ` ${id} `, "Stop fixture");
    await Promise.resolve();
    assert.equal(runtime.isDisposing(id), true);
    assert.equal((await runtime.start(app, id)).ok, false, "all stop callers must prevent new starts during cleanup");
    assert.equal(stop.mock.callCount(), 0, "cleanup must not race child or gateway creation");
    assert.deepEqual(events, ["start"]);
    launch.resolve({ ok: startedOk });
    await starting;
    assert.equal(await stopping, stopResult);
    assert.equal(runtime.isDisposing(id), false);
    assert.deepEqual(events, ["start", "stop"]);
  });
}

test("stop still cleans residual runtime resources after a pending start rejects", async t => {
  const runtime = new WebappRuntime();
  const launch = deferred();
  const failure = new Error("Partial startup rejected");
  const stopResult = { ok: true, state: { status: "stopped" } };
  t.mock.method(runtime, "startRuntime", () => launch.promise);
  const stop = t.mock.method(runtime, "stopRuntime", async () => stopResult);
  const starting = runtime.start({}, "partial-webapp");
  const stopping = runtime.stop({}, "partial-webapp");
  await Promise.resolve();
  assert.equal(stop.mock.callCount(), 0);
  launch.reject(failure);
  const [startOutcome, stopOutcome] = await Promise.allSettled([starting, stopping]);
  assert.equal(startOutcome.status, "rejected");
  assert.equal(startOutcome.reason, failure);
  assert.equal(stopOutcome.status, "fulfilled");
  assert.equal(stopOutcome.value, stopResult);
  assert.equal(stop.mock.callCount(), 1);
  assert.equal(runtime.isDisposing("partial-webapp"), false);
});

test("a thrown runtime cleanup releases the stop admission guard", async t => {
  const runtime = new WebappRuntime();
  const failure = new Error("Cleanup failed");
  t.mock.method(runtime, "stopRuntime", async () => { throw failure; });
  await assert.rejects(runtime.stop({}, "failed-stop"), error => error === failure);
  assert.equal(runtime.isDisposing("failed-stop"), false);
});

test("restart rechecks disposal after its pending stop and refuses to relaunch", async t => {
  const runtime = new WebappRuntime();
  const cleanup = deferred();
  const stopEntered = deferred();
  const id = "restarting-webapp";
  t.mock.method(runtime, "stopRuntime", () => { stopEntered.resolve(); return cleanup.promise; });
  const start = t.mock.method(runtime, "startRuntime", async () => ({ ok: true }));
  const restarting = runtime.restart({}, id);
  await stopEntered.promise;
  const release = runtime.beginDisposal(id);
  try {
    cleanup.resolve({ ok: true });
    assert.equal((await restarting).ok, false);
    assert.equal(start.mock.callCount(), 0);
  } finally {
    cleanup.resolve({ ok: true });
    release();
  }
});

test("a real frontend start immediately followed by stop leaves no live gateway", async t => {
  const view = disposalFixture(t);
  const runtime = new WebappRuntime(view.ports);
  try {
    const starting = runtime.start(view.app, view.id);
    const stopping = runtime.stop(view.app, view.id);
    const [started, stopped] = await Promise.all([starting, stopping]);
    assert.equal(started.ok, true, started.message);
    assert.equal(stopped.ok, true, stopped.message);
    assert.equal(stopped.state.status, "stopped");
    assert.equal(runtime.getStatus(view.app, view.id).status, "stopped");
    assert.deepEqual(runtime.listActivePorts(view.app), []);
    assert.ok(started.state.webUrl, "the fixture must actually create a gateway before stopping");
    await assert.rejects(fetch(started.state.webUrl, { signal: AbortSignal.timeout(500) }));
    assertSentinelsPreserved(view);
  } finally {
    await runtime.stopAll(view.app);
  }
});

class FakeGuest extends EventEmitter {
  constructor(id, destroyed = false) {
    super();
    this.id = id;
    this.destroyed = destroyed;
  }
  isDestroyed() { return this.destroyed; }
  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

test("guest closure resolves after destruction and removes only its own listener", async () => {
  const guest = new FakeGuest(1);
  const existingListener = () => undefined;
  guest.on("destroyed", existingListener);
  const command = waitForWebappGuestsClosed([guest], 50);
  assert.equal(guest.listenerCount("destroyed"), 2);
  guest.destroy();
  assert.equal(await command, true);
  assert.deepEqual(guest.listeners("destroyed"), [existingListener]);
});

test("empty or already destroyed guests resolve without installing listeners", async () => {
  const guest = new FakeGuest(1, true);
  assert.equal(await waitForWebappGuestsClosed([], 10), true);
  assert.equal(await waitForWebappGuestsClosed([guest], 10), true);
  assert.equal(guest.listenerCount("destroyed"), 0);
});

test("guest closure waits for every unique guest and removes all temporary listeners", async () => {
  const first = new FakeGuest(1);
  const second = new FakeGuest(2);
  let settled = false;
  const command = waitForWebappGuestsClosed([first, second, first], 50).then(result => {
    settled = true;
    return result;
  });
  assert.equal(first.listenerCount("destroyed"), 1, "duplicate guest references must share one listener");
  first.destroy();
  await Promise.resolve();
  assert.equal(settled, false);
  second.destroy();
  assert.equal(await command, true);
  assert.equal(first.listenerCount("destroyed"), 0);
  assert.equal(second.listenerCount("destroyed"), 0);
});

test("guest closure timeout reports live guests and cleans up every listener", async () => {
  const closed = new FakeGuest(1);
  const stillOpen = new FakeGuest(2);
  const command = waitForWebappGuestsClosed([closed, stillOpen], 15);
  closed.destroy();
  assert.equal(await command, false);
  assert.equal(closed.listenerCount("destroyed"), 0);
  assert.equal(stillOpen.listenerCount("destroyed"), 0);
  stillOpen.destroy();
  assert.equal(stillOpen.listenerCount("destroyed"), 0);
});

test("guest destruction during listener registration does not leave a dangling listener", async () => {
  class ClosingGuest extends FakeGuest {
    once(event, listener) {
      const result = super.once(event, listener);
      this.destroy();
      return result;
    }
  }
  const guest = new ClosingGuest(1);
  assert.equal(await waitForWebappGuestsClosed([guest], 50), true);
  assert.equal(guest.listenerCount("destroyed"), 0);
});

test("Windows directory removal delegates bounded lock retries to Node", async t => {
  const calls = [];
  t.mock.method(fs.promises, "rm", async (...args) => { calls.push(args); });
  await removeWebappDirectory("D:\\fixture\\webapp", "win32");
  assert.deepEqual(calls, [["D:\\fixture\\webapp", {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  }]]);
});

test("macOS directory removal uses its own deletion options without Windows retry settings", async t => {
  const calls = [];
  t.mock.method(fs.promises, "rm", async (...args) => { calls.push(args); });
  await removeWebappDirectory("/fixture/webapp", "darwin");
  assert.deepEqual(calls, [["/fixture/webapp", { recursive: true, force: true }]]);
});

for (const platform of ["win32", "darwin"]) {
  test(`${platform} directory removal preserves the original EPERM error`, async t => {
    const error = Object.assign(new Error("The directory is still locked"), {
      code: "EPERM", syscall: "rm", path: "fixture-webapp",
    });
    const rm = t.mock.method(fs.promises, "rm", async () => { throw error; });
    await assert.rejects(removeWebappDirectory("fixture-webapp", platform), failure => failure === error);
    assert.equal(rm.mock.callCount(), 1, "the platform adapter delegates retries to Node rather than retrying internally");
  });
}

const surfaceSource = fs.readFileSync(new URL("../src/main/modules/webs/surface-runtime.ts", import.meta.url), "utf8");
const surfaceAst = ts.createSourceFile("surface-runtime.ts", surfaceSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let presentationWaiter;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "waitForWebappPresentationClosed") presentationWaiter = node;
  ts.forEachChild(node, visit);
}
visit(surfaceAst);
assert.ok(presentationWaiter, "Web surface runtime must define the WebApp presentation waiter");
const presentationScript = ts.transpileModule(`(() => {
  ${presentationWaiter.getText(surfaceAst)}
  return waitForWebappPresentationClosed;
})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("presentation cleanup waits only for exact WebApp entry guests across its registered surfaces", async () => {
  const primary = new FakeGuest(101);
  const workpanel = new FakeGuest(102);
  const otherApp = new FakeGuest(201);
  const website = new FakeGuest(301);
  const guests = new Map([primary, workpanel, otherApp, website].map(guest => [guest.id, guest]));
  const lookups = [];
  const waitedFor = [];
  const run = vm.runInNewContext(presentationScript, {
    browserSurfaceRegistry: {
      listRegisteredSurfaces: () => [
        { surfaceRole: "webapp", entryKey: "webapp:target", tabs: [{ webContentsId: 101 }, { webContentsId: 999 }] },
        { surfaceRole: "webapp", entryKey: "webapp:target", tabs: [{ webContentsId: 102 }, { webContentsId: 101 }] },
        { surfaceRole: "webapp", entryKey: "webapp:target-extra", tabs: [{ webContentsId: 201 }] },
        { surfaceRole: "website", entryKey: "webapp:target", tabs: [{ webContentsId: 301 }] },
      ],
      findWebContentsById(id) { lookups.push(id); return guests.get(id) ?? null; },
    },
    waitForWebappGuestsClosed(selectedGuests) {
      waitedFor.push(...selectedGuests);
      return waitForWebappGuestsClosed(selectedGuests, 50);
    },
  });
  let settled = false;
  const command = run("target").then(result => { settled = true; return result; });
  assert.deepEqual(lookups, [101, 999, 102, 101]);
  assert.deepEqual(waitedFor.map(guest => guest.id), [101, 102, 101]);
  assert.equal(otherApp.listenerCount("destroyed"), 0);
  assert.equal(website.listenerCount("destroyed"), 0);
  primary.destroy();
  await Promise.resolve();
  assert.equal(settled, false);
  workpanel.destroy();
  assert.equal(await command, true);
  assert.equal(otherApp.isDestroyed(), false);
  assert.equal(website.isDestroyed(), false);
  assert.equal(primary.listenerCount("destroyed"), 0);
  assert.equal(workpanel.listenerCount("destroyed"), 0);
});

test("presentation cleanup resolves when the WebApp has no registered guests", async () => {
  const run = vm.runInNewContext(presentationScript, {
    browserSurfaceRegistry: {
      listRegisteredSurfaces: () => [],
      findWebContentsById() { assert.fail("No guest lookup is needed without matching surfaces"); },
    },
    waitForWebappGuestsClosed,
  });
  assert.equal(await run("absent-app"), true);
});
