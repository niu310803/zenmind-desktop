import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { WorkPanelDocumentHtmlRegistry } from '../dist-electron/main/modules/work-panel/document-html.js';
import { EMPTY_WORK_PANEL_STATE, reduceWorkPanelCommand } from '../dist-electron/shared/work-panel.js';
const require = createRequire(import.meta.url);
const ts = require('typescript');

async function setup(t, interruptOpen = false) {
  const renderer = Object.assign(new EventEmitter(), { id: 72, isDestroyed: () => false });
  const guest = Object.assign(new EventEmitter(), { id: 99, isDestroyed: () => false });
  const registry = new WorkPanelDocumentHtmlRegistry();
  registry.configure({ app: {}, getMainWindow: () => null });
  t.after(() => registry.dispose());
  let state = EMPTY_WORK_PANEL_STATE;
  let frameOptions;
  const actions = [];
  const callRendererAction = async (request) => {
    actions.push(request.action);
    if (request.action === 'desktop.workpanel.discardHtmlDrafts') {
      for (const workspace of state.workspaces) for (const item of workspace.items) {
        if (request.args.handleIds.includes(item.descriptor.context?.handleId))
          state = reduceWorkPanelCommand(state, { type: 'closeItem', ownerChatId: workspace.ownerChatId, itemId: item.itemId }).nextState;
      }
      return { ok: true };
    }
    assert.equal(request.action, 'desktop.workpanel.openDocumentHtml');
    const claimed = await registry.claim({ ownerChatId: request.source.chatId, rendererGeneration: 'renderer', claimId: request.args.claimId }, renderer);
    assert.equal(claimed.ok, true);
    const opened = reduceWorkPanelCommand(state, { type: 'openItem', ownerChatId: request.source.chatId,
      descriptor: { kind: 'native', surfaceKey: 'document-html', context: claimed.document } });
    assert.equal(opened.ok, true);
    state = opened.nextState;
    if (interruptOpen) guest.emit('did-start-navigation', {}, 'https://webclient', false, true);
    return { ok: true, result: opened };
  };
  const modules = {
    './realtime-diagnostics': {},
    './ipc-document-local-open': { createDesktopDocumentLocalOpen() {} },
    '../modules/desktop-actions': {},
    '../modules/agent-platform': { registerCanonicalChatSyncIpc: () => ({}), registerAgentWebclientBridgeIpcHandlers: (_ipc, options) => { frameOptions = options; return {}; } },
    '../modules/work-panel': { workPanelDocumentHtmlRegistry: registry,
      workPanelResourceImageRegistry: { prepareClaim: () => assert.fail('draft cannot enter the image registry') } },
    '../../shared/time-contract': {},
    './local-document-chat-sync': { createLocalDocumentChatSync() {} },
  };
  const source = fs.readFileSync(new URL('../src/main/app/ipc-platform-frame.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => { assert.ok(name in modules, name); return modules[name]; } });
  exports.registerPlatformFrameIpc({ app: {}, ipcMain: { handle() {} }, assistantBridgeRuntime: { assistantBridge: {}, realtimeBroker: {}, desktopActionOptions: { callRendererAction } },
    servicesFacade: {}, browserSurfaces: {}, getMainWindow: () => ({ isDestroyed: () => false, webContents: renderer }) });
  return { open: frameOptions.openDocument, guest, actions, state: () => state };
}
const html = '<h1>旅行计划</h1>';
const source = { kind: 'html-draft', agentKey: 'agent', chatId: 'chat', name: 'preview.html', html, sha256: crypto.createHash('sha256').update(html).digest('hex') };

test('frame composition opens native HTML and source refresh closes the exact draft tab', async t => {
  const app = await setup(t);
  const opened = await app.open({ ownerChatId: 'chat', document: { source }, draftGuest: app.guest });
  assert.equal(opened.ok, true);
  assert.equal(opened.renderer, 'native-html');
  assert.equal(app.state().workspaces[0].items.length, 1);
  app.guest.emit('did-start-navigation', {}, 'https://webclient', false, true);
  assert.equal(app.state().workspaces.flatMap(workspace => workspace.items).length, 0);
  assert.ok(app.actions.includes('desktop.workpanel.discardHtmlDrafts'));
});

test('frame composition rejects a late open result after refresh and does not resurrect the item', async t => {
  const app = await setup(t, true);
  const opened = await app.open({ ownerChatId: 'chat', document: { source }, draftGuest: app.guest });
  assert.equal(opened.ok, false);
  assert.equal(opened.error.code, 'target_unavailable');
  assert.equal(app.state().workspaces.flatMap(workspace => workspace.items).length, 0);
});
