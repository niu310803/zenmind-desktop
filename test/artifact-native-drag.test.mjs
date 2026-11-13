import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { registerArtifactDragIpc } = require('../dist-electron/main/modules/artifacts/native-drag.js');

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-drag-test-'));
  const handlers = new Map(), listeners = new Map();
  const bytes = Buffer.from('exported file');
  let authority = 'main-chat:generation:1', sourceCurrent = true;
  const started = [], identity = { chatId: 'chat', artifactId: 'artifact', runId: 'run' };
  const artifact = { artifactId: 'artifact', url: '@chat/artifacts/run/中文 #1%.txt', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const event = { sender: { id: 1 }, senderFrame: {} };
  const ports = {
    platform: 'darwin', tempRoot: root,
    authorize: () => authority,
    captureSourceGeneration: () => () => sourceCurrent,
    getChatInfo: async () => ({ chatId: 'chat', agentKey: 'agent', rawJson: JSON.stringify({ chatId: 'chat', artifact: { items: [artifact] } }) }),
    read: async input => { assert.deepEqual(input, identity); return bytes; },
    start: (_event, file) => started.push(file), ...overrides,
  };
  const runtime = registerArtifactDragIpc({ handle: (key, fn) => handlers.set(key, fn), on: (key, fn) => listeners.set(key, fn), removeHandler: key => handlers.delete(key), removeListener: key => listeners.delete(key) }, ports);
  t.after(async () => { runtime.dispose(); await fs.rm(root, { force: true, recursive: true }); });
  return { root, bytes, artifact, event, started, runtime,
    prepare: (input = identity, sender = event) => handlers.get('artifacts.drag.prepare')(sender, input),
    start: (token, sender = event) => listeners.get('artifacts.drag.start')(sender, token),
    revoke: () => { sourceCurrent = false; }, navigate: () => { authority = 'main-chat:generation:2'; },
  };
}
for (const platform of ['darwin', 'win32']) test(`${platform}: exports a verified independent copy with an opaque, one-use sender-bound lease`, async t => {
  const f = await fixture(t, { platform });
  const result = await f.prepare(); assert.equal(result.ok, true); assert.equal('file' in result, false);
  assert.equal((await f.prepare()).token, result.token);
  f.start(result.token, { sender: { id: 2 } }); assert.equal(f.started.length, 0);
  f.start(result.token); assert.equal(f.started.length, 1);
  assert.equal(path.basename(f.started[0]), '中文 #1%.txt');
  assert.deepEqual(await fs.readFile(f.started[0]), f.bytes);
  f.start(result.token); assert.equal(f.started.length, 1);
  // Simulate Finder choosing Move; the service original is never handed to it.
  await fs.rename(f.started[0], path.join(f.root, 'finder-copy.txt'));
  const next = await f.prepare(); assert.equal(next.ok, true); assert.notEqual(next.token, result.token);
});
test('rejects invalid identities, arbitrary paths, untrusted frames and unsupported platforms before reading', async t => {
  const f = await fixture(t, { read: () => { throw Error('must not read'); } });
  for (const input of [null, { chatId: 'chat', artifactId: 'artifact', file: '/etc/passwd' }, { chatId: '../chat', artifactId: 'a' }]) assert.deepEqual(await f.prepare(input), { ok: false });
  assert.deepEqual(await (await fixture(t, { authorize: () => null })).prepare(), { ok: false });
  assert.deepEqual(await (await fixture(t, { platform: 'linux' })).prepare(), { ok: false });
});
test('never exports changed, oversized, ambiguous or foreign Chat content', async t => {
  const changed = await fixture(t, { read: async () => Buffer.from('tampered') }); assert.equal((await changed.prepare()).ok, false);
  for (const mutate of [a => { a.sizeBytes = 101 * 1024 * 1024; }, a => { a.url = '@chat/artifacts/../secret'; }, a => { a.sha256 = 'invalid'; }]) {
    const f = await fixture(t); mutate(f.artifact); assert.equal((await f.prepare()).ok, false);
  }
  const ambiguous = await fixture(t, { getChatInfo: async () => ({ chatId: 'chat', agentKey: 'a', rawJson: JSON.stringify({ chatId: 'chat', artifact: { items: [{ artifactId: 'artifact' }, { artifactId: 'artifact' }] } }) }) });
  assert.equal((await ambiguous.prepare({ chatId: 'chat', artifactId: 'artifact' })).ok, false);
  const foreign = await fixture(t, { getChatInfo: async () => ({ chatId: 'other', agentKey: 'a' }) }); assert.equal((await foreign.prepare()).ok, false);
});
test('revoked Chat lifecycle, navigation, expiry and disposal cannot start stale exports', async t => {
  for (const invalidate of [f => f.revoke(), f => f.navigate()]) {
    const f = await fixture(t), prepared = await f.prepare(); invalidate(f); f.start(prepared.token); assert.equal(f.started.length, 0);
  }
  const f = await fixture(t), prepared = await f.prepare();
  const now = Date.now; Date.now = () => prepared.expiresAt + 1;
  try { f.start(prepared.token); assert.equal(f.started.length, 0); } finally { Date.now = now; }
  f.runtime.dispose();
});
test('navigation or deletion during asynchronous reads discards the snapshot and lease', async t => {
  let resolveRead;
  const f = await fixture(t, { read: () => new Promise(resolve => { resolveRead = resolve; }) });
  const pending = f.prepare();
  while (!resolveRead) await new Promise(resolve => setImmediate(resolve));
  f.revoke(); resolveRead(f.bytes);
  assert.deepEqual(await pending, { ok: false }); assert.deepEqual(await fs.readdir(f.root), []);
});
test('Windows rejects reserved filenames and alternate streams explicitly', async t => {
  for (const name of ['CON.txt', 'aux', 'normal.txt:stream', 'name.']) {
    const f = await fixture(t, { platform: 'win32' }); f.artifact.url = `@chat/artifacts/run/${name}`;
    assert.equal((await f.prepare()).ok, false, name);
  }
});

test('more than eight consecutive native exports remain usable while prior OS copies are retained', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 10; index++) { const ready = await f.prepare(); assert.equal(ready.ok, true); f.start(ready.token); }
  assert.equal(f.started.length, 10);
});

test('hovering more than eight different files evicts unused preparations while allowing new ones', async t => {
  const f = await fixture(t, { read: async () => Buffer.from('exported file') });
  let first;
  for (let index = 0; index < 10; index++) {
    f.artifact.artifactId = 'artifact-' + index;
    const ready = await f.prepare({ chatId: 'chat', runId: 'run', artifactId: f.artifact.artifactId });
    assert.equal(ready.ok, true); first ??= ready.token;
  }
  f.start(first); assert.equal(f.started.length, 0);
});

test('published paths resolve canonical IDs for Markdown and synthetic WorkPanel resources', async t => {
  const f = await fixture(t);
  const ready = await f.prepare({ chatId: 'chat', relativePath: 'artifacts/run/中文 #1%.txt' });
  assert.equal(ready.ok, true); f.start(ready.token); assert.equal(f.started.length, 1);
  for (const relativePath of ['references/run/a.txt', 'artifacts/run/../secret', 'artifacts/run/unpublished.txt']) {
    assert.equal((await f.prepare({ chatId: 'chat', relativePath })).ok, false);
  }
  assert.equal((await f.prepare({ chatId: 'chat', artifactId: 'another', relativePath: 'artifacts/run/中文 #1%.txt' })).ok, false);
});
