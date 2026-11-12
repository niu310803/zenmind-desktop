import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ChatFileDrag } = require("../dist-electron/main/modules/assistant/chat-file-drag.js");
const { registerAssistantIpcHandlers } = require("../dist-electron/main/modules/assistant/ipc.js");
const request = () => ({ gestureId: randomUUID(), chatId: "chat-1" });

async function fixture(t, overrides = {}) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "chat-drag-test-"));
  const dragged = [];
  const drag = new ChatFileDrag({
    platform: "darwin", tempDirectory,
    download: async () => ({ ok: true, filename: "讨论.md", bytes: Buffer.from("# 对话\n你好\n") }),
    startDrag: file => dragged.push(file), failureMessage: () => "export failed", ...overrides,
  });
  t.after(async () => { await drag.dispose(); await fs.rm(tempDirectory, { recursive: true, force: true }); });
  return { drag, dragged, tempDirectory };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: stage Markdown, start exactly once, retain the file through native cancellation`, async t => {
    const { drag, dragged } = await fixture(t, { platform });
    const input = request();
    assert.deepEqual(await drag.prepare(input), { ok: true });
    assert.equal(drag.start(randomUUID()).ok, false);
    assert.equal(drag.start(input.gestureId).ok, true);
    drag.cancel(input.gestureId);
    assert.equal(drag.start(input.gestureId).ok, false);
    assert.equal(dragged.length, 1);
    assert.equal(path.basename(dragged[0]), "讨论.md");
    assert.equal(await fs.readFile(dragged[0], "utf8"), "# 对话\n你好\n");
  });
}

test("release before a slow export finishes does not recreate staged files or start a drag", async t => {
  let resolve;
  const { drag, dragged, tempDirectory } = await fixture(t, { download: () => new Promise(done => { resolve = done; }) });
  const input = request();
  const pending = drag.prepare(input);
  drag.cancel(input.gestureId);
  resolve({ ok: true, filename: "old.md", bytes: Buffer.from("late") });
  assert.equal((await pending).ok, false);
  assert.equal(drag.start(input.gestureId).ok, false);
  assert.deepEqual(dragged, []);
  assert.deepEqual(await fs.readdir(tempDirectory), []);
});

test("a superseded request cannot replace the current export", async t => {
  let resolve;
  const { drag, dragged } = await fixture(t, {
    download: id => id === "old" ? new Promise(done => { resolve = done; }) :
      Promise.resolve({ ok: true, filename: "new.md", bytes: Buffer.from("new") }),
  });
  const old = { ...request(), chatId: "old" };
  const current = request();
  const pending = drag.prepare(old);
  assert.equal((await drag.prepare(current)).ok, true);
  resolve({ ok: true, filename: "old.md", bytes: Buffer.from("old") });
  assert.equal((await pending).ok, false);
  drag.cancel(old.gestureId);
  assert.equal(drag.start(current.gestureId).ok, true);
  assert.equal(await fs.readFile(dragged[0], "utf8"), "new");
});

test("untrusted filenames stay inside a private temporary directory", async t => {
  const { drag, dragged, tempDirectory } = await fixture(t, {
    download: async () => ({ ok: true, filename: "../../bad\\name:?.jsonl", bytes: Buffer.from("markdown") }),
  });
  const input = request();
  await drag.prepare(input);
  drag.start(input.gestureId);
  assert.equal(path.extname(dragged[0]), ".md");
  assert.equal(path.dirname(path.dirname(dragged[0])), tempDirectory);
  assert.doesNotMatch(path.basename(dragged[0]), /[/\\:<>?*]/u);
});

test("cancel during native nested loop preserves the source file", async t => {
  let drag;
  const input = request();
  ({ drag } = await fixture(t, {
    startDrag(file) {
      drag.cancel(input.gestureId);
      assert.ok(file.endsWith(".md"));
    },
  }));
  await drag.prepare(input);
  assert.equal(drag.start(input.gestureId).ok, true);
});

test("invalid requests, unsupported platforms and exporter failures never start native dragging", async t => {
  const { drag, dragged } = await fixture(t, { download: async () => ({ ok: false, filename: "", message: "service unavailable" }) });
  assert.equal((await drag.prepare(null)).ok, false);
  assert.equal((await drag.prepare({ ...request(), chatId: " " })).ok, false);
  const input = request();
  assert.equal((await drag.prepare(input)).message, "service unavailable");
  assert.equal(drag.start(input.gestureId).ok, false);
  assert.deepEqual(dragged, []);
  const linux = await fixture(t, { platform: "linux" });
  assert.equal((await linux.drag.prepare(request())).ok, false);
});

test("IPC rejects guests and subframes; replacing the main window invalidates prepared gestures", async t => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "chat-drag-ipc-test-"));
  const disposals = [];
  t.after(async () => { for (const dispose of disposals) dispose(); await fs.rm(tempDirectory, { recursive: true, force: true }); });
  const handlers = new Map();
  let downloads = 0;
  let starts = 0;
  const makeOwner = id => ({
    id, mainFrame: {}, isDestroyed: () => false,
    once: (_name, callback) => disposals.push(callback),
    startDrag: () => { starts++; },
  });
  let owner = makeOwner(1);
  registerAssistantIpcHandlers({ handle: (key, handler) => handlers.set(key, handler) }, {
    platform: "darwin", getMainWindow: () => ({ webContents: owner }),
    app: { getPath: () => tempDirectory, getFileIcon: async () => ({ isEmpty: () => false }), once: (_name, callback) => disposals.push(callback) },
    assistantBridge: { downloadChatExport: async () => { downloads++; return { ok: true, filename: "chat.md", bytes: Buffer.from("# Chat") }; } },
  });
  const prepare = handlers.get("assistant.prepareChatFileDrag");
  const start = handlers.get("assistant.startChatFileDrag");
  const input = request();
  assert.equal((await prepare({ sender: {}, senderFrame: {} }, input)).ok, false);
  assert.equal((await prepare({ sender: owner, senderFrame: {} }, input)).ok, false);
  assert.equal(downloads, 0);
  const oldEvent = { sender: owner, senderFrame: owner.mainFrame };
  assert.equal((await prepare(oldEvent, input)).ok, true);
  owner = makeOwner(2);
  assert.equal(start(oldEvent, input.gestureId).ok, false);
  assert.equal(start({ sender: owner, senderFrame: owner.mainFrame }, input.gestureId).ok, false);
  assert.equal(starts, 0);
});
