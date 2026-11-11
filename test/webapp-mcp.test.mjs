import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

let fetcher;
globalThis.__webappMcpNet = { fetch: (...args) => fetcher(...args) };
const { outputFiles } = await build({
  stdin: { contents: `export * from './src/main/modules/desktop-actions/webapp-mcp';
    export * from './src/main/modules/webs/webapps/action-tokens';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'ports', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const net=globalThis.__webappMcpNet;' }));
    b.onResolve({ filter: /main-i18n$/ }, () => ({ path: 'i18n', namespace: 'mock-i18n' }));
    b.onLoad({ filter: /.*/, namespace: 'mock-i18n' }, () => ({ contents: 'export const getMainLocale=()=>"en";' }));
  } }]
});
const api = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const tokenFor = sub => 'header.' + Buffer.from(JSON.stringify({ sub })).toString('base64url') + '.signature';
const token = tokenFor('local-app');
const input = { url: 'https://mcp.example.test/mcp', toolName: 'search', arguments: { query: 'hello' } };
const response = data => new Response(JSON.stringify({ code: 0, data }));
const invocation = kind => ({ kind, webappId: 'app' });
function fixture() {
  const runtime = { status: 'running', startedAt: 1 };
  const options = {
    app: {}, services: { getResponsiveServiceState: async () => ({ status: 'running', healthMeta: { webUrl: 'http://127.0.0.1:1234' } }) },
    issueAgentAccessToken: async () => ({ ok: true, token }),
    webs: { webappManager: { list: () => [{ id: 'app' }] }, webappRuntime: { getStatus: () => runtime } }
  };
  return { options, runtime };
}

test('page and backend MCP calls go only to Platform using local host identity, without connector grants', async () => {
  const mcp = { content: [{ type: 'text', text: 'found' }], structuredContent: { matches: 1 }, isError: false };
  for (const kind of ['webappPage', 'webappBackend']) {
    const calls = [];
    fetcher = async (url, init) => { calls.push({ url, init }); return response({ mcp, token: 'must-not-project' }); };
    const result = await api.executeWebappMcp(fixture().options, input, invocation(kind));
    assert.deepEqual(result, { ok: true, action: 'mcp.invoke', result: { mcp } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:1234/api/mcp/invoke');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + token);
    assert.equal(calls[0].init.redirect, 'error');
    assert.deepEqual(JSON.parse(calls[0].init.body), input);
    assert.equal(JSON.stringify(result).includes(token), false);
  }
});

test('only installed running WebApp instances may invoke; credential/header overrides are rejected', async () => {
  fetcher = async () => { throw Error('must not send'); };
  for (const args of [null, [], {}, { ...input, headers: { Authorization: 'secret' } }, { ...input, subject: 'other' },
    { ...input, auth: 'arbitrary' }, { ...input, arguments: [] }, { ...input, toolName: '' }]) {
    const result = await api.executeWebappMcp(fixture().options, args, invocation('webappPage'));
    assert.equal(result.error.code, 'invalid_arguments');
  }
  for (const kind of ['desktop', 'agentPlatform']) assert.equal((await api.executeWebappMcp(fixture().options, input, { kind })).error.code, 'forbidden');
  const { options, runtime } = fixture(); runtime.status = 'stopped';
  assert.equal((await api.executeWebappMcp(options, input, invocation('webappBackend'))).error.code, 'app_grant_required');
});

test('in-flight result is not delivered after instance, endpoint or local identity changes', async () => {
  for (const change of [
    ({ runtime }) => { runtime.startedAt++; },
    ({ options }) => { options.issueAgentAccessToken = async () => ({ ok: true, token: tokenFor('replacement') }); },
    ({ options }) => { options.services.getResponsiveServiceState = async () => ({ status: 'running', healthMeta: { webUrl: 'http://127.0.0.1:9999' } }); }
  ]) {
    const f = fixture();
    fetcher = async () => { change(f); return response({ mcp: { content: [] } }); };
    assert.equal((await api.executeWebappMcp(f.options, input, invocation('webappPage'))).error.code, 'app_grant_required');
  }
});

test('request disconnect and grant revocation cancel the upstream call; no retry is sent', async () => {
  for (const [key, expected] of [['requestSignal', 'cancelled'], ['signal', 'app_grant_required']]) {
    const controller = new AbortController(); let count = 0;
    fetcher = async (_url, init) => {
      count++;
      const pending = new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      controller.abort();
      return pending;
    };
    const result = await api.executeWebappMcp(fixture().options, input, { ...invocation('webappBackend'), [key]: controller.signal });
    assert.equal(result.error.code, expected); assert.equal(count, 1);
    count = 0;
    assert.equal((await api.executeWebappMcp(fixture().options, input, { ...invocation('webappPage'), [key]: controller.signal })).error.code, expected);
    assert.equal(count, 0);
  }
});

test('Platform identity errors are preserved and MCP business errors remain tool results', async () => {
  let count = 0;
  fetcher = async () => { count++; return new Response(JSON.stringify({ code: 401, data: { errorCode: 'sso_identity_unavailable' } }), { status: 401 }); };
  assert.equal((await api.executeWebappMcp(fixture().options, input, invocation('webappPage'))).error.code, 'sso_identity_unavailable');
  assert.equal(count, 1);
  const mcp = { content: [{ type: 'text', text: 'business failed' }], isError: true };
  fetcher = async () => response({ mcp });
  assert.deepEqual((await api.executeWebappMcp(fixture().options, input, invocation('webappPage'))).result, { mcp });
  fetcher = async () => response({ token: 'private' });
  assert.equal((await api.executeWebappMcp(fixture().options, input, invocation('webappPage'))).error.code, 'invalid_platform_response');
});

test('MCP capability is admitted for both page and managed backend and revoked with its instance token', () => {
  for (const scope of ['localPageGateway', 'backendActionToken']) {
    const token = api.issueWebappActionToken({ id: 'app' }, scope);
    const grant = api.authorizeWebappActionToken(token, 'mcp.invoke', scope);
    assert.equal(grant.ok, true);
    assert.equal(api.authorizeWebappActionToken(token, 'mcp.anything', scope).ok, false);
    api.revokeWebappActionToken(token);
    assert.equal(grant.signal.aborted, true);
    assert.equal(api.authorizeWebappActionToken(token, 'mcp.invoke', scope).ok, false);
  }
});

test('page and backend share per-app admission and cancelled requests release capacity', async () => {
  const options = fixture().options;
  const controller = new AbortController(); let count = 0; let ready;
  const started = new Promise(resolve => { ready = resolve; });
  fetcher = async (_url, init) => {
    count++; if (count === 2) ready();
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  };
  const pending = ['webappPage', 'webappBackend'].map(kind => api.executeWebappMcp(options, input, { ...invocation(kind), requestSignal: controller.signal }));
  await started;
  assert.equal((await api.executeWebappMcp(options, input, invocation('webappPage'))).error.code, 'app_capacity_exceeded');
  assert.equal(count, 2);
  controller.abort();
  for (const result of await Promise.all(pending)) assert.equal(result.error.code, 'cancelled');
  fetcher = async () => response({ mcp: { content: [] } });
  assert.equal((await api.executeWebappMcp(options, input, invocation('webappBackend'))).ok, true);
});

test('oversized Platform results fail within bounded reading and are never replayed', async () => {
  let count = 0;
  fetcher = async () => { count++; return response({ mcp: { content: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] } }); };
  assert.equal((await api.executeWebappMcp(fixture().options, input, invocation('webappPage'))).error.code, 'invalid_platform_response');
  assert.equal(count, 1);
});
