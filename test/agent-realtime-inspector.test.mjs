import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const projectRoot = process.cwd();
const { RealtimeDebugTraceBuffer } = require("../dist-electron/main/modules/agent-platform/realtime/realtime-debug-trace.js");

function traceInput(data) {
  return { layer: "platform-ws", direction: "platform-to-desktop", data };
}

test("packaged trace capture starts with the Inspector and clears after its close grace", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const buffer = new RealtimeDebugTraceBuffer();
  const input = traceInput({ frame: "response", token: "fixture-token" });
  const unread = {
    get data() {
      assert.fail("disabled trace should never read the input");
    },
  };
  assert.equal(buffer.isEnabled(), false);
  assert.equal(buffer.append(unread), undefined);
  assert.deepEqual(buffer.snapshot(), []);

  buffer.setInspectorOpen(true);
  assert.equal(buffer.append(input).data.token, "fixture-token");
  buffer.setInspectorOpen(false);
  t.mock.timers.tick(59_999);
  assert.equal(buffer.isEnabled(), true);
  buffer.setInspectorOpen(true);
  t.mock.timers.tick(1);
  assert.equal(buffer.snapshot().length, 1);
  buffer.setInspectorOpen(false);
  t.mock.timers.tick(60_000);
  assert.equal(buffer.isEnabled(), false);
  assert.deepEqual(buffer.snapshot(), []);
  buffer.dispose();
  buffer.setInspectorOpen(true);
  assert.equal(buffer.isEnabled(), false);
});

test("disabled capture retains only recent connection metadata", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_788_000_000_000 });
  const buffer = new RealtimeDebugTraceBuffer();
  buffer.recordConnectionFailure("primary", "reconnecting", 2, 1);
  assert.equal(buffer.isEnabled(), false);
  assert.deepEqual(buffer.snapshot().map((entry) => entry.data), [
    { lane: "primary", type: "connection", phase: "reconnecting", generation: 2, reconnectCount: 1 },
  ]);
  t.mock.timers.tick(300_001);
  assert.deepEqual(buffer.snapshot(), []);
});

test("trace retention evicts by bytes and stream traces keep a short preview", () => {
  const buffer = new RealtimeDebugTraceBuffer({ alwaysEnabled: true, maxBytes: 900 });
  const text = "中".repeat(250);
  const event = { seq: 14, type: "content.delta", delta: text, nested: { private: "not-a-preview" } };
  const frame = { frame: "stream", id: "request", event };
  const stream = buffer.append({ ...traceInput(frame), wireBytes: 1_110 });
  assert.equal(stream.data.wireBytes, 1_110);
  assert.deepEqual(stream.data.event, { seq: 14, type: "content.delta", preview: text.slice(0, 200), previewTruncated: true });
  const portEvent = { type: "frame", sessionId: "frame-port", frame };
  const bridged = buffer.append({ ...traceInput(portEvent), layer: "surface-bridge" });
  assert.equal(bridged.data.frame.event.textBytes, 750);
  assert.equal(bridged.data.frame.event.preview.length, 200);
  assert.deepEqual(buffer.snapshot().map((entry) => entry.sequence), [2]);
  assert.deepEqual(buffer.snapshot(2), []);
  assert.equal(frame.event.delta, text);
  assert.equal(buffer.append(traceInput({ message: "x".repeat(2_000) })), undefined);
  assert.deepEqual(buffer.snapshot().map((entry) => entry.sequence), [2]);
});

test("push traces keep the event name without retaining business payloads", () => {
  const buffer = new RealtimeDebugTraceBuffer({ alwaysEnabled: true });
  const frame = { frame: "push", lane: "primary", type: "chat.renamed", data: { title: "private fixture title" } };
  assert.deepEqual(buffer.append({ ...traceInput(frame), wireBytes: 190 }).data, {
    frame: "push", lane: "primary", type: "chat.renamed", wireBytes: 190,
  });
  const port = { type: "frame", sessionId: "frame-port", frame };
  assert.deepEqual(buffer.append({ ...traceInput(port), layer: "surface-bridge" }).data, {
    type: "frame", sessionId: "frame-port", frame: { frame: "push", lane: "primary", type: "chat.renamed" },
  });
  assert.equal(frame.data.title, "private fixture title");
});

test("Frame Port delivery skips trace metadata and serialization with the Inspector closed", () => {
  const { createFrameDelivery } = require("../dist-electron/main/modules/agent-platform/frame-port/frame-delivery.js");
  const sent = [];
  let enabled = false;
  let lookups = 0;
  const traces = [];
  const delivery = createFrameDelivery({
    developmentDiagnosticsEnabled: false,
    options: {
      realtimeBroker: {
        isDebugTraceEnabled: () => enabled,
        appendDebugTrace: (entry) => traces.push(entry),
      },
      browserSurfaces: {
        resolveWebviewSurfaceTarget: () => {
          lookups += 1;
          return { surfaceId: "chat", pageRoute: "/chat" };
        },
      },
    },
  });
  const session = {
    closed: false,
    sender: {
      id: 4,
      isDestroyed: () => false,
      send: (_channel, event) => sent.push(event),
      getURL: () => assert.fail("registered page route should be used"),
    },
  };
  const event = { sessionId: "run", type: "frame", frame: { frame: "stream" } };
  delivery.sendEvent(session, event);
  assert.deepEqual(sent, [event]);
  assert.equal(lookups, 0);
  assert.deepEqual(traces, []);

  enabled = true;
  delivery.sendEvent(session, event);
  assert.equal(lookups, 1);
  assert.deepEqual(sent, [event, event]);
  assert.equal(traces[0].data, event);
  assert.equal(traces[0].route, "/chat");
});

test("only the Inspector top frame reads its raw snapshot and the main top frame opens it", async () => {
  const ts = require("typescript");
  const source = read("src", "main", "app", "ipc-platform-frame.ts");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => ({
      "../modules/agent-platform": {
        registerCanonicalChatSyncIpc: () => ({}),
        registerAgentWebclientBridgeIpcHandlers: () => ({}),
      },
      "./local-document-chat-sync": { createLocalDocumentChatSync() {} },
      "./ipc-document-local-open": { createDesktopDocumentLocalOpen() {} },
    })[name] ?? {},
  });
  const handlers = new Map();
  const createWindow = () => ({
    isDestroyed: () => false,
    webContents: { mainFrame: {}, isDestroyed: () => false },
  });
  const main = createWindow();
  const inspector = createWindow();
  const events = [];
  const reachedSnapshot = new Error("fixture entered snapshot reader");
  exports.registerPlatformFrameIpc({
    app: {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assistantBridgeRuntime: { assistantBridge: {}, desktopActionOptions: {}, realtimeBroker: {
      getDiagnostics: () => { throw reachedSnapshot; },
    } },
    servicesFacade: {},
    browserSurfaces: {},
    getMainWindow: () => main,
    getAgentRealtimeInspectorWindow: () => inspector,
    openAgentRealtimeInspectorWindow: () => { events.push("opened"); return { ok: true }; },
  });
  const mainFrame = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const inspectorFrame = { sender: inspector.webContents, senderFrame: inspector.webContents.mainFrame };
  const inspectorChild = { sender: inspector.webContents, senderFrame: {} };
  const snapshot = handlers.get("diagnostics.getAgentRealtimeDebugSnapshot");
  await assert.rejects(snapshot(mainFrame), /Inspector is unavailable/);
  await assert.rejects(snapshot(inspectorChild), /Inspector is unavailable/);
  await assert.rejects(snapshot(inspectorFrame), (error) => error === reachedSnapshot);
  const open = handlers.get("diagnostics.openAgentRealtimeInspector");
  assert.equal((await open(inspectorFrame)).ok, false);
  assert.equal((await open(mainFrame)).ok, true);
  assert.deepEqual(events, ["opened"]);
});

test("local realtime debug traces preserve credentials and raw routes in both directions", () => {
  const buffer = new RealtimeDebugTraceBuffer({ alwaysEnabled: true, maxEntries: 2 });
  const data = {
    token: "debug-token",
    nested: {
      access_token: "debug-access-token",
      idToken: "debug.id.token",
      refresh_token: "debug-refresh-token",
      authorization: "Bearer debug-authorization",
      cookie: "session=debug-cookie",
      "set-cookie": "session=debug-cookie; HttpOnly",
      apiKey: "debug-key",
      client_secret: "debug-client-secret",
      password: "debug-password",
    },
    text: "Bearer debug-authorization https://example.test/?token=debug-token#id_token=debug.id.token",
  };
  const route = "https://user:password@example.test/path?token=debug-token#id_token=debug.id.token";
  for (const direction of ["surface-to-desktop", "desktop-to-surface", "desktop-to-platform", "platform-to-desktop"]) {
    const entry = buffer.append({ layer: "surface-bridge", direction, data, route });
    assert.deepEqual(entry.data, data);
    assert.notEqual(entry.data, data);
    assert.equal(entry.route, route);
  }
  data.nested.idToken = "changed-after-recording";
  const entries = buffer.snapshot();
  assert.deepEqual(entries.map((entry) => entry.sequence), [3, 4]);
  assert.equal(entries[0].data.nested.idToken, "debug.id.token");
  buffer.clear();
  assert.deepEqual(buffer.snapshot(), []);
});

test("raw debug serialization still bounds oversized and circular values", () => {
  const { serializeAgentRealtimeDebugValue } = require("../dist-electron/main/modules/agent-platform/realtime/realtime-debug-trace.js");
  const input = { token: "x".repeat(70_000) };
  input.self = input;
  const output = serializeAgentRealtimeDebugValue(input);
  assert.ok(output.token.startsWith("x".repeat(64 * 1024)));
  assert.match(output.token, /<TRUNCATED/);
  assert.equal(output.self, "<CIRCULAR>");
});

test("runtime target snapshots preserve raw URLs for registered and orphaned guests", () => {
  const { createAgentRealtimeRuntimeDiagnostics } = require("../dist-electron/main/app/realtime-diagnostics.js");
  const urls = [
    "https://user:password@example.test/path?token=debug-token#id_token=debug.id.token",
    "file:///Users/test/Library/desktop.html?secret=debug-secret",
    "file:///C:/Users/test/desktop.html?token=debug-token#section",
    "data:text/html,<h1>debug</h1>",
    "blob:https://example.test/debug-blob",
    `/local/path?token=${"x".repeat(600)}#fragment`,
  ];
  const contents = urls.map((url, index) => ({ webContentsId: index + 1, url, type: "webview" }));
  const runtime = createAgentRealtimeRuntimeDiagnostics({ getAppMetrics: () => [] }, {
    listWebContentsDiagnostics: () => contents,
    listDiagnosticSurfaces: () => [{
      registrationId: "main-chat", surfaceId: "main-chat", pageRoute: urls[0], tabs: [],
    }, {
      registrationId: "website", surfaceId: "website", tabs: [{ tabId: "tab-1", webContentsId: 2, currentUrl: urls[1] }],
    }],
  });
  assert.deepEqual(runtime.targets.map((target) => target.url), [urls[0], urls[1], urls[0], ...urls.slice(2)]);
});

function read(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

function readTypeScriptFamily(...segments) {
  const target = path.join(projectRoot, ...segments);
  const directory = path.dirname(target);
  const stem = path.basename(target, ".ts");
  return fs.readdirSync(directory)
    .filter((name) => name === `${stem}.ts` || name === "realtime-diagnostics.ts" || name.startsWith("ipc-") && name.endsWith(".ts"))
    .sort()
    .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
    .join("\n");
}

test("Agent Realtime Inspector opens as one independent resizable window", () => {
  const controller = read("src", "main", "modules", "shell", "agent-realtime-inspector-window.ts");
  const runtime = read("src", "main", "app", "runtime.ts");
  const register = readTypeScriptFamily("src", "main", "app", "module-registry.ts");
  const bridge = read("src", "main", "modules", "agent-platform", "frame-port", "session-controller.ts");
  const page = read("src", "renderer", "pages", "AgentRealtimeInspectorPage.tsx");
  const preload = read("src", "preload", "index.ts");

  assert.match(controller, /const existingWindow = this\.getWindow\(\)/);
  assert.match(controller, /existingWindow\.restore\(\)/);
  assert.match(controller, /width: 1480/);
  assert.match(controller, /height: 920/);
  assert.match(controller, /resizable: true/);
  assert.match(controller, /modal: false/);
  assert.doesNotMatch(controller, /^\s*parent:/m);
  assert.match(runtime, /AGENT_REALTIME_INSPECTOR_ROUTE = "\/agent-realtime-inspector"/);
  assert.match(register, /ipcMain\.handle\("diagnostics\.openAgentRealtimeInspector"/);
  assert.match(register, /overviewLease:\s*brokerDiagnostics\.overviewLease/);
  assert.match(register, /lastPlanTaskEventType/);
  assert.match(bridge, /streams: \[\.\.\.session\.streams\.values\(\)\]\.map\(streamBindingDiagnostic\)/);
  assert.match(read("src", "shared", "contracts", "desktop-api.ts"), /state:\s*"pending_chat_identity" \| "ready"/);
  assert.match(page, /<h2>Overview lease<\/h2>/);
  assert.match(page, /run\.lastPlanTaskEventType/);
  assert.match(preload, /openAgentRealtimeInspector: \(\) =>[\s\S]{0,100}diagnostics\.openAgentRealtimeInspector/);
});

test("Desktop Runtime Observer combines targets, memory, topology, and realtime events", () => {
  const app = read("src", "renderer", "App.tsx");
  const page = read("src", "renderer", "pages", "AgentRealtimeInspectorPage.tsx");
  const styles = read("src", "renderer", "pages", "AgentRealtimeInspectorPage.css");
  const settings = read("src", "renderer", "pages", "settings", "SettingsPage.tsx");

  assert.match(app, /location\.pathname === "\/agent-realtime-inspector"/);
  assert.match(page, /className="runtime-target-scroll"/);
  assert.match(page, /type ViewId = "targets" \| "events" \| "topology" \| "system"/);
  assert.match(page, /type DetailTab = "overview" \| "memory" \| "events" \| "raw"/);
  assert.match(page, /MEMORY_HISTORY_WINDOW_MS = 5 \* 60 \* 1_000/);
  assert.match(page, /openAgentRealtimeTargetDevTools/);
  assert.match(page, /processMemoryExplanation/);
  assert.match(page, /className="runtime-detail-section runtime-overview-memory"/);
  assert.match(page, /className="runtime-detail-events is-compact"/);
  assert.match(page, /connection\?\.lastHeartbeatAt/);
  assert.match(page, /run\.lastRestoreResult/);
  assert.match(page, /eventSurfaceId !== "all" && entry\.surfaceId !== eventSurfaceId/);
  assert.match(page, /window\.setInterval\(\(\) => void loadSnapshot\(\), 500\)/);
  assert.match(styles, /grid-template-columns: minmax\(680px, 1fr\) minmax\(330px, 360px\)/);
  assert.match(styles, /--runtime-accent: #5790ff/);
  assert.match(styles, /\.runtime-target-grid/);
  assert.match(settings, /diagnostics\.openAgentRealtimeInspector\(\)/);
  assert.doesNotMatch(settings, /diagnostics\.getAgentRealtimeDebugSnapshot\(\)/);
});

test("runtime debug diagnostics stay main-owned and preserve target URLs", () => {
  const register = readTypeScriptFamily("src", "main", "app", "module-registry.ts");
  const registry = read("src", "main", "modules", "web-surfaces", "browser-surface-registry.ts");
  const preload = read("src", "preload", "index.ts");
  const contracts = read("src", "shared", "contracts", "desktop-api.ts");

  assert.match(register, /createAgentRealtimeRuntimeDiagnostics/);
  assert.match(register, /url: surface\.pageRoute \|\| surface\.url/);
  assert.match(register, /url: tab\.currentUrl \|\| surface\.pageRoute \|\| surface\.url/);
  assert.match(register, /url: contents\.url/);
  assert.match(register, /app\.getAppMetrics\(\)/);
  assert.match(register, /const orphaned = contents\.type === "webview"/);
  assert.doesNotMatch(register, /contents\.type !== "webview" \|\| claimedWebContentsIds/);
  assert.match(registry, /listDiagnosticSurfaces/);
  assert.match(registry, /listWebContentsDiagnostics/);
  assert.match(preload, /diagnostics\.openAgentRealtimeTargetDevTools/);
  assert.match(contracts, /runtime: \{/);
  assert.match(contracts, /processes: AgentRealtimeDebugProcess\[\]/);
  assert.match(contracts, /targets: AgentRealtimeDebugTarget\[\]/);
});
