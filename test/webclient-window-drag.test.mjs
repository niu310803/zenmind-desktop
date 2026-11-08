import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({ stdin: { contents: `export * from './src/renderer/service-webview/windowDragHost';
export * from './src/shared/webclient-window-drag';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: "browser", format: "esm" });
const { createWebclientWindowDragHost: createHost, WEBCLIENT_WINDOW_DRAG_CHANNEL: channel,
  parseWebclientWindowDragMessage: parse } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
const documentId = "12345678-1234-1234-1234-123456789abc";
const previousId = "22345678-1234-1234-1234-123456789abc";
const origin = "http://127.0.0.1:1234";
const message = (action, id = documentId) => ({ version: "1.0", documentId: id, origin, action });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
class Guest extends EventTarget {
  url = origin + "/agent/a";
  sent = [];
  attrs = new Map();
  getURL() { return this.url; }
  send(channel, payload) { this.sent.push({ channel, payload }); }
  setAttribute(key, value) { this.attrs.set(key, value); }
  removeAttribute(key) { this.attrs.delete(key); }
  request(action, id = documentId, change = {}) {
    this.dispatchEvent(Object.assign(new Event("ipc-message"), { channel, args: [{ ...message(action, id), ...change }] }));
  }
}
function setup() {
  const webview = new Guest();
  const calls = [];
  let height = 40;
  let current = true;
  const host = createHost({ webview, trustedUrl: () => origin, isCurrentGuest: () => current,
    readHeight: () => height, begin: async () => { calls.push("begin"); return { ok: true }; },
    end: async () => { calls.push("end"); }, maximize: async () => { calls.push("maximize"); } });
  return { webview, host, calls, setHeight: value => height = value, setCurrent: value => current = value };
}
test("only the current trusted document negotiates the 40px lane and window actions", async () => {
  const s = setup();
  s.webview.request("begin"); await flush(); assert.deepEqual(s.calls, []);
  s.webview.request("ready", documentId, { origin: "https://foreign.test" });
  assert.equal(s.webview.attrs.size, 0);
  s.webview.request("ready");
  assert.equal(s.webview.sent.at(-1).payload.height, 40);
  assert.equal(s.webview.attrs.get("data-window-drag-ready"), "true");
  s.webview.request("begin", previousId); await flush(); assert.deepEqual(s.calls, []);
  s.webview.request("begin"); await flush();
  s.webview.request("end"); s.webview.request("maximize"); await flush();
  assert.deepEqual(s.calls, ["begin", "end", "maximize"]);
  s.webview.url = "https://foreign.test/agent/a";
  s.webview.request("begin"); await flush();
  assert.equal(s.calls.length, 3);
  s.host.dispose();
  for (const invalid of [{ ...message("begin"), x: 0 }, message("move"), message("begin", "forged")]) assert.equal(parse(invalid), null);
});
test("disable, navigation, guest replacement and disposal end an active drag", async () => {
  for (const reason of ["disabled", "navigation", "replacement", "disposed"]) {
    const s = setup(); s.webview.request("ready"); s.webview.request("begin"); await flush();
    if (reason === "disabled") { s.setHeight(0); s.host.refresh(); }
    if (reason === "replacement") { s.setCurrent(false); s.host.refresh(); }
    if (reason === "navigation") s.webview.dispatchEvent(Object.assign(new Event("did-start-navigation"), { isMainFrame: true, isInPlace: false }));
    if (reason === "disposed") s.host.dispose();
    await flush();
    assert.deepEqual(s.calls, ["begin", "end"], reason);
    assert.equal(s.webview.attrs.size, 0, reason);
    s.webview.request("begin", previousId); await flush(); assert.equal(s.calls.length, 2);
    s.host.dispose();
  }
});
test("rapid press/release and disabled Windows/fullscreen lanes cannot leave dragging active", async () => {
  const s = setup(); s.webview.request("ready");
  s.webview.request("begin"); s.webview.request("end"); await flush();
  assert.equal(s.calls.at(-1), "end");
  s.calls.length = 0; s.setHeight(0); s.host.refresh();
  s.webview.request("begin"); s.webview.request("maximize"); await flush();
  assert.deepEqual(s.calls, []); assert.equal(s.webview.sent.at(-1).payload.height, 0);
  s.host.dispose();
});

test("a cancelled queued press or stale document double click cannot affect the next gesture", async () => {
  const s = setup(); s.webview.request("ready");
  s.webview.request("begin"); s.webview.request("end"); s.webview.request("begin"); await flush();
  assert.deepEqual(s.calls, ["end", "begin"], "only the current press begins");
  s.webview.request("end"); s.webview.request("maximize");
  s.webview.dispatchEvent(Object.assign(new Event("did-start-navigation"), { isMainFrame: true, isInPlace: false }));
  s.webview.request("ready", previousId); await flush();
  assert.equal(s.calls.includes("maximize"), false);
  s.host.dispose();
});
