import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const { artifactDragSurfaceAllowed: allowed } = require('../dist-electron/main/modules/artifacts/drag-surface-policy.js');
const target = { active: true, serviceId: 'agent-webclient', ownerWebContentsId: 1, ownerChatId: 'chat', surfaceRole: 'overview', surfaceLevel: 'child' };
const input = { chatId: 'chat', relativePath: 'artifacts/run/中文 #1%.txt' };
const url = 'http://127.0.0.1/resource-viewer/agent?' + new URLSearchParams({ chatId: 'chat', file: '@chat/' + input.relativePath });
test('Overview can export its own published list while unrelated and inactive guests are denied', () => {
  assert.equal(allowed(target, input, "http://127.0.0.1/overview/chat", 1), true);
  for (const patch of [{ active: false }, { serviceId: 'other' }, { ownerChatId: 'other' }, { ownerWebContentsId: 2 }, { surfaceRole: 'reference' }, { surfaceRole: 'workpanel-web' }]) {
    assert.equal(allowed({ ...target, ...patch }, input, "http://127.0.0.1/overview/chat", 1), false);
  }
});
test('WorkPanel artifact guests are restricted to their registered or routed file', () => {
  assert.equal(allowed(target, input, "http://127.0.0.1/overview/other", 1), false);
  const artifact = { ...target, surfaceRole: 'artifact' };
  assert.equal(allowed(artifact, input, url, 1), true);
  assert.equal(allowed(artifact, input, url.replace('chatId=chat', 'chatId=other'), 1), false);
  assert.equal(allowed({ ...artifact, documentSource: { kind: 'reference' } }, input, url, 1), false);
  assert.equal(allowed(artifact, { ...input, relativePath: 'artifacts/run/another.txt' }, url, 1), false);
  assert.equal(allowed(artifact, { ...input, chatId: 'other' }, url, 1), false);
  const bound = { ...artifact, documentSource: { kind: 'artifact', chatId: 'chat', resourceId: 'real', relativePath: input.relativePath } };
  assert.equal(allowed(bound, { chatId: 'chat', artifactId: 'real' }, url, 1), true);
  assert.equal(allowed(bound, { chatId: 'chat', artifactId: 'foreign' }, url, 1), false);
  assert.equal(allowed({ ...bound, documentSource: { ...bound.documentSource, chatId: 'other' } }, input, url, 1), false);
});
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/renderer/work-panel/artifact-drag-identity.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: module.exports, URL });
const identity = module.exports.workPanelArtifactDragIdentity;
test('WorkPanel tabs expose native image, HTML and WebClient artifact identity, not arbitrary tabs', () => {
  const cases = [
    { kind: 'native', surfaceKey: 'document-html', context: { sourceKind: 'artifact', displayUrl: '@chat/' + input.relativePath } },
    { kind: 'native', surfaceKey: 'document-image', context: { profile: 'artifact', chatId: 'chat', relativePath: input.relativePath } },
    { kind: 'webclient', module: 'artifact', route: url, context: { chatId: 'chat', artifactId: 'resource:synthetic' } },
  ];
  for (const descriptor of cases) assert.equal(JSON.stringify(identity('chat', descriptor)), JSON.stringify(input));
  for (const descriptor of [{ kind: 'web', url }, { kind: 'native', surfaceKey: 'document-html', context: { sourceKind: 'html-draft', displayUrl: '' } }, { kind: 'native', surfaceKey: 'document-image', context: { profile: 'reference', chatId: 'chat', relativePath: 'references/a.png' } }]) assert.equal(identity('chat', descriptor), null);
});
