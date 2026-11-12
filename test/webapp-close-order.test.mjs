import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function parseSource(relativePath) {
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function visitNodes(root, visitor) {
  visitor(root);
  ts.forEachChild(root, node => visitNodes(node, visitor));
}

function transpileExpression(expression) {
  return ts.transpileModule(expression, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const appShell = parseSource("../src/renderer/app-shell/AppShell.tsx");
const rendererHandlerNames = [
  "removeWebappItem", "handleCloseWebEntry", "ensureWebappRuntimeStarted",
  "handleWebappRuntimeStateChange", "handleWebsChanged", "updateWebItems",
];
const rendererHandlers = new Map();
visitNodes(appShell, node => {
  if (ts.isFunctionDeclaration(node) && rendererHandlerNames.includes(node.name?.text)) {
    rendererHandlers.set(node.name.text, node.getText(appShell));
  }
});
for (const name of rendererHandlerNames) assert.ok(rendererHandlers.has(name), `AppShell must define ${name}`);
const rendererScript = transpileExpression(`(() => {
  ${[...rendererHandlers.values()].join("\n")}
  return { ${rendererHandlerNames.join(", ")} };
})()`);

const webIpc = parseSource("../src/main/modules/webs/ipc.ts");
let stopHandler;
visitNodes(webIpc, node => {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "handle" && ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "webs.webapps.stop") {
    stopHandler = node.arguments[1];
  }
});
assert.ok(stopHandler, "The WebApp stop IPC handler must exist");
const stopScript = transpileExpression(`(${stopHandler.getText(webIpc)})`);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const item = {
  kind: "webapp",
  id: "webapp-close-order",
  entryKey: "webapp:webapp-close-order",
  label: "Close order fixture",
};
const stoppedState = { id: item.id, status: "stopped", webUrl: "", pid: null };
const stoppedResult = { ok: true, item, state: stoppedState, message: "Stopped" };
const removedResult = { ok: true, item, items: [], message: "Removed" };

function rendererFixture({
  active = true,
  owner = { scope: "workpanel", ownerChatId: "chat-keep", itemId: "panel-keep" },
  uninstall = async () => removedResult,
  stop = async () => stoppedResult,
  start = async () => ({ ok: true, state: { id: item.id, status: "running", webUrl: "http://127.0.0.1:43210/" } }),
} = {}) {
  const calls = { uninstall: [], stop: [], dispose: [], restore: [], navigate: [], refresh: 0 };
  const originalOwner = owner;
  const state = {
    owner,
    mounted: [item.entryKey, "website:keep"],
    runtimes: { [item.id]: { status: "running", webUrl: "http://127.0.0.1:43210/" }, keep: { status: "running" } },
  };
  const context = {
    Error,
    activeWebEntryKey: active ? item.entryKey : "website:keep",
    activeWebEntryKeyRef: { current: active ? item.entryKey : "website:keep" },
    EMPTY_WEB_SURFACE_ROUTE: "/webs",
    webappStartInFlightRef: { current: new Map() },
    webappStopInFlightRef: { current: new Set() },
    webItemsRef: { current: [item] },
    webItemsRefreshIdRef: { current: 0 },
    replacingWebappIdsRef: { current: new Set() },
    setReplacingWebappIds(ids) { state.replacing = ids; },
    setWebItems() {},
    setWebItemsLoaded() {},
    setWebGroupOrder() {},
    setFaviconCache() {},
    webappRuntimeById: state.runtimes,
    t: key => key,
    requestSidebarNavigation(route) { calls.navigate.push(route); },
    disposeWebappPresentation(target) {
      calls.dispose.push(target.id);
      state.owner = null;
      state.mounted = state.mounted.filter(key => key !== target.entryKey);
    },
    moveWebappPresentationToMain(target) {
      calls.restore.push(target.id);
      state.owner = { scope: "main-workspace" };
    },
    setWebappRuntimeById(update) { state.runtimes = typeof update === "function" ? update(state.runtimes) : update; },
    setMountedWebEntryKeys(update) { state.mounted = typeof update === "function" ? update(state.mounted) : update; },
    async refreshWebItems() { calls.refresh += 1; },
  };
  context.window = { electronAPI: { webs: { webapps: {
    start,
    async uninstall(id) {
      calls.uninstall.push(id);
      assert.equal(context.webappStopInFlightRef.current.has(id), true, "uninstall must block automatic starts before entering IPC");
      return uninstall(id);
    },
    async stop(id) {
      calls.stop.push(id);
      assert.equal(context.webappStopInFlightRef.current.has(id), true, "stop must block automatic starts before entering IPC");
      return stop(id);
    },
  } } } };
  return { context, calls, state, originalOwner, handlers: vm.runInNewContext(rendererScript, context) };
}

function assertPresentationPreserved(view) {
  assert.deepEqual(view.calls.dispose, [], "the live presentation must remain until stopping succeeds");
  assert.deepEqual(view.calls.navigate, [], "the active route must remain until stopping succeeds");
  assert.deepEqual(view.calls.restore, [], "failure must not move an existing WorkPanel or dialog into the main workspace");
  assert.equal(view.state.owner, view.originalOwner);
  assert.equal(view.state.mounted.includes(item.entryKey), true);
}

function assertGuardReleased(view) {
  assert.equal(view.context.webappStopInFlightRef.current.has(item.id), false);
}

test("renderer uninstall keeps the live presentation while Main stops and closes it, and blocks duplicate requests", async () => {
  const removal = deferred();
  const view = rendererFixture({ uninstall: () => removal.promise });
  const first = view.handlers.removeWebappItem(item);
  assertPresentationPreserved(view);
  assert.equal(view.context.webappStopInFlightRef.current.has(item.id), true);
  const duplicate = view.handlers.removeWebappItem(item);
  const callCountWhilePending = view.calls.uninstall.length;
  removal.resolve(removedResult);
  await Promise.all([first, duplicate]);
  assert.equal(callCountWhilePending, 1, "a repeated uninstall must not enter IPC twice");
  assert.deepEqual(view.calls.uninstall, [item.id]);
  assert.deepEqual(view.calls.dispose, [item.id]);
  assert.deepEqual(view.calls.navigate, [view.context.EMPTY_WEB_SURFACE_ROUTE]);
  assert.equal(view.state.mounted.includes(item.entryKey), false);
  assert.equal(item.id in view.state.runtimes, false);
  assert.equal(view.state.runtimes.keep.status, "running");
  assertGuardReleased(view);
});

test("renderer uninstall failure preserves its original dialog or WorkPanel ownership and permits retry", async () => {
  for (const owner of [{ scope: "dialog" }, { scope: "workpanel", ownerChatId: "chat-original", itemId: "item-original" }]) {
    let attempts = 0;
    const failure = { ok: false, item, items: [item], message: "Runtime is still stopping" };
    const view = rendererFixture({ owner, uninstall: async () => ++attempts === 1 ? failure : removedResult });
    const result = await view.handlers.removeWebappItem(item);
    assert.equal(result.ok, false);
    assert.equal(result.message, failure.message);
    assertPresentationPreserved(view);
    assertGuardReleased(view);
    await view.handlers.removeWebappItem(item);
    assert.equal(attempts, 2);
    assert.deepEqual(view.calls.dispose, [item.id]);
    assertGuardReleased(view);
  }
});

test("renderer uninstall rejection leaves the page open and releases its operation guard", async () => {
  const view = rendererFixture({ uninstall: async () => { throw new Error("IPC uninstall rejected"); } });
  await assert.rejects(view.handlers.removeWebappItem(item), /IPC uninstall rejected/u);
  assertPresentationPreserved(view);
  assertGuardReleased(view);
});

test("uninstalling a background WebApp preserves the unrelated active route", async () => {
  const view = rendererFixture({ active: false });
  await view.handlers.removeWebappItem(item);
  assert.deepEqual(view.calls.navigate, []);
  assert.deepEqual(view.calls.dispose, [item.id]);
  assertGuardReleased(view);
});

test("ZIP replacement keeps the original main or WorkPanel presentation through intermediate stopped and missing snapshots", () => {
  const newRuntime = { id: item.id, status: "running", webUrl: "http://127.0.0.1:43211/" };
  for (const owner of [{ scope: "main-workspace" }, { scope: "workpanel", ownerChatId: "chat-keep", itemId: "tab-keep" }]) {
    const view = rendererFixture({ owner, active: owner.scope === "main-workspace" });
    view.handlers.handleWebsChanged({ phase: "replacing", webappId: item.id });
    assert.equal(view.state.replacing.has(item.id), true);
    view.handlers.updateWebItems([]);
    view.handlers.handleWebappRuntimeStateChange(item.id, stoppedState);
    assert.equal(view.context.webItemsRef.current[0], item);
    assertPresentationPreserved(view);
    view.handlers.handleWebsChanged({ phase: "replacement-finished", webappId: item.id, webappRuntimeState: newRuntime });
    assertPresentationPreserved(view);
    assert.equal(view.state.replacing.has(item.id), false);
    assert.equal(view.state.runtimes[item.id].webUrl, newRuntime.webUrl);
  }
});

test("ZIP replacement does not reopen a WorkPanel tab closed during replacement", () => {
  const view = rendererFixture({ active: false });
  view.handlers.handleWebsChanged({ phase: "replacing", webappId: item.id });
  view.context.disposeWebappPresentation(item);
  view.handlers.handleWebsChanged({
    phase: "replacement-finished", webappId: item.id,
    webappRuntimeState: { id: item.id, status: "running", webUrl: "http://127.0.0.1:43211/" },
  });
  assert.equal(view.state.owner, null);
  assert.equal(view.state.mounted.includes(item.entryKey), false);
  assert.deepEqual(view.calls.navigate, []);
});

test("a late start response from the old package cannot overwrite the replacement gateway", async () => {
  const start = deferred();
  const view = rendererFixture({ start: () => start.promise });
  view.context.webappRuntimeById = {};
  const starting = view.handlers.ensureWebappRuntimeStarted(item);
  view.handlers.handleWebsChanged({ phase: "replacing", webappId: item.id });
  view.handlers.handleWebsChanged({
    phase: "replacement-finished", webappId: item.id,
    webappRuntimeState: { id: item.id, status: "running", webUrl: "http://127.0.0.1:43211/" },
  });
  start.resolve({ ok: true, state: { id: item.id, status: "running", webUrl: "http://127.0.0.1:43210/" } });
  await starting;
  assert.equal(view.state.runtimes[item.id].webUrl, "http://127.0.0.1:43211/");
  assertPresentationPreserved(view);
});

test("renderer close waits for a successful runtime stop before closing its page and suppresses duplicate stops", async () => {
  const stopping = deferred();
  const view = rendererFixture({ stop: () => stopping.promise });
  const first = view.handlers.handleCloseWebEntry(item);
  assertPresentationPreserved(view);
  assert.equal(view.context.webappStopInFlightRef.current.has(item.id), true);
  const duplicate = view.handlers.handleCloseWebEntry(item);
  const callCountWhilePending = view.calls.stop.length;
  stopping.resolve(stoppedResult);
  await Promise.all([first, duplicate]);
  assert.equal(callCountWhilePending, 1, "a repeated close must not stop the same runtime twice");
  assert.deepEqual(view.calls.stop, [item.id]);
  assert.deepEqual(view.calls.dispose, [item.id]);
  assert.deepEqual(view.calls.navigate, [view.context.EMPTY_WEB_SURFACE_ROUTE]);
  assert.equal(view.state.mounted.includes(item.entryKey), false);
  assert.equal(view.state.runtimes[item.id].status, "idle");
  assertGuardReleased(view);
});

test("renderer close does not destroy or navigate away from a WebApp whose stop failed", async () => {
  const view = rendererFixture({ stop: async () => ({ ok: false, state: { status: "error" }, message: "Backend still running" }) });
  await assert.rejects(view.handlers.handleCloseWebEntry(item), /Backend still running/u);
  assertPresentationPreserved(view);
  assertGuardReleased(view);
});

test("renderer close rejection preserves the page and releases its guard", async () => {
  const view = rendererFixture({ stop: async () => { throw new Error("IPC stop rejected"); } });
  await assert.rejects(view.handlers.handleCloseWebEntry(item), /IPC stop rejected/u);
  assertPresentationPreserved(view);
  assertGuardReleased(view);
});

test("close and uninstall share a guard so neither can race the other for the same WebApp", async () => {
  for (const firstOperation of ["removeWebappItem", "handleCloseWebEntry"]) {
    const pending = deferred();
    const view = rendererFixture({ uninstall: () => pending.promise, stop: () => pending.promise });
    const first = view.handlers[firstOperation](item);
    const otherOperation = firstOperation === "removeWebappItem" ? "handleCloseWebEntry" : "removeWebappItem";
    const second = view.handlers[otherOperation](item);
    const totalCallsWhilePending = view.calls.stop.length + view.calls.uninstall.length;
    pending.resolve(firstOperation === "removeWebappItem" ? removedResult : stoppedResult);
    await Promise.all([first, second]);
    assert.equal(totalCallsWhilePending, 1, "close and uninstall must not issue overlapping operations for the same instance");
    assertGuardReleased(view);
  }
});

test("closing a Website keeps its existing synchronous close behavior and does not call WebApp lifecycle APIs", async () => {
  const website = { kind: "website", id: "keep", entryKey: "website:keep" };
  const view = rendererFixture({ active: false });
  await view.handlers.handleCloseWebEntry(website);
  assert.deepEqual(view.calls.stop, []);
  assert.deepEqual(view.calls.uninstall, []);
  assert.deepEqual(view.calls.dispose, []);
  assert.deepEqual(view.calls.navigate, [view.context.EMPTY_WEB_SURFACE_ROUTE]);
  assert.equal(view.state.mounted.includes(website.entryKey), false);
  assert.equal(view.context.webappStopInFlightRef.current.size, 0);
});

function ipcFixture({ stop = async () => stoppedResult, close = async () => undefined } = {}) {
  const calls = [];
  const guard = { active: new Set(), acquired: 0, released: 0 };
  const app = { fixture: "webapp-close-order" };
  const context = {
    Error,
    app,
    t: key => key,
    webappManager: { runtime: {
      isDisposing: id => guard.active.has(id),
      async stop(targetApp, id) {
        assert.equal(targetApp, app);
        assert.equal(guard.active.has(id), true, "stop must prevent reopening the independent window before entering runtime cleanup");
        calls.push(["stop", id]);
        return stop(id);
      },
    } },
    webappWindowManager: {
      beginDisposal(id, options) {
        assert.equal(options.closeImmediately, false, "acquiring the stop guard must preserve the live presentation");
        assert.equal(options.preventRuntimeStart, true, "explicit stop must block backend restarts as well as window reopening");
        assert.equal(guard.active.has(id), false);
        guard.active.add(id);
        guard.acquired += 1;
        return () => {
          assert.equal(guard.active.has(id), true, "each acquired stop guard must be released exactly once");
          guard.active.delete(id);
          guard.released += 1;
        };
      },
      async closeForDisposal(id) {
        assert.equal(guard.active.has(id), true, "window reopening must remain blocked until guest cleanup finishes");
        calls.push(["closeForDisposal", id]);
        return close(id);
      },
      close(id) { calls.push(["close", id]); throw new Error("Stop must await closeForDisposal"); },
    },
  };
  return { calls, guard, run: vm.runInNewContext(stopScript, context) };
}

function assertIpcGuardReleased(view) {
  assert.equal(view.guard.active.size, 0, "stop must release the independent-window guard on every exit path");
  assert.equal(view.guard.acquired, 1);
  assert.equal(view.guard.released, 1);
}

test("stop IPC waits for runtime success, then waits for guest closure before reporting success", async () => {
  const stopping = deferred();
  const closing = deferred();
  const view = ipcFixture({ stop: () => stopping.promise, close: () => closing.promise });
  let settled = false;
  const command = view.run({}, item.id).finally(() => { settled = true; });
  assert.deepEqual(view.calls, [["stop", item.id]]);
  assert.equal(view.guard.active.has(item.id), true);
  assert.equal(view.guard.released, 0);
  assert.equal((await view.run({}, item.id)).ok, false, "a competing stop cannot close the guest during disposal");
  stopping.resolve(stoppedResult);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(view.calls, [["stop", item.id], ["closeForDisposal", item.id]]);
  assert.equal(settled, false, "stopped runtime is insufficient until its presentation has closed");
  assert.equal(view.guard.active.has(item.id), true);
  assert.equal(view.guard.released, 0);
  closing.resolve();
  const result = await command;
  assert.equal(result.ok, true);
  assert.equal(result.state, stoppedState);
  assertIpcGuardReleased(view);
});

test("stop IPC preserves the live window when runtime stop reports failure", async () => {
  const failure = { ok: false, state: { status: "error" }, message: "Process is still running" };
  const view = ipcFixture({ stop: async () => failure });
  const result = await view.run({}, item.id);
  assert.equal(result.ok, false);
  assert.equal(result.message, failure.message);
  assert.deepEqual(view.calls, [["stop", item.id]]);
  assertIpcGuardReleased(view);
});

test("stop IPC does not close the window after a thrown stop failure", async () => {
  const view = ipcFixture({ stop: async () => { throw new Error("Stop failed unexpectedly"); } });
  const [outcome] = await Promise.allSettled([view.run({}, item.id)]);
  if (outcome.status === "rejected") {
    assert.match(outcome.reason.message, /Stop failed unexpectedly/u);
  } else {
    assert.equal(outcome.value.ok, false);
    assert.match(outcome.value.message, /Stop failed unexpectedly/u);
  }
  assert.deepEqual(view.calls, [["stop", item.id]]);
  assertIpcGuardReleased(view);
});

test("stop IPC reports closure errors as failure while retaining the successfully stopped runtime state", async () => {
  const view = ipcFixture({ close: async () => { throw new Error("Guest did not close"); } });
  const result = await view.run({}, item.id);
  assert.equal(result.ok, false);
  assert.equal(result.state, stoppedState);
  assert.match(result.message, /Guest did not close/u);
  assert.deepEqual(view.calls, [["stop", item.id], ["closeForDisposal", item.id]]);
  assertIpcGuardReleased(view);
});
