import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
const { configureAttachedWebview } = await import("../dist-electron/main/modules/shell/webview-events.js");
const { DESKTOP_OPEN_PROTOCOL_SCHEME } = await import("../dist-electron/shared/brand.js");
const link = `${DESKTOP_OPEN_PROTOCOL_SCHEME}://navigate?path=%2Fsettings%2Fbrowser`;
function fixture(platform, help = true) {
  let current = "https://help.example.test/help/";
  const queued = [], navigated = [], external = [];
  const guest = Object.assign(new EventEmitter(), {
    id: 77, getURL: () => current, isDestroyed: () => false,
    setWindowOpenHandler(handler) { this.popup = handler; },
  });
  configureAttachedWebview(guest, {
    platform, getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    isDevToolsShortcut: () => false, shouldDownloadUrl: () => false,
    resolveOpenDisposition: () => "tab", report() {}, collectLoadDiagnostics: async () => ({}),
    getHelpUrl: () => "https://help.example.test/help/", isHelpWebview: () => help,
    navigateMainWindow: path => navigated.push(path), openExternal: async url => external.push(url),
    schedule: fn => queued.push(fn),
  });
  return { guest, queued, navigated, external, changeSource(url) { current = url; } };
}
for (const platform of ["darwin", "win32"]) {
  test(`${platform} Help handles direct and popup links without external launch`, () => {
    const f = fixture(platform); let prevented = false;
    f.guest.emit("will-navigate", { preventDefault() { prevented = true; } }, link);
    assert.equal(prevented, true); f.queued.shift()();
    assert.deepEqual(f.navigated, ["/settings/browser"]);
    assert.deepEqual(f.guest.popup({ url: link }), { action: "deny" }); f.queued.shift()();
    assert.deepEqual(f.navigated, ["/settings/browser", "/settings/browser"]);
    assert.deepEqual(f.external, []);
  });
  test(`${platform} Help revalidates its source and rejects redirects and foreign guests`, () => {
    const f = fixture(platform);
    f.guest.emit("will-navigate", { preventDefault() {} }, link);
    f.changeSource("https://other.example.test/"); f.queued.shift()();
    assert.deepEqual(f.navigated, []);
    f.guest.emit("will-navigate", { preventDefault() {} }, link);
    assert.equal(f.queued.length, 0);
    const redirect = fixture(platform);
    redirect.guest.emit("will-redirect", { preventDefault() {} }, link);
    assert.equal(redirect.queued.length, 0);
    const ordinary = fixture(platform, false);
    ordinary.guest.emit("will-navigate", { preventDefault() {} }, link);
    assert.equal(ordinary.queued.length, 0);
  });
}
