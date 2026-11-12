import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const modulePath = require.resolve("../dist-electron/main/modules/webs/webapps/window-manager.js");

function fixture() {
  class Guest extends EventEmitter {
    destroyed = false;
    loads = [];
    isDestroyed() { return this.destroyed; }
    async loadURL(url) { this.loads.push(url); }
    close() { this.destroyed = true; this.emit("destroyed"); }
    setWindowOpenHandler() {}
  }
  class Window extends EventEmitter {
    destroyed = false;
    webContents = new Guest();
    contentView = { addChildView() {}, removeChildView() {} };
    constructor(options) { super(); this.options = options; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    getContentBounds() { return { width: 800, height: 600 }; }
    setMenuBarVisibility() {}
    setTitle() {}
    show() {}
    focus() {}
    moveTop() {}
    async loadURL() {}
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  class View {
    webContents = new Guest();
    constructor(options) { this.options = options; }
    setBounds() {}
  }
  let item = { kind: "webapp", id: "platform-window", hosting: "platform", label: "Platform", version: "1.0.0" };
  let state = { id: item.id, version: item.version, status: "running", webUrl: "http://127.0.0.1:43211/" };
  const tickets = [];
  let stops = 0;
  const runtime = {
    isDisposing: () => false,
    getStatus: () => state,
    start: async () => ({ ok: true, item, state, message: "Started" }),
    stop: async () => { stops++; return { ok: true, item, state }; },
    platformInstances: { openGuest: async (_app, id, guest) => { tickets.push({ id, guest }); } },
  };
  const output = { exports: {} };
  const scopedRequire = createRequire(modulePath);
  const wrapper = vm.runInThisContext(`(function(require, module, exports) { ${fs.readFileSync(modulePath, "utf8")}\n})`);
  wrapper(name => {
    if (name === "electron") return { BrowserWindow: Window, WebContentsView: View, shell: {} };
    if (name === "./runtime") return { webappRuntime: runtime };
    if (name === "./store") return { readWebappItems: () => [item] };
    return scopedRequire(name);
  }, output, output.exports);
  const manager = new output.exports.WebappWindowManager(undefined, runtime);
  return {
    manager, tickets, app: { isPackaged: false },
    get stops() { return stops; },
    get state() { return state; },
    replace() { item = { ...item, version: "2.0.0" }; state = { ...state, version: item.version }; },
  };
}

test("Platform native window open, reload and replacement restore all exchange a ticket on isolated guests", async () => {
  const f = fixture();
  assert.equal((await f.manager.open(f.app, "platform-window")).ok, true);
  const window = f.manager.getWindow("platform-window");
  assert.equal(window.options.webPreferences.partition, "webapp-platform:platform-window");
  const first = f.tickets[0].guest;
  assert.deepEqual(first.loads, []);
  await f.manager.reload("platform-window", f.state);
  assert.equal(f.tickets.length, 2);
  assert.equal(f.tickets[1].guest, first);
  const replacement = f.manager.beginReplacement("platform-window");
  await replacement.suspend();
  assert.equal(first.isDestroyed(), true);
  f.replace();
  await replacement.finish(f.app, f.state);
  assert.equal(f.manager.getWindow("platform-window"), window);
  assert.equal(f.tickets.length, 3);
  assert.notEqual(f.tickets[2].guest, first);
  assert.deepEqual(f.tickets[2].guest.loads, []);
  window.destroy();
  assert.equal(f.stops, 0);
});

test("closing a Platform native window during replacement does not reopen it or stop its independent runtime", async () => {
  const f = fixture();
  await f.manager.open(f.app, "platform-window");
  const replacement = f.manager.beginReplacement("platform-window");
  await replacement.suspend();
  f.manager.getWindow("platform-window").destroy();
  f.replace();
  await replacement.finish(f.app, f.state);
  assert.equal(f.manager.getWindow("platform-window"), null);
  assert.equal(f.tickets.length, 1);
  assert.equal(f.stops, 0);
});
