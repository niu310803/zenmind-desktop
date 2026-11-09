import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createHtmlTestSession } from './helpers/document-html-session.mjs';
import { WorkPanelDocumentHtmlRegistry } from '../dist-electron/main/modules/work-panel/document-html.js';
import { normalizeWorkPanelDocumentSource } from '../dist-electron/shared/work-panel-document-source.js';
import { EMPTY_WORK_PANEL_STATE, reduceWorkPanelCommand } from '../dist-electron/shared/work-panel.js';
import { buildWorkPanelReviewComposerDraft } from '../dist-electron/shared/work-panel-review.js';

const source = (html = '<!doctype html><h1>旅行计划</h1>', name = 'preview.html') => ({ kind: 'html-draft', agentKey: 'agent', chatId: 'chat', name,
  sha256: crypto.createHash('sha256').update(html).digest('hex'), html });
function fixture(t) {
  const fake = createHtmlTestSession();
  const registry = new WorkPanelDocumentHtmlRegistry(() => fake.session);
  registry.configure({ app: {}, getMainWindow: () => null,
    commitDocument: async () => assert.fail('draft must never reach Platform'),
    fetchRemoteResource: async () => assert.fail('draft must never fetch Chat resources') });
  const sender = Object.assign(new EventEmitter(), { id: 72, isDestroyed: () => false });
  const guest = Object.assign(new EventEmitter(), { id: 99, isDestroyed: () => false });
  const removed = [];
  const input = (value = source()) => ({ ownerChatId: 'chat', rendererWebContentsId: sender.id, source: value,
    draftGuest: guest, onDraftsReleased: (ids) => removed.push(...ids) });
  const claim = async (value = source(), generation = 'gen') => {
    const prepared = await registry.prepareClaim(input(value));
    assert.equal(prepared.ok, true, prepared.message);
    return registry.claim({ claimId: prepared.claimId, ownerChatId: 'chat', rendererGeneration: generation }, sender);
  };
  t.after(() => registry.dispose());
  return { registry, sender, guest, input, claim, fake, removed };
}
const request = (document) => ({ ownerChatId: 'chat', rendererGeneration: 'gen', handleId: document.handleId });

test('draft normalization counts UTF-8 bytes and rejects malformed identities without changing HTML', () => {
  const html = '  <h1>旅行</h1>\n';
  assert.equal(normalizeWorkPanelDocumentSource(source(html)).html, html);
  for (const value of [source('<h1>x</h1>', '../x.html'), { ...source(), sha256: 'bad' }, source(''), source('中'.repeat(1_400_000)), { ...source(), extra: true }])
    assert.equal(normalizeWorkPanelDocumentSource(value), null);
});

test('draft previews expose no path, deny file actions/commits, and serve only their own unchanged bytes', async (t) => {
  const { registry, claim, sender, fake } = fixture(t);
  const result = await claim();
  const document = result.document;
  assert.equal(result.ok, true);
  assert.equal(document.displayUrl, '');
  assert.equal(document.localOriginal, false);
  assert.equal(document.revision, source().sha256);
  assert.equal('html' in document, false);
  assert.equal('filePath' in document, false);
  const preview = await registry.preview(request(document), sender);
  assert.equal(await (await fake.request(preview.url)).text(), source().html);
  for (const other of ['sibling.html', '../secret', '%2e%2e%2fsecret', '%5csecret'])
    assert.equal((await fake.request(new URL(other, preview.url).href)).status, 403);
  assert.equal((await registry.fileAction({ ...request(document), action: 'save-copy' }, sender)).ok, false);
  assert.equal((await registry.commit({ ...request(document), mode: 'new-artifact', text: 'x', expectedRevision: document.revision }, sender)).ok, false);
  const opened = reduceWorkPanelCommand(EMPTY_WORK_PANEL_STATE, { type: 'openItem', ownerChatId: 'chat',
    descriptor: { kind: 'native', surfaceKey: 'document-html', context: document } });
  assert.equal(opened.ok, true);
  for (const patch of [{ displayUrl: '@chat/fake.html' }, { localOriginal: true }]) {
    assert.equal(reduceWorkPanelCommand(EMPTY_WORK_PANEL_STATE, { type: 'openItem', ownerChatId: 'chat',
      descriptor: { kind: 'native', surfaceKey: 'document-html', context: { ...document, ...patch } } }).ok, false);
  }
});

test('content identity reuses one handle despite a different suggested filename, changed content opens another', async (t) => {
  const { registry, claim, sender } = fixture(t);
  const first = await claim();
  const second = await claim(source(source().html, 'different.html'));
  assert.equal(second.reused, true);
  assert.equal(second.document.handleId, first.document.handleId);
  const changed = await claim(source('<h1>新版</h1>'));
  assert.notEqual(changed.document.handleId, first.document.handleId);
  assert.equal(registry.read(request(first.document), sender).text, source().html);
});

test('refresh revokes claimed and pending drafts and cleans temporary files; it cannot restore an old claim', async (t) => {
  const { registry, claim, sender, guest, input, removed } = fixture(t);
  const first = await claim();
  const pending = await registry.prepareClaim(input(source('<h1>pending</h1>')));
  const files = [...registry.handles.values(), ...registry.claims.values()].map((entry) => entry.filePath);
  guest.emit('did-start-navigation', {}, 'https://webclient/chat', false, true);
  assert.deepEqual(removed, [first.document.handleId]);
  assert.equal(registry.read(request(first.document), sender).ok, false);
  assert.equal((await registry.claim({ claimId: pending.claimId, ownerChatId: 'chat', rendererGeneration: 'gen' }, sender)).ok, false);
  for (let n = 0; n < 30 && files.some(fs.existsSync); n++) await delay(10);
  assert.equal(files.some(fs.existsSync), false);
  const fresh = await claim();
  assert.notEqual(fresh.document.handleId, first.document.handleId);
});

test('hash mismatch, cross-Chat identity and missing source guest fail before leaving files', async (t) => {
  const { registry, input } = fixture(t);
  for (const value of [{ ...source(), sha256: '0'.repeat(64) }, { ...source(), chatId: 'other' }])
    assert.equal((await registry.prepareClaim(input(value))).ok, false);
  assert.equal((await registry.prepareClaim({ ...input(), draftGuest: undefined })).ok, false);
  assert.equal(registry.claims.size, 0);
  assert.equal(registry.handles.size, 0);
});

test('refresh during preparation rejects the late result and leaves no pending claim', async (t) => {
  const { registry, guest, input } = fixture(t);
  const pending = registry.prepareClaim(input());
  guest.emit('did-start-navigation', {}, 'https://webclient', false, true);
  assert.equal((await pending).ok, false);
  assert.equal(registry.claims.size, 0);
});

test('same-document navigation keeps drafts; closing their source guest revokes them', async (t) => {
  const { registry, claim, sender, guest } = fixture(t);
  const first = await claim();
  guest.emit('did-start-navigation', {}, 'https://webclient#hash', true, true);
  assert.equal(registry.read(request(first.document), sender).ok, true);
  guest.emit('destroyed');
  assert.equal(registry.read(request(first.document), sender).ok, false);
});

test('aggregate draft budget rejects excess pending claims, and discarding a claim frees capacity', async (t) => {
  const { registry, input } = fixture(t);
  const claims = [];
  for (let n = 0; n < 16; n++) { const result = await registry.prepareClaim(input(source(`<h1>${n}</h1>`))); assert.equal(result.ok, true); claims.push(result.claimId); }
  assert.equal((await registry.prepareClaim(input())).ok, false);
  registry.discardPreparedClaim(claims[0]);
  assert.equal((await registry.prepareClaim(input())).ok, true);
});

test('draft review identifies original content and asks for a revised code block without creating resources', () => {
  const draft = buildWorkPanelReviewComposerDraft({ kind: 'html', source: { sourceKind: 'html-draft', fileName: 'preview.html', revision: source().sha256, draftExcerpt: '<h1>旅行计划</h1>' }, annotations: [] });
  assert.match(draft, /SHA-256/);
  assert.match(draft, /旅行计划/);
  assert.match(draft, /修改后的 HTML 代码块/);
  assert.match(draft, /不要新建文件/);
});

test('Desktop renderer reload cleans drafts without handing old handles to the next generation', async (t) => {
  const { registry, claim, sender } = fixture(t);
  const first = await claim();
  sender.emit('did-start-navigation', {}, 'file:///desktop.html', false, true);
  assert.equal(registry.read(request(first.document), sender).ok, false);
  const fresh = await claim(source(), 'new-generation');
  assert.notEqual(fresh.document.handleId, first.document.handleId);
  assert.equal(registry.read({ ...request(fresh.document), rendererGeneration: 'gen' }, sender).ok, false);
});

test('same-content preview at capacity reuses the file without allocating another cache directory', async (t) => {
  const { registry, claim } = fixture(t);
  const first = await claim();
  for (let n = 1; n < 16; n++) await claim(source(`<h1>${n}</h1>`));
  const file = registry.handles.get(first.document.handleId).filePath;
  const again = await claim(source(source().html, 'renamed.html'));
  assert.equal(again.document.handleId, first.document.handleId);
  assert.equal(registry.handles.get(first.document.handleId).filePath, file);
});

test('each Chat receives its own invalidation when a shared source document is refreshed', async (t) => {
  const { registry, sender, guest, input, claim, removed } = fixture(t);
  const first = await claim();
  const secondRemoved = [];
  const second = await registry.prepareClaim({ ...input({ ...source(), chatId: 'chat-two' }), ownerChatId: 'chat-two', onDraftsReleased: ids => secondRemoved.push(...ids) });
  const claimed = await registry.claim({ claimId: second.claimId, ownerChatId: 'chat-two', rendererGeneration: 'gen' }, sender);
  guest.emit('did-start-navigation', {}, 'https://webclient', false, true);
  assert.deepEqual(removed, [first.document.handleId]);
  assert.deepEqual(secondRemoved, [claimed.document.handleId]);
});
