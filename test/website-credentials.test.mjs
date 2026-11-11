import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeWebsiteCredentialOrigin, maskWebsiteCredentialUsername } = require('../dist-electron/shared/website-credentials.js');
const { createWebsiteCredentialStore } = require('../dist-electron/main/modules/credentials/store.js');
const { createAuthenticationGate } = require('../dist-electron/main/modules/credentials/system-auth.js');

// Stands in for Keychain/DPAPI: reversible only with this protector's secret byte.
const protector = (secret = 0x5a, available = true) => ({
  available: () => available,
  protect: key => Buffer.from(key.map(byte => byte ^ secret)),
  unprotect: blob => { if (!available) throw new Error('unavailable'); return Buffer.from(blob.map(byte => byte ^ secret)); },
});
function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'website-credentials-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hardened = [];
  let clock = 1_700_000_000_000;
  const options = { vaultDirectory: path.join(root, 'secrets', 'website-credentials'), policyFile: path.join(root, 'config', 'website-credentials.json'),
    protector: protector(), hardenDirectory: directory => hardened.push(directory), now: () => clock++, ...overrides };
  return { root, options, hardened, store: createWebsiteCredentialStore(options), reopen: (more = {}) => createWebsiteCredentialStore({ ...options, ...more }) };
}
const code = operation => { try { operation(); } catch (error) { return error.code; } return null; };
const account = (username = 'alice@example.com', origin = 'https://accounts.example.com/login?next=1') => ({ origin, username, password: 'correct horse battery staple' });
const vaultFiles = directory => fs.readdirSync(directory).sort();

test('origins are exact HTTPS origins and usernames are masked', () => {
  assert.equal(normalizeWebsiteCredentialOrigin('https://Accounts.Example.com/login?x=1#y'), 'https://accounts.example.com');
  assert.equal(normalizeWebsiteCredentialOrigin('https://accounts.example.com:8443/'), 'https://accounts.example.com:8443');
  for (const rejected of ['http://accounts.example.com', 'file:///etc/passwd', 'https://user:pw@example.com', 'accounts.example.com', '', null, 'data:text/html,x']) {
    assert.equal(normalizeWebsiteCredentialOrigin(rejected), null, String(rejected));
  }
  assert.equal(maskWebsiteCredentialUsername('linlay@gmail.com'), 'li***@gmail.com');
  assert.equal(maskWebsiteCredentialUsername('a@b.co'), 'a***@b.co');
  assert.equal(maskWebsiteCredentialUsername('13800138000'), '13***00');
  assert.equal(maskWebsiteCredentialUsername('admin'), 'a***');
});

test('credentials are stored encrypted and survive a reopen', t => {
  const { store, options, hardened, reopen } = setup(t);
  assert.deepEqual(store.state(), { captureEnabled: false, vault: { state: 'ready' }, credentials: [], neverSaveOrigins: [] });
  assert.equal(fs.existsSync(options.vaultDirectory), false, 'reading an empty vault creates nothing');

  const state = store.add(account());
  assert.equal(state.credentials.length, 1);
  const [summary] = state.credentials;
  assert.equal(summary.origin, 'https://accounts.example.com');
  assert.equal(summary.maskedUsername, 'al***@example.com');
  assert.equal(summary.agentAllowed, true);
  assert.equal('password' in summary, false);
  assert.equal('username' in summary, false);
  assert.deepEqual(hardened, [options.vaultDirectory]);

  assert.deepEqual(vaultFiles(options.vaultDirectory), ['key-envelope', 'vault']);
  for (const name of vaultFiles(options.vaultDirectory)) {
    const content = fs.readFileSync(path.join(options.vaultDirectory, name), 'utf8');
    for (const secret of ['correct horse', 'alice', 'example.com']) assert.equal(content.includes(secret), false, `${name} leaks ${secret}`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(options.vaultDirectory, name)).mode & 0o777, 0o600);
  }
  assert.deepEqual(reopen().reveal(summary.id), { id: summary.id, origin: 'https://accounts.example.com', username: 'alice@example.com', password: 'correct horse battery staple' });
});

test('input is validated and duplicates are rejected', t => {
  const { store } = setup(t);
  store.add(account());
  assert.equal(code(() => store.add(account())), 'duplicate');
  assert.equal(code(() => store.add(account('bob', 'http://accounts.example.com'))), 'invalidOrigin');
  assert.equal(code(() => store.add({ ...account('bob'), password: '' })), 'invalidInput');
  assert.equal(code(() => store.add({ ...account('bob'), password: 'x'.repeat(1025) })), 'invalidInput');
  assert.equal(code(() => store.add({ ...account('bob'), username: 42 })), 'invalidInput');
  assert.equal(code(() => store.reveal('missing')), 'notFound');
  assert.equal(code(() => store.remove(undefined)), 'notFound');
  assert.equal(store.state().credentials.length, 1);
});

test('update and remove keep site defaults consistent', t => {
  const { store } = setup(t);
  store.add(account('alice@example.com'));
  const state = store.add(account('bob@example.com'));
  const alice = state.credentials.find(item => item.maskedUsername.startsWith('al'));
  const bob = state.credentials.find(item => item.maskedUsername.startsWith('bo'));
  assert.equal(code(() => store.update({ id: bob.id, username: 'alice@example.com' })), 'duplicate');

  let next = store.update({ id: bob.id, password: 'new password', note: 'work', agentAllowed: false, isSiteDefault: true });
  assert.deepEqual(next.credentials.map(item => [item.maskedUsername, item.isSiteDefault, item.agentAllowed, item.note]),
    [['al***@example.com', false, true, ''], ['bo***@example.com', true, false, 'work']]);
  assert.equal(store.reveal(bob.id).password, 'new password');
  next = store.update({ id: alice.id, isSiteDefault: true });
  assert.deepEqual(next.credentials.map(item => item.isSiteDefault), [true, false], 'one default per origin');
  next = store.remove(alice.id);
  assert.deepEqual(next.credentials.map(item => item.isSiteDefault), [false], 'removing the default clears it');
});

test('accounts are matched by exact origin and honour the agent switch', t => {
  const { store } = setup(t);
  store.add(account('alice@example.com'));
  store.add(account('bob@example.com'));
  store.add(account('carol@example.com', 'https://accounts.example.com:8443'));
  store.add(account('dave@example.com', 'https://other.example.com'));
  const origin = 'https://accounts.example.com';
  const [alice, bob] = store.listForOrigin(origin, { agentOnly: false }).sort((a, b) => a.maskedUsername.localeCompare(b.maskedUsername));
  assert.deepEqual(store.listForOrigin(origin, { agentOnly: false }).map(item => item.maskedUsername).sort(), ['al***@example.com', 'bo***@example.com']);
  for (const lookalike of ['https://accounts.example.com.evil.test', 'https://example.com', 'https://accounts.example.com:444']) {
    assert.deepEqual(store.listForOrigin(lookalike, { agentOnly: false }), [], lookalike);
    assert.equal(store.resolveForOrigin(lookalike, { agentOnly: false }), null, lookalike);
  }

  store.markUsed(alice.id);
  assert.equal(store.resolveForOrigin(origin, { agentOnly: true }).username, 'alice@example.com', 'most recently used wins without a default');
  store.update({ id: bob.id, isSiteDefault: true });
  assert.equal(store.resolveForOrigin(origin, { agentOnly: true }).username, 'bob@example.com', 'the site default wins');
  assert.equal(store.resolveForOrigin(origin, { agentOnly: true, id: alice.id }).username, 'alice@example.com');

  store.update({ id: bob.id, agentAllowed: false });
  assert.deepEqual(store.listForOrigin(origin, { agentOnly: true }).map(item => item.id), [alice.id]);
  assert.equal(store.resolveForOrigin(origin, { agentOnly: true }).username, 'alice@example.com', 'a blocked default is skipped for agents');
  assert.equal(store.resolveForOrigin(origin, { agentOnly: true, id: bob.id }), null, 'a blocked account cannot be requested by id');
  assert.equal(store.resolveForOrigin(origin, { agentOnly: false }).username, 'bob@example.com');
  const dave = store.listForOrigin('https://other.example.com', { agentOnly: true })[0];
  assert.equal(store.resolveForOrigin(origin, { agentOnly: true, id: dave.id }), null, 'an id from another origin is rejected');
});

test('an unreadable vault is reported and never overwritten', async t => {
  const snapshot = directory => Object.fromEntries(vaultFiles(directory).map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')]));
  const cases = {
    protectionUnavailable: ({ reopen }) => reopen({ protector: protector(0x5a, false) }),
    keyRejected: ({ reopen }) => reopen({ protector: { ...protector(), unprotect() { throw new Error('denied'); } } }),
    vaultCorrupted: ({ reopen }) => reopen({ protector: protector(0x11) }),
    keyMissing: ({ reopen, options }) => { fs.rmSync(path.join(options.vaultDirectory, 'key-envelope')); return reopen(); },
    vaultTooNew: ({ reopen, options }) => {
      const file = path.join(options.vaultDirectory, 'vault');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), format: 99 }));
      return reopen();
    },
  };
  for (const [reason, arrange] of Object.entries(cases)) {
    await t.test(reason, t => {
      const context = setup(t);
      context.store.add(account());
      const broken = arrange(context);
      const before = snapshot(context.options.vaultDirectory);
      assert.deepEqual(broken.state().vault, { state: 'unavailable', reason });
      assert.deepEqual(broken.state().credentials, []);
      assert.equal(code(() => broken.add(account('bob'))), 'vaultUnavailable');
      assert.equal(code(() => broken.reveal('any')), 'vaultUnavailable');
      assert.deepEqual(snapshot(context.options.vaultDirectory), before, 'files are untouched');
    });
  }
  await t.test('tampered ciphertext', t => {
    const context = setup(t);
    context.store.add(account());
    const file = path.join(context.options.vaultDirectory, 'vault');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bytes = Buffer.from(stored.ciphertext, 'base64'); bytes[0] ^= 1;
    fs.writeFileSync(file, JSON.stringify({ ...stored, ciphertext: bytes.toString('base64') }));
    assert.deepEqual(context.reopen().state().vault, { state: 'unavailable', reason: 'vaultCorrupted' });
  });
  await t.test('vault swapped under another key envelope', t => {
    const first = setup(t); const second = setup(t);
    first.store.add(account()); second.store.add(account('mallory'));
    fs.copyFileSync(path.join(second.options.vaultDirectory, 'vault'), path.join(first.options.vaultDirectory, 'vault'));
    assert.deepEqual(first.reopen().state().vault, { state: 'unavailable', reason: 'vaultCorrupted' });
  });
});

test('recording is opt-in and independent of the vault', t => {
  const { store, options } = setup(t);
  assert.equal(store.state().captureEnabled, false);
  assert.equal(store.setCaptureEnabled(true).captureEnabled, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(options.policyFile, 'utf8')), { captureEnabled: true });
  store.add(account());
  assert.equal(store.setCaptureEnabled(false).credentials.length, 1, 'turning recording off keeps saved passwords');
  assert.equal(code(() => store.setCaptureEnabled('yes')), 'invalidInput');
  fs.writeFileSync(options.policyFile, 'not json');
  assert.equal(store.state().captureEnabled, false);
});

test('the authentication gate fails closed and forgets on lock', async () => {
  let clock = 0; let outcome = 'authenticated'; let prompts = 0;
  const gate = createAuthenticationGate({ now: () => clock, graceMs: 1000, authenticator: { authenticate: async () => { prompts += 1; return outcome; } } });
  const attempt = () => gate.require('reason').then(() => null, error => error.code);
  assert.equal(await attempt(), null);
  clock = 999; assert.equal(await attempt(), null); assert.equal(prompts, 1, 'no second prompt inside the grace period');
  clock = 1000; assert.equal(await attempt(), null); assert.equal(prompts, 2);
  gate.clear(); outcome = 'failed';
  assert.equal(await attempt(), 'authenticationFailed'); assert.equal(prompts, 3);
  outcome = 'unavailable'; assert.equal(await attempt(), 'authenticationUnavailable');

  let release; outcome = 'authenticated';
  const locked = createAuthenticationGate({ now: () => clock, authenticator: { authenticate: () => new Promise(resolve => { release = () => resolve('authenticated'); }) } });
  const pending = locked.require('reason').then(() => null, error => error.code);
  locked.clear(); release();
  assert.equal(await pending, 'authenticationFailed', 'a lock during the prompt voids it');
});

const transfer = require('../dist-electron/main/modules/credentials/transfer.js');
const errorCode = operation => { try { operation(); } catch (error) { return error.code ?? error.message; } return null; };

test('browser password CSV exports are parsed across vendors', () => {
  const chrome = Buffer.from('﻿name,url,username,password,note\r\nExample,https://accounts.example.com/login,alice@example.com,"p,a""ss\nword",work\r\n,android://hash@com.app/,bob,secret,\r\n');
  assert.deepEqual(transfer.parseWebsiteCredentialCsv(chrome), [
    { origin: 'https://accounts.example.com/login', username: 'alice@example.com', password: 'p,a"ss\nword', note: 'work' },
    { origin: 'android://hash@com.app/', username: 'bob', password: 'secret', note: '' },
  ]);
  const safari = Buffer.from('Title,URL,Username,Password,Notes,OTPAuth\nExample,https://example.com/,carol,pw,,\n');
  assert.deepEqual(transfer.parseWebsiteCredentialCsv(safari), [{ origin: 'https://example.com/', username: 'carol', password: 'pw', note: '' }]);
  const bitwarden = Buffer.from('folder,name,login_uri,login_username,login_password\n,Example,https://example.com,dave,pw\n');
  assert.equal(transfer.parseWebsiteCredentialCsv(bitwarden)[0].username, 'dave');
  assert.equal(errorCode(() => transfer.parseWebsiteCredentialCsv(Buffer.from('a,b,c\n1,2,3\n'))), 'importUnrecognized');
  assert.equal(errorCode(() => transfer.parseWebsiteCredentialCsv(Buffer.from(''))), 'importUnrecognized');
  assert.equal(errorCode(() => transfer.parseWebsiteCredentialCsv(Buffer.from(`url,username,password\n${'https://example.com,u,p\n'.repeat(5001)}`))), 'importTooLarge');
});

test('imports add new accounts in one commit and never overwrite saved ones', t => {
  const { store } = setup(t);
  store.add(account('alice@example.com'));
  const summary = store.importMany([
    { origin: 'https://accounts.example.com/other', username: 'alice@example.com', password: 'imported must not win' },
    { origin: 'https://accounts.example.com', username: 'bob', password: 'pw', note: 'n', agentAllowed: false },
    { origin: 'https://accounts.example.com', username: 'bob', password: 'second duplicate in the same file' },
    { origin: 'android://hash@com.app/', username: 'x', password: 'pw' },
    { origin: 'http://plain.example.com', username: 'x', password: 'pw' },
    { origin: 'https://example.com', username: '', password: 'pw' },
    { origin: 'https://example.com', username: 'x', password: '' },
    null,
  ]);
  assert.deepEqual(summary, { added: 1, skipped: 2, invalid: 5 });
  const credentials = store.state().credentials;
  assert.equal(credentials.length, 2);
  assert.equal(store.reveal(credentials.find(item => item.maskedUsername.startsWith('al')).id).password, 'correct horse battery staple');
  assert.equal(credentials.find(item => item.maskedUsername === 'b***').agentAllowed, false);
});

test('an encrypted backup round-trips and reveals nothing without its password', t => {
  const { store } = setup(t); const other = setup(t);
  store.add(account('alice@example.com')); store.add({ ...account('bob', 'https://other.example.com'), note: '工作' });
  store.update({ id: store.state().credentials[0].id, agentAllowed: false });
  const bytes = transfer.encryptWebsiteCredentialBackup(store.exportAll(), 'export password');
  const text = bytes.toString('utf8');
  for (const secret of ['correct horse', 'alice', 'example.com', '工作']) assert.equal(text.includes(secret), false, `backup leaks ${secret}`);
  assert.equal(transfer.isWebsiteCredentialBackup(bytes), true);
  assert.equal(transfer.isWebsiteCredentialBackup(Buffer.from('url,username,password\n')), false);

  assert.deepEqual(other.store.importMany(transfer.decryptWebsiteCredentialBackup(bytes, 'export password')), { added: 2, skipped: 0, invalid: 0 });
  assert.deepEqual(other.store.exportAll(), store.exportAll());
  assert.equal(errorCode(() => transfer.decryptWebsiteCredentialBackup(bytes, 'wrong password')), 'backupPasswordIncorrect');
  assert.equal(errorCode(() => transfer.decryptWebsiteCredentialBackup(bytes, '')), 'backupPasswordIncorrect');
  assert.equal(errorCode(() => transfer.encryptWebsiteCredentialBackup([], 'short')), 'invalidInput');
  const stored = JSON.parse(text);
  const tampered = Buffer.from(stored.ciphertext, 'base64'); tampered[0] ^= 1;
  assert.equal(errorCode(() => transfer.decryptWebsiteCredentialBackup(Buffer.from(JSON.stringify({ ...stored, ciphertext: tampered.toString('base64') })), 'export password')), 'backupPasswordIncorrect');
  // A crafted file must not be able to choose its own key-derivation cost.
  assert.equal(errorCode(() => transfer.decryptWebsiteCredentialBackup(Buffer.from(JSON.stringify({ ...stored, kdf: { ...stored.kdf, N: 2 ** 24 } })), 'export password')), 'importUnrecognized');
  assert.equal(errorCode(() => transfer.decryptWebsiteCredentialBackup(Buffer.from('not json'), 'export password')), 'importUnrecognized');
});

const { EventEmitter } = require('node:events');
const { createLoginCapture } = require('../dist-electron/main/modules/credentials/capture/controller.js');
const pageScript = require('../dist-electron/main/modules/credentials/capture/page-script.js');
const { createLoginFrameRelay } = require('../dist-electron/main/modules/credentials/frames.js');

// One frame of a guest page with a scripted isolated world: `emit$` plays its observer, `formState` its answer to the outcome probe.
function fakeFrame({ origin, node, parent = null }) {
  const frame = new EventEmitter();
  let waiter = null; const queue = [];
  Object.assign(frame, { origin, frameTreeNodeId: node, parent, frameToken: `frame-${node}`, detached: false, destroyed: false, installs: 0, formState: 'none',
    isDestroyed: () => frame.destroyed, send() {},
    emit$: event => { if (waiter) { const resolve = waiter; waiter = null; resolve(event); } else queue.push(event); },
    async script(code) {
      if (code === pageScript.LOGIN_OBSERVER_NEXT_SCRIPT) {
        // Like the observer: a newer pull ends the older one as idle.
        if (waiter) { const previous = waiter; waiter = null; previous({ type: 'idle' }); }
        return queue.length ? queue.shift() : new Promise(resolve => { waiter = resolve; });
      }
      if (code === pageScript.LOGIN_OBSERVER_FORM_STATE_SCRIPT) { if (frame.formState instanceof Error) throw frame.formState; return frame.formState; }
      frame.installs += 1; return undefined;
    } });
  return frame;
}
// A guest page: its main frame runs scripts through executeJavaScriptInIsolatedWorld, iframes through the relay.
function fakeGuest(url = 'https://accounts.example.com/login', id = 7) {
  const guest = new EventEmitter();
  const main = fakeFrame({ origin: new URL(url).origin, node: 1 });
  Object.assign(guest, { id, url, main, frames: [main], worlds: new Set(), mainFrame: main, isDestroyed: () => false, getURL: () => guest.url,
    emit$: event => guest.mainFrame.emit$(event),
    executeJavaScriptInIsolatedWorld: async (world, [{ code }]) => { guest.worlds.add(world); return guest.mainFrame.script(code); },
    addFrame(origin, node) { const frame = fakeFrame({ origin, node, parent: guest.mainFrame }); guest.frames.push(frame); return frame; },
    removeFrame(frame) { frame.detached = true; guest.frames = guest.frames.filter(item => item !== frame); } });
  Object.defineProperty(main, 'framesInSubtree', { get: () => guest.frames });
  return guest;
}
const relayed = [];
const fakeRelay = { run: async (frame, code) => { relayed.push(frame.frameTreeNodeId); return frame.script(code); } };
function captureSetup(t, { enabled = true, relay = fakeRelay } = {}) {
  const context = setup(t);
  if (enabled) context.store.setCaptureEnabled(true);
  const pending = []; const shown = []; const withdrawn = [];
  const timers = { set: (callback, ms) => { const timer = { callback, ms }; pending.push(timer); return timer; }, clear: timer => { const index = pending.indexOf(timer); if (index >= 0) pending.splice(index, 1); } };
  let clock = 1_700_000_000_000;
  const capture = createLoginCapture({ store: context.store, timers, relay, now: () => clock, presentOffer: offer => { shown.push(offer); return true; }, withdrawOffer: id => withdrawn.push(id) });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  // Runs the outcome probes (each a second or so apart, the clock moving with them) but not the two-minute offer expiry.
  const settle = async (rounds = 8) => { await tick(); for (let i = 0; i < rounds; i++) { const timer = pending.find(item => item.ms < 10_000); if (!timer) break; timers.clear(timer); clock += timer.ms; await timer.callback(); await tick(); } };
  const expire = async () => { for (const timer of [...pending]) { timers.clear(timer); await timer.callback(); } };
  return { ...context, capture, shown, withdrawn, settle, expire, tick, advance: ms => { clock += ms; } };
}
const login = (username = 'alice@example.com', password = 'hunter2!', origin = 'https://accounts.example.com') => ({ type: 'credential', origin, username, password });

test('a successful login is offered for saving without exposing the password', async t => {
  const { capture, store, shown, settle, tick } = captureSetup(t);
  const guest = fakeGuest(); capture.attach(guest); await tick();
  assert.equal(guest.main.installs, 1);
  assert.deepEqual([...guest.worlds], [pageScript.LOGIN_OBSERVER_WORLD_ID], 'only the isolated world is used');
  guest.emit$({ type: 'idle' }); await tick();
  guest.emit$(login()); await settle();
  assert.equal(shown.length, 1);
  assert.deepEqual({ ...shown[0], offerId: 'id' }, { offerId: 'id', origin: 'https://accounts.example.com', username: 'alice@example.com', kind: 'save', verified: true });
  assert.equal(JSON.stringify(shown).includes('hunter2'), false);
  assert.equal(store.state().credentials.length, 0, 'nothing is saved before the user answers');

  assert.equal(capture.resolveOffer(shown[0].offerId, 'save'), true);
  assert.equal(store.resolveForOrigin('https://accounts.example.com', { agentOnly: false }).password, 'hunter2!');
  assert.equal(capture.resolveOffer(shown[0].offerId, 'save'), false, 'an offer is answered once');
  assert.equal(capture.pendingOfferCount(), 0);

  // The same login again has nothing to save; a new password offers an update.
  guest.emit$(login()); await settle(); assert.equal(shown.length, 1);
  guest.emit$(login('alice@example.com', 'changed')); await settle();
  assert.equal(shown[1].kind, 'update');
  capture.resolveOffer(shown[1].offerId, 'dismiss');
  assert.equal(store.resolveForOrigin('https://accounts.example.com', { agentOnly: false }).password, 'hunter2!', 'dismissing keeps the saved password');
});

test('the outcome stays open while the submitted form is shown, a returning form is a refusal, and an unknown one is unverified', async t => {
  const { capture, shown, settle, tick } = captureSetup(t);
  const guest = fakeGuest(); capture.attach(guest); await tick();
  // A login nobody answers keeps the submitted form until the window closes.
  guest.main.formState = 'submitted'; guest.emit$(login()); await settle(120);
  assert.equal(shown.length, 0, 'the submitted form is still showing');
  // The page comes back with the form in a new document: refused, and leaving the page later does not make it a success.
  guest.emit$(login('mallory', 'wrong')); await settle(2);
  guest.main.formState = 'form'; await settle(2);
  guest.main.formState = 'none'; await settle();
  assert.equal(shown.length, 0, 'a refused login is never offered');
  // A slider check over the form: the login moves on long after the old few-second limit.
  guest.main.formState = 'submitted'; guest.emit$(login('bob', 'after-check')); await settle(10);
  assert.equal(shown.length, 0);
  guest.emit$({ type: 'activity', origin: 'https://accounts.example.com' }); await tick();
  guest.main.formState = 'none'; await settle();
  assert.deepEqual([shown[0].username, shown[0].verified], ['bob', true], 'working on a check over the form does not count against the login');
  // A page that cannot answer at all.
  guest.main.formState = new Error('navigating'); guest.emit$(login()); await settle(12);
  assert.equal(shown.length, 2); assert.equal(shown[1].verified, false);
});

test('a field emptied in place is offered unverified only when the page moves on by itself', async t => {
  const { capture, shown, settle, tick } = captureSetup(t);
  const guest = fakeGuest(); capture.attach(guest); await tick();
  const emptied = async (username) => { guest.main.formState = 'submitted'; guest.emit$(login(username, `${username}-secret`)); await settle(1); guest.main.formState = 'cleared'; await settle(2); };

  // The page clears the field and goes to its home page a few seconds later.
  await emptied('alice');
  assert.equal(shown.length, 0, 'still open while the emptied form is shown');
  guest.main.formState = 'none'; await settle();
  assert.deepEqual([shown[0].username, shown[0].verified], ['alice', false]);

  // Refused and emptied, then the user clicks a link away: nothing to ask.
  await emptied('bob');
  guest.emit$({ type: 'activity', origin: 'https://accounts.example.com' }); await tick();
  guest.main.formState = 'none'; await settle();
  // Refused and emptied, then the user types another address.
  await emptied('carol');
  guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, initiator: null });
  guest.main.formState = 'none'; await settle();
  // Refused and emptied, then the user closes the page.
  await emptied('dave');
  capture.detach(guest.id); await settle();
  assert.equal(shown.length, 1, 'a refusal the user walked away from is not offered');
});

test('two-step logins, missing identifiers and never-save sites', async t => {
  const { capture, store, shown, settle, tick } = captureSetup(t);
  const guest = fakeGuest(); capture.attach(guest); await tick();
  guest.emit$(login('')); await settle();
  assert.equal(shown.length, 0, 'a password without an account is dropped');
  guest.emit$({ type: 'username', origin: 'https://accounts.example.com', username: 'bob@example.com' }); await tick();
  guest.emit('dom-ready'); await tick();
  guest.emit$(login('')); await settle();
  assert.equal(shown[0].username, 'bob@example.com');
  guest.emit$(login('')); await settle();
  assert.equal(shown.length, 1, 'the remembered identifier is used once');

  assert.equal(capture.resolveOffer(shown[0].offerId, 'never'), true);
  assert.deepEqual(store.state().neverSaveOrigins, ['https://accounts.example.com']);
  assert.equal(store.state().credentials.length, 0);
  guest.emit$(login()); await settle();
  assert.equal(shown.length, 1, 'never-save sites are not offered again');
  store.setNeverSave('https://accounts.example.com', false);
  guest.emit$(login()); await settle(); assert.equal(shown.length, 2);
});

test('an identifier carries over to another site only along the navigation it started', async t => {
  const { capture, shown, settle, tick, advance } = captureSetup(t);
  const guest = fakeGuest('https://app.example.com/start'); capture.attach(guest); await tick();
  const toSite = (origin, initiator) => {
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, initiator, frame: guest.main });
    guest.main.origin = origin; guest.emit('did-navigate'); guest.emit('dom-ready');
  };
  // The app asks for the email, then hands over to its identity provider, whose password page shows no account field.
  guest.emit$({ type: 'username', origin: 'https://app.example.com', username: 'carol@example.com' }); await tick();
  toSite('https://sso.example.com', guest.main); await tick();
  guest.emit$(login('', 'idp-secret', 'https://sso.example.com')); await settle();
  assert.deepEqual([shown[0].origin, shown[0].username], ['https://sso.example.com', 'carol@example.com']);

  // The user typed another address in between: the earlier site's account must not be paired with this password.
  toSite('https://app.example.com', guest.main); await tick();
  guest.emit$({ type: 'username', origin: 'https://app.example.com', username: 'dave@example.com' }); await tick();
  toSite('https://other.example.org', null); await tick();
  guest.emit$(login('', 'unrelated', 'https://other.example.org')); await settle();
  assert.equal(shown.length, 1);
  // An event from a document that no longer holds the frame is dropped.
  guest.emit$(login('erin', 'stale', 'https://app.example.com')); await settle();
  assert.equal(shown.length, 1);

  // Two iframes with no navigation between them: one form's account is not another form's account.
  const accounts = guest.addFrame('https://a.example.net', 2); const vault = guest.addFrame('https://sso.example.com', 3);
  capture.refresh(); await tick();
  accounts.emit$({ type: 'username', origin: 'https://a.example.net', username: 'frank@example.com' }); await tick();
  vault.emit$(login('', 'other-frame', 'https://sso.example.com')); await settle();
  assert.equal(shown.length, 1);
  // The identifier step's own navigation can reach Main before the step does.
  advance(5_000);
  guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, initiator: guest.main, frame: guest.main });
  guest.main.origin = 'https://app.example.com'; guest.emit('dom-ready'); await tick();
  guest.emit$({ type: 'username', origin: 'https://app.example.com', username: 'henry@example.com' }); await tick();
  guest.main.origin = 'https://sso.example.com'; guest.emit('dom-ready'); await tick();
  guest.emit$(login('', 'navigation-first', 'https://sso.example.com')); await settle();
  assert.deepEqual([shown[1].origin, shown[1].username], ['https://sso.example.com', 'henry@example.com']);
  // The same iframe going on to its identity provider by itself carries the account along.
  accounts.emit$({ type: 'username', origin: 'https://a.example.net', username: 'grace@example.com' }); await tick();
  guest.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, initiator: accounts, frame: accounts });
  accounts.origin = 'https://sso.example.com'; accounts.emit('dom-ready'); await tick();
  accounts.emit$(login('', 'in-frame-handover', 'https://sso.example.com')); await settle();
  assert.deepEqual([shown[2].origin, shown[2].username], ['https://sso.example.com', 'grace@example.com']);
});

test('a login form inside an iframe belongs to the iframe site', async t => {
  relayed.length = 0;
  const { capture, shown, settle, tick } = captureSetup(t);
  const guest = fakeGuest('https://app.example.com/home');
  const sso = guest.addFrame('https://sso.example.com', 2);
  const plain = guest.addFrame('http://ads.example.net', 3);
  capture.attach(guest); await tick();
  assert.equal(sso.installs, 1, 'HTTPS iframes are observed through the relay');
  assert.equal(plain.installs, 0, 'non-HTTPS iframes are not');
  assert.ok(relayed.every(node => node === 2));

  sso.emit$(login('frank', 'in-frame', 'https://sso.example.com')); await settle();
  assert.deepEqual([shown[0].origin, shown[0].username, shown[0].verified], ['https://sso.example.com', 'frank', true]);
  // A frame cannot claim another site.
  sso.emit$(login('frank', 'forged', 'https://app.example.com')); await settle();
  assert.equal(shown.length, 1);

  // The login dialog's iframe is removed with the page unchanged: maybe the user closed it, so the outcome is unknown.
  sso.formState = 'submitted'; sso.emit$(login('grace', 'closed-dialog', 'https://sso.example.com')); await settle(2);
  guest.removeFrame(sso); await settle();
  assert.deepEqual([shown[1].username, shown[1].verified], ['grace', false]);

  // The page re-creates its login iframe with the form again: refused, even though the frame is a new one.
  const retry = guest.addFrame('https://sso.example.com', 5); retry.formState = 'submitted';
  capture.refresh(); await tick();
  retry.emit$(login('ivy', 'refused-in-frame', 'https://sso.example.com')); await settle(2);
  guest.removeFrame(retry); const again = guest.addFrame('https://sso.example.com', 6); again.formState = 'form'; await settle();
  assert.equal(shown.length, 2, 'a re-created login iframe means the login was refused');
  guest.removeFrame(again);

  // An iframe created later is observed from its own dom-ready; the page moving on after its login is a success.
  const later = guest.addFrame('https://sso.example.com', 4);
  guest.emit('frame-created', {}, { frame: later }); later.emit('dom-ready'); await tick();
  assert.equal(later.installs, 1);
  later.formState = 'submitted'; later.emit$(login('heidi', 'then-home', 'https://sso.example.com')); await settle(2);
  guest.removeFrame(later); guest.emit('did-navigate'); await settle();
  assert.deepEqual([shown[2].username, shown[2].verified], ['heidi', true]);

  // Without the relay only the page itself is observed.
  const bare = captureSetup(t, { relay: null });
  const other = fakeGuest('https://app.example.com/home', 8); const hidden = other.addFrame('https://sso.example.com', 2);
  bare.capture.attach(other); await bare.tick();
  assert.deepEqual([other.main.installs, hidden.installs], [1, 0]);
});

test('capture is off by default, HTTPS only, and forgets pending passwords', async t => {
  const off = captureSetup(t, { enabled: false });
  const idle = fakeGuest(); off.capture.attach(idle); await off.tick();
  assert.equal(idle.main.installs, 0, 'nothing is injected until the user opts in');
  off.store.setCaptureEnabled(true); off.capture.refresh(); await off.tick();
  assert.equal(idle.main.installs, 1, 'open pages are observed once recording is switched on');

  const { capture, store, shown, withdrawn, settle, expire, tick } = captureSetup(t);
  for (const url of ['http://accounts.example.com/login', 'file:///tmp/login.html', 'about:blank']) {
    const plain = fakeGuest(url, url.length); capture.attach(plain); await tick();
    assert.equal(plain.main.installs, 0, url);
  }
  const guest = fakeGuest(); capture.attach(guest); await tick();
  guest.emit$({ ...login(), origin: 'http://accounts.example.com' }); await settle();
  guest.emit$({ ...login(), password: 'x'.repeat(1025) }); await settle();
  assert.equal(shown.length, 0, 'malformed events are ignored');

  guest.emit$(login()); await settle();
  capture.clearPending();
  assert.deepEqual(withdrawn, [shown[0].offerId]);
  assert.equal(capture.resolveOffer(shown[0].offerId, 'save'), false, 'a cleared offer cannot be saved');
  guest.emit$(login()); await settle(); await expire();
  assert.equal(capture.pendingOfferCount(), 0, 'unanswered offers expire');
  assert.equal(store.state().credentials.length, 0);
});

test('lock drops every unsaved candidate; closing the page leaves the decision to the user', async t => {
  const { capture, store, shown, withdrawn, settle, tick } = captureSetup(t);
  const guest = fakeGuest(); capture.attach(guest); await tick();

  // Locked while the login outcome is still being judged: the captured password is forgotten.
  guest.emit$(login()); await tick(); capture.clearPending(); await settle();
  assert.equal(shown.length, 0);
  // Locked between the two steps of a login: the remembered identifier is forgotten too.
  guest.emit$({ type: 'username', origin: 'https://accounts.example.com', username: 'bob@example.com' }); await tick();
  capture.clearPending(); guest.emit$(login('')); await settle();
  assert.equal(shown.length, 0);
  // Locked while the page probe is in flight.
  let release; const original = guest.main.script;
  guest.main.script = async code => code === pageScript.LOGIN_OBSERVER_FORM_STATE_SCRIPT ? new Promise(resolve => { release = () => resolve('none'); }) : original(code);
  guest.emit$(login()); await tick(); const settled = settle(1); await tick(); await tick(); capture.clearPending(); release(); await settled;
  assert.equal(shown.length, 0, 'a probe that finishes after the lock offers nothing');
  guest.main.script = original;

  // A login popup or tab that closes itself after signing in: the prompt already showing stays.
  const other = fakeGuest('https://accounts.example.com/login', 8); capture.attach(other); await tick();
  other.emit$(login('carol')); await settle();
  assert.equal(shown.length, 1);
  capture.detach(other.id);
  assert.deepEqual(withdrawn, [], 'closing the page does not withdraw its prompt');
  // Closed before the outcome could be seen: the user decides, told it is unverified.
  guest.main.formState = 'submitted'; guest.emit$(login('dave')); await settle(2);
  capture.detach(guest.id);
  assert.deepEqual([shown[1].username, shown[1].verified], ['dave', false]);
  assert.equal(capture.resolveOffer(shown[0].offerId, 'save'), true);
  assert.equal(store.state().credentials.length, 1);
});

test('the iframe relay answers only to the frame that was asked and fails frames that never answer', async () => {
  const handlers = new Map();
  const timers = []; const fakeTimers = { set: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; }, clear: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); } };
  const relay = createLoginFrameRelay({ on: (channel, handler) => handlers.set(channel, handler) }, fakeTimers);
  const sent = [];
  const frame = { frameToken: 'tok-a', frameTreeNodeId: 2, origin: 'https://sso.example.com', parent: {}, detached: false, isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };
  const answer = (token, reply) => handlers.get('credentials.frame.result')({ senderFrame: { frameToken: token } }, reply);
  const running = relay.run(frame, 'probe()', 1500);
  assert.equal(sent[0].channel, 'credentials.frame.run');
  assert.equal(sent[0].payload.code, 'probe()');
  answer('tok-other', { id: sent[0].payload.id, ok: true, value: 'forged' });
  assert.equal(relay.pendingCount(), 1, 'another frame cannot settle it');
  answer('tok-a', { id: sent[0].payload.id, ok: true, value: true });
  assert.equal(await running, true);
  assert.equal(relay.pendingCount(), 0);

  const silent = relay.run(frame, 'next()', 1500);
  timers.shift().callback();
  await assert.rejects(silent);
  await assert.rejects(relay.run({ ...frame, detached: true }, 'probe()', 1500));
  assert.equal(relay.pendingCount(), 0);
});

const { createAgentCredentialAccess } = require('../dist-electron/main/modules/credentials/fill/agent-access.js');
const { holdPageAutomation, withCdpCommandQueue, isPageAutomationHeld, assertPageAutomationNotHeld } = require('../dist-electron/main/modules/web-surfaces/cdp/command-queue.js');

// A guest page as the fill sees it: the written field is modelled as `field.value`,
// and `document` turns to 'replaced' when the page navigates away.
function loginPage(id, url, script = {}) {
  const ran = [];
  const page = { field: { value: '' }, document: 'same', shown: script.shown ?? true, formVisible: script.formVisible ?? false };
  const contents = {
    id,
    isDestroyed: () => false,
    getURL: () => url,
    async executeJavaScriptInIsolatedWorld(_world, [{ code }]) {
      if (code.includes('function fillLogin')) {
        ran.push('fill');
        contents.filledWith = code;
        const outcome = script.outcome ?? { status: 'submitted' };
        if (outcome.status === 'filled' || outcome.status === 'submitted') page.field.value = 'written';
        if (script.fillThrows) throw new Error('gone');
        script.afterFill?.(page);
        return outcome;
      }
      if (code.includes('function clearFill')) {
        ran.push('clear');
        if (script.clearFails?.()) throw new Error('probe timeout');
        if (page.document === 'replaced') return { document: 'replaced', formVisible: false };
        page.field.value = '';
        return { document: 'same', formVisible: false, pending: false, fieldShown: false };
      }
      ran.push('state');
      script.onProbe?.(page);
      return page.document === 'replaced'
        ? { document: 'replaced', formVisible: page.formVisible }
        : { document: 'same', formVisible: page.formVisible, pending: page.field.value !== '', fieldShown: page.shown };
    },
  };
  // Mirrors the web-surfaces gateway: refuse new commands, run behind the queued ones.
  const holdAutomation = execute => {
    const release = holdPageAutomation(id);
    return withCdpCommandQueue(id, () => execute(release)).catch(error => { release(); throw error; });
  };
  return { contents, holdAutomation, ran, page };
}
const sleep = async () => {};
const settleHold = async id => { for (let turn = 0; turn < 5000 && isPageAutomationHeld(id); turn += 1) await new Promise(resolve => setImmediate(resolve)); };

test('agents see only masked accounts of the page origin that the user allows', t => {
  const { store } = setup(t);
  store.add(account('alice@example.com'));
  const state = store.add(account('bob@example.com'));
  store.add(account('carol@example.com', 'https://other.example.com'));
  const access = createAgentCredentialAccess(store);
  const page = loginPage(11, 'https://accounts.example.com/login');
  assert.equal(access.pageOrigin(page.contents), 'https://accounts.example.com');
  assert.equal(access.pageOrigin(loginPage(12, 'http://accounts.example.com/').contents), null);

  const listed = access.list('https://accounts.example.com');
  assert.deepEqual(listed.map(item => item.username).sort(), ['al***@example.com', 'bo***@example.com']);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['accountId', 'isDefault', 'username']);
  assert.equal(listed.filter(item => item.isDefault).length, 1);
  assert.ok(!JSON.stringify(listed).includes('correct horse'));

  const bob = state.credentials.find(item => item.maskedUsername === 'bo***@example.com');
  store.update({ id: bob.id, agentAllowed: false });
  assert.deepEqual(access.list('https://accounts.example.com').map(item => item.username), ['al***@example.com']);
  assert.deepEqual(access.list('https://unknown.example.com'), []);
});

test('fill writes the chosen account, pauses page automation, and reports only a status', async t => {
  const { store } = setup(t);
  const state = store.add(account('alice@example.com'));
  const other = store.add(account('carol@example.com', 'https://other.example.com')).credentials.find(item => item.origin === 'https://other.example.com');
  const access = createAgentCredentialAccess(store);
  const origin = 'https://accounts.example.com';
  const id = state.credentials[0].id;

  // A successful login navigates away: the original document is gone.
  const page = loginPage(21, `${origin}/login`, { afterFill: p => { p.document = 'replaced'; } });
  let heldDuringFill = false;
  const original = page.contents.executeJavaScriptInIsolatedWorld;
  page.contents.executeJavaScriptInIsolatedWorld = (...args) => { heldDuringFill ||= isPageAutomationHeld(21); return original(...args); };
  const result = await access.fill(page, { origin, accountId: id, submit: true, sleep });
  assert.deepEqual(result, { status: 'submitted', loginFormVisible: false });
  assert.ok(heldDuringFill);
  assert.equal(isPageAutomationHeld(21), false);
  assert.ok(page.contents.filledWith.includes('"alice@example.com"') && page.contents.filledWith.includes('"correct horse battery staple"'));
  assert.ok(!JSON.stringify(result).includes('correct horse'));
  assert.notEqual(store.state().credentials[0].lastUsedAt, null);

  // An account of another site, or one the user closed to agents, cannot be filled here.
  assert.deepEqual(await access.fill(loginPage(22, `${origin}/login`), { origin, accountId: other.id, submit: true, sleep }), { status: 'account_unavailable' });
  store.update({ id, agentAllowed: false });
  const closed = loginPage(23, `${origin}/login`);
  assert.deepEqual(await access.fill(closed, { origin, accountId: id, submit: true, sleep }), { status: 'account_unavailable' });
  assert.deepEqual(closed.ran, []);
});

test('a login form embedded from another site is filled in its iframe and nowhere else', async t => {
  const { store } = setup(t);
  const id = store.add(account('alice@example.com', 'https://sso.example.com/login')).credentials[0].id;
  const top = loginPage(31, 'https://app.example.com/home');
  const inFrame = loginPage(32, 'https://sso.example.com/login');
  const main = { parent: null, frameToken: 'main', frameTreeNodeId: 1, frames: [] };
  const frame = { frameToken: 'sso', frameTreeNodeId: 2, origin: 'https://sso.example.com', parent: main, detached: false, isDestroyed: () => false, send() {} };
  const ads = { ...frame, frameToken: 'ads', frameTreeNodeId: 3, origin: 'https://ads.example.net' };
  main.frames.push(frame, ads);
  top.contents.mainFrame = { framesInSubtree: [main, frame, ads] };
  // The page itself shows no login form; only the identity provider's iframe does. It shows both iframes.
  let shownByPage = [true, true];
  const topScript = top.contents.executeJavaScriptInIsolatedWorld;
  top.contents.executeJavaScriptInIsolatedWorld = async (world, scripts) => scripts[0].code.includes('loginFormPresent') ? false
    : scripts[0].code.includes('frameOwnersShown') ? shownByPage : topScript(world, scripts);
  let formsIn = [frame];
  // Answers as directly as the page does: the fill's no-op sleep makes any extra hop lose to its probe timeout.
  const relay = { run: (target, code) => {
    if (code.includes('loginFormPresent')) return Promise.resolve(formsIn.includes(target));
    assert.equal(target, frame, 'nothing runs in another frame');
    return inFrame.contents.executeJavaScriptInIsolatedWorld(1777, [{ code }]);
  } };
  const access = createAgentCredentialAccess(store, relay);
  const location = await access.locateLogin(top.contents);
  assert.deepEqual(location, { origin: 'https://sso.example.com', frame, embeddedIn: 'https://app.example.com' });
  assert.deepEqual(access.list(location.origin).map(item => item.username), ['al***@example.com']);
  const result = await access.fill({ ...top, frame }, { origin: location.origin, embeddedIn: location.embeddedIn, accountId: id, submit: true, sleep });
  assert.deepEqual(result, { status: 'submitted', loginFormVisible: false });
  assert.deepEqual(top.ran, [], 'the page around the iframe receives nothing');
  assert.ok(inFrame.ran.includes('fill') && inFrame.contents.filledWith.includes('"correct horse battery staple"'));

  // The iframe moving to another site, or going away, voids the fill before anything is written.
  inFrame.ran.length = 0;
  frame.origin = 'https://evil.example.net';
  assert.deepEqual(await access.fill({ ...top, frame }, { ...location, accountId: id, submit: true, sleep }), { status: 'page_changed' });
  frame.origin = 'https://sso.example.com'; frame.detached = true;
  assert.deepEqual(await access.fill({ ...top, frame }, { ...location, accountId: id, submit: true, sleep }), { status: 'page_changed' });
  assert.deepEqual(inFrame.ran, []);
  frame.detached = false;

  // Login forms of two sites at once, or no relay to reach iframes: the page itself is the login page.
  formsIn = [frame, ads];
  assert.deepEqual(await access.locateLogin(top.contents), { origin: 'https://app.example.com', frame: null });
  // Unless the page hides one of them, e.g. a background sign-in iframe made transparent.
  shownByPage = [true, false];
  assert.deepEqual(await access.locateLogin(top.contents), { origin: 'https://sso.example.com', frame, embeddedIn: 'https://app.example.com' });
  // An answer that does not line up with the frames Main sees counts as hidden.
  shownByPage = [true];
  assert.deepEqual(await access.locateLogin(top.contents), { origin: 'https://app.example.com', frame: null });
  shownByPage = [true, true];
  formsIn = [frame];
  assert.deepEqual(await createAgentCredentialAccess(store).locateLogin(top.contents), { origin: 'https://app.example.com', frame: null });
  assert.equal(await access.locateLogin(loginPage(33, 'http://app.example.com/').contents), null);
});

test('permission is re-checked after waiting in the page queue, right before writing', async t => {
  const { store } = setup(t);
  const id = store.add(account()).credentials[0].id;
  const access = createAgentCredentialAccess(store);
  const origin = 'https://accounts.example.com';
  const page = loginPage(41, `${origin}/login`, { afterFill: p => { p.document = 'replaced'; } });

  // A command already running on the page holds the queue while the user turns agent use off.
  let finishEarlier;
  const earlier = withCdpCommandQueue(41, () => new Promise(resolve => { finishEarlier = resolve; }));
  const pending = access.fill(page, { origin, accountId: id, submit: true, sleep });
  store.update({ id, agentAllowed: false });
  while (!finishEarlier) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.ran, []);
  finishEarlier();
  await earlier;
  assert.deepEqual(await pending, { status: 'account_unavailable' });
  assert.deepEqual(page.ran, []);

  // A Run cancelled or a page authorization lost while waiting: nothing is written either.
  store.update({ id, agentAllowed: true });
  const revoked = loginPage(42, `${origin}/login`);
  await assert.rejects(access.fill(revoked, { origin, accountId: id, submit: true, sleep, authorize: async () => { throw new Error('canceled'); } }));
  assert.deepEqual(revoked.ran, []);
  assert.equal(isPageAutomationHeld(42), false);
});

test('the pause ends only once the written field is confirmed empty or its document is gone', async t => {
  const { store } = setup(t);
  const id = store.add(account()).credentials[0].id;
  const access = createAgentCredentialAccess(store);
  const origin = 'https://accounts.example.com';

  // Rejected login: the form stays, so the field Desktop wrote is erased before automation resumes.
  const rejected = loginPage(31, `${origin}/login`, { formVisible: true });
  assert.deepEqual(await access.fill(rejected, { origin, accountId: id, submit: true, sleep }), { status: 'submitted', loginFormVisible: true });
  assert.equal(rejected.page.field.value, '');
  assert.equal(isPageAutomationHeld(31), false);

  // The page hides the field or turns it into plain text: no password field is visible, but the value is
  // still there. It is erased, not taken as gone.
  const hidden = loginPage(36, `${origin}/login`, { shown: false });
  assert.deepEqual(await access.fill(hidden, { origin, accountId: id, submit: true, sleep }), { status: 'submitted', loginFormVisible: false });
  assert.equal(hidden.page.field.value, '');
  assert.equal(hidden.ran.at(-1), 'clear');

  // Erasing fails (the page stops answering): the pause stays until erasing finally succeeds.
  let failures = 5;
  const stuck = loginPage(37, `${origin}/login`, { formVisible: true, clearFails: () => failures-- > 0 });
  assert.deepEqual(await access.fill(stuck, { origin, accountId: id, submit: true, sleep }), { status: 'submitted', loginFormVisible: true });
  assert.equal(stuck.page.field.value, 'written');
  assert.equal(isPageAutomationHeld(37), true);
  await settleHold(37);
  assert.equal(isPageAutomationHeld(37), false);
  assert.equal(stuck.page.field.value, '');

  // Filled without submitting: automation stays paused for the user, then the field is erased.
  let finishWaiting;
  const waiting = new Promise(resolve => { finishWaiting = resolve; });
  const manual = loginPage(32, `${origin}/login`, { outcome: { status: 'filled' } });
  assert.deepEqual(await access.fill(manual, { origin, accountId: id, submit: false, sleep: () => waiting }), { status: 'filled' });
  assert.equal(isPageAutomationHeld(32), true);
  assert.throws(() => assertPageAutomationNotHeld(32), error => error.code === 'credential_fill_in_progress');
  finishWaiting();
  await settleHold(32);
  assert.equal(isPageAutomationHeld(32), false);
  assert.equal(manual.page.field.value, '');

  // The page moved to another site between approval and fill: nothing is written.
  const moved = loginPage(33, 'https://evil.example.net/login');
  assert.deepEqual(await access.fill(moved, { origin, accountId: id, submit: true, sleep }), { status: 'page_changed' });
  assert.deepEqual(moved.ran, []);
  // A page that stops answering mid-write is treated as possibly written and erased.
  const gone = loginPage(34, `${origin}/login`, { fillThrows: true });
  assert.deepEqual(await access.fill(gone, { origin, accountId: id, submit: true, sleep }), { status: 'page_changed' });
  assert.deepEqual(gone.ran, ['fill', 'clear']);
  assert.equal(gone.page.field.value, '');
  // No login form: nothing written, nothing to hold.
  const plain = loginPage(35, `${origin}/home`, { outcome: { status: 'no_login_form', reason: 'signup_or_reset' } });
  assert.deepEqual(await access.fill(plain, { origin, accountId: id, submit: true, sleep }), { status: 'no_login_form', reason: 'signup_or_reset' });
  assert.equal(isPageAutomationHeld(35), false);
});

test('a backup of more accounts than a CSV import allows still restores, and the vault never outgrows what it can reopen', async t => {
  const { encryptWebsiteCredentialBackup, decryptWebsiteCredentialBackup, WEBSITE_CREDENTIAL_IMPORT_MAX_ROWS } = require('../dist-electron/main/modules/credentials/transfer.js');
  const { store, reopen } = setup(t);
  const many = Array.from({ length: WEBSITE_CREDENTIAL_IMPORT_MAX_ROWS + 1000 }, (_, index) => ({ origin: `https://site${index}.example.com`, username: `user${index}`, password: `pw-${index}` }));
  assert.deepEqual(store.importMany(many), { added: many.length, skipped: 0, invalid: 0 });
  const backup = encryptWebsiteCredentialBackup(store.exportAll(), 'backup password');
  const restored = setup(t).store;
  assert.equal(restored.importMany(decryptWebsiteCredentialBackup(backup, 'backup password')).added, many.length);

  // Filling the vault past its size limit is refused as a whole; the saved vault still opens.
  const before = store.state().credentials.length;
  const huge = Array.from({ length: 9000 }, (_, index) => ({ origin: `https://big${index}.example.com`, username: 'u'.repeat(300) + index, password: 'p'.repeat(1000), note: 'n'.repeat(480) }));
  assert.equal(code(() => store.importMany(huge)), 'vaultFull');
  assert.equal(reopen().state().vault.state, 'ready');
  assert.equal(reopen().state().credentials.length, before);
  // A first write that could never be reopened creates no key either.
  const empty = setup(t);
  assert.equal(code(() => empty.store.importMany(huge)), 'vaultFull');
  assert.equal(fs.existsSync(empty.options.vaultDirectory) ? vaultFiles(empty.options.vaultDirectory).length : 0, 0);
});

test('a backup larger than any CSV import restores in full', t => {
  const { encryptWebsiteCredentialBackup, decryptWebsiteCredentialBackup, WEBSITE_CREDENTIAL_IMPORT_MAX_BYTES } = require('../dist-electron/main/modules/credentials/transfer.js');
  const { store, reopen } = setup(t);
  const entries = Array.from({ length: 6500 }, (_, index) => ({ origin: `https://site${index}.example.com`, username: `user${index}-${'u'.repeat(90)}`, password: 'p'.repeat(1000), note: 'n'.repeat(200) }));
  assert.equal(store.importMany(entries).added, entries.length);
  assert.equal(reopen().state().vault.state, 'ready');
  const backup = encryptWebsiteCredentialBackup(store.exportAll(), 'backup password');
  assert.ok(backup.length > WEBSITE_CREDENTIAL_IMPORT_MAX_BYTES * 2, `backup is ${backup.length} bytes`);
  assert.equal(setup(t).store.importMany(decryptWebsiteCredentialBackup(backup, 'backup password')).added, entries.length);
});

test('a second fill on a page that is still paused is refused, not allowed to end the first pause', async t => {
  const { store } = setup(t);
  const id = store.add(account()).credentials[0].id;
  const access = createAgentCredentialAccess(store);
  const origin = 'https://accounts.example.com';
  let finishWaiting;
  const waiting = new Promise(resolve => { finishWaiting = resolve; });
  const page = loginPage(51, `${origin}/login`, { outcome: { status: 'filled' } });
  assert.deepEqual(await access.fill(page, { origin, accountId: id, submit: false, sleep: () => waiting }), { status: 'filled' });
  await assert.rejects(access.fill(page, { origin, accountId: id, submit: true, sleep }), error => error.code === 'credential_fill_in_progress');
  assert.deepEqual(page.ran.filter(step => step === 'fill'), ['fill']);
  assert.equal(isPageAutomationHeld(51), true);
  finishWaiting();
  await settleHold(51);
  assert.equal(page.page.field.value, '');
});
