import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const { sanitizePerformanceEvent } = require("../dist-electron/shared/performance-diagnostics.js");
const { configurePerformanceDiagnostics, createPerformanceWriter, isPerformanceDiagnosticsEnabled } = require("../dist-electron/main/support/logging/performance.js");
const { __testInternals: memoryInternals } = require("../dist-electron/main/app/service-memory-diagnostics.js");
const { configureStartupTimingOutput, markStartupMilestone, persistStartupTimingSnapshot, beginStartupTiming,
  __testInternals: startupInternals } = require("../dist-electron/main/support/logging/startup-timing.js");
const { measureStartupSyncCommand } = require("../dist-electron/main/infrastructure/process/startup-sync-command.js");
const { registerShellIpcHandlers } = require("../dist-electron/main/modules/shell/ipc.js");
const { getDesktopConfigRoot } = require("../dist-electron/main/infrastructure/filesystem/user-paths.js");

test("performance payload drops URLs, chat contents, arbitrary strings and invalid measurements", () => {
  const result = sanitizePerformanceEvent({ stage: "dom-ready", webContentsId: 17, active: false,
    hostRoute: "/agent/private?chatId=secret", url: "https://secret", token: "secret", body: "secret",
    surfaceId: "bad/url", elapsedMs: Infinity, hostMonoMs: -1, transitionId: NaN,
    nested: { token: "secret" } });
  assert.deepEqual(result, { stage: "dom-ready", webContentsId: 17, active: false });
});

test("performance collection requires explicit launch opt-in", () => {
  const old = process.env.PERF;
  try {
    delete process.env.PERF;
    assert.equal(isPerformanceDiagnosticsEnabled(), false);
    process.env.PERF = "true";
    assert.equal(isPerformanceDiagnosticsEnabled(), false);
    configurePerformanceDiagnostics(true);
    assert.equal(isPerformanceDiagnosticsEnabled(), true);
    configurePerformanceDiagnostics(false);
    process.env.PERF = "1";
    assert.equal(isPerformanceDiagnosticsEnabled(), true);
  } finally {
    configurePerformanceDiagnostics(false);
    if (old === undefined) delete process.env.PERF;
    else process.env.PERF = old;
  }
});

test("startup snapshot keeps measurements and late milestones without command arguments or archive names", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zenmind-startup-timing-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.throws(() => measureStartupSyncCommand("powershell.exe", "readWindowsRuntimeRootFromRegistryUncached", () => {
    throw new Error("sensitive-error");
  }), /sensitive-error/u);
  const phase = beginStartupTiming("runServiceCommand", {
    serviceId: "agent-platform", args: "--token sensitive", archive: "private.zip", customCount: 3
  }, { log: false });
  phase.end();
  configureStartupTimingOutput(root);
  persistStartupTimingSnapshot();
  markStartupMilestone("renderer-first-contentful-paint", 130);
  markStartupMilestone("renderer-first-contentful-paint", 230);
  markStartupMilestone("main-chat-document-loaded", 420);
  await startupInternals.waitForStartupTimingSnapshot();
  const source = await fs.readFile(path.join(root, "startup-timing.json"), "utf8");
  const result = JSON.parse(source);
  assert.equal(result.measuredSyncCommandCount, 1);
  assert.equal(result.startupFinished, true);
  assert.ok(result.milestones["main-chat-document-loaded"] >= 0);
  assert.equal(result.rendererMilestones["renderer-first-contentful-paint"], 130);
  assert.deepEqual(result.events.find((event) => event.phase === "runServiceCommand").metadata,
    { serviceId: "agent-platform", customCount: 3 });
  assert.deepEqual(result.events.find((event) => event.phase === "startup.sync-command").metadata, {
    command: "powershell.exe", callSite: "readWindowsRuntimeRootFromRegistryUncached"
  });
  assert.doesNotMatch(source, /sensitive|private\.zip/u);
  assert.deepEqual(await fs.readdir(root), ["startup-timing.json"]);
});

test("Windows tasklist parser reads localized working set only for the requested PID", () => {
  const parse = memoryInternals.parseTasklistWorkingSetBytes;
  assert.equal(parse('"platform.exe","123","Console","1","98,765 K"\r\n', 123), 98_765 * 1024);
  assert.equal(parse('"service.exe","123","Services","0","98.765 K"\r\n', 123), 98_765 * 1024);
  assert.equal(parse('"service.exe","123","Services","0","98\u00a0765 K"\r\n', 123), 98_765 * 1024);
  assert.equal(parse('"service.exe","123","Services","0","98,765 K"\r\n', 456), null);
  assert.equal(parse("INFO: No tasks are running which match the specified criteria.", 123), null);
});

test("only the main window top frame can persist the next-launch diagnostics preference", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zenmind-perf-ipc-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  const sender = { mainFrame: {} };
  const mainWindow = { webContents: sender };
  const handlers = new Map();
  registerShellIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler), on() {} }, { app, mainWindow });
  const get = handlers.get("diagnostics.getPerformancePreference");
  const set = handlers.get("diagnostics.setPerformancePreference");
  const event = { sender, senderFrame: sender.mainFrame };
  assert.equal(get(event), false);
  assert.throws(() => set({ sender, senderFrame: {} }, true), /Invalid performance setting request/u);
  assert.throws(() => set(event, "true"), /Invalid performance setting request/u);
  assert.equal(set(event, true), true);
  assert.equal(get(event), true);
  const profile = JSON.parse(await fs.readFile(path.join(getDesktopConfigRoot(app), "profile.json"), "utf8"));
  assert.equal(profile.diagnostics.performanceEnabled, true);
});

test("writer rotates bounded JSONL files and reports dropped events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zenmind-perf-test-"));
  try {
    const writer = createPerformanceWriter(root, 500);
    writer.write({ stage: "too-large", payload: "x".repeat(1000) });
    writer.write({ stage: "first", payload: "x".repeat(220) });
    await writer.flush();
    writer.write({ stage: "second", payload: "x".repeat(220) });
    await writer.close();
    const previous = JSON.parse(await fs.readFile(path.join(root, "performance.jsonl.1"), "utf8"));
    const current = JSON.parse(await fs.readFile(path.join(root, "performance.jsonl"), "utf8"));
    assert.equal(previous.stage, "first");
    assert.equal(previous.dropped, 1);
    assert.equal(current.stage, "second");
    for (const file of await fs.readdir(root)) assert.ok((await fs.stat(path.join(root, file))).size <= 500);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("writer serializes concurrent flushes and drains events queued during a write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zenmind-perf-test-"));
  try {
    const writer = createPerformanceWriter(root);
    writer.write({ stage: "first" });
    const flushing = writer.flush();
    writer.write({ stage: "second" });
    await Promise.all([flushing, writer.close()]);
    const lines = (await fs.readFile(path.join(root, "performance.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.stage), ["first", "second"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("rapid navigation uses matching route identity and monotonic time, never the next switch", async () => {
  const source = await fs.readFile(new URL("../src/renderer/services/performanceDiagnostics.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const reports = [];
  let now = 100, sequence = 0;
  const context = { exports: {}, require: () => ({ sanitizePerformanceEvent }), URLSearchParams,
    crypto: { randomUUID: () => `id-${++sequence}` }, performance: { now: () => now },
    window: { electronAPI: { diagnostics: { performanceEnabled: true, reportRendererError: (report) => reports.push(report.details) } } } };
  vm.runInNewContext(compiled, context);
  const api = context.exports;
  const trace = api.createSurfacePerformanceTrace();
  api.beginChatPerformanceNavigation("/agent/a?chatId=private-a");
  now = 125;
  trace("main-chat-router-waiting-ready", { transitionId: 1, hostRoute: "/agent/a?chatId=private-a" });
  const firstId = reports.at(-1).switchId;
  assert.equal(reports.at(-1).elapsedMs, 25);
  now = 150;
  api.beginChatPerformanceNavigation("/agent/a?chatId=private-b");
  trace("main-chat-route-transition-replaced", { transitionId: 1 });
  assert.equal(reports.at(-1).switchId, firstId);
  assert.equal(reports.at(-1).elapsedMs, 50);
  trace("main-chat-router-waiting-ready", { transitionId: 2, hostRoute: "/agent/a?chatId=private-b" });
  const secondId = reports.at(-1).switchId;
  assert.notEqual(secondId, firstId);
  now = 220;
  trace("main-chat-router-applied-accepted", { transitionId: 2, completionScope: "router-only" });
  assert.equal(reports.at(-1).elapsedMs, 70);
  assert.equal(reports.at(-1).switchId, secondId);
  assert.ok(!JSON.stringify(reports).includes("private-"));
  context.window.electronAPI.diagnostics.performanceEnabled = false;
  const count = reports.length;
  trace("dom-ready", {});
  assert.equal(reports.length, count);
});

for (const platform of ["win32", "darwin"]) {
  test(`${platform} sampler preserves process accounting, strips target content and cleans up`, async () => {
    const source = await fs.readFile(new URL("../src/main/app/performance-diagnostics.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    const app = Object.assign(new EventEmitter(), { getVersion: () => "test", getGPUFeatureStatus: () => ({ gpu_compositing: "enabled" }) });
    const guest = Object.assign(new EventEmitter(), { id: 10, getType: () => "webview", isDestroyed: () => false, getOSProcessId: () => 100 });
    const records = [];
    const ticks = new Map();
    let stopped = false, loopDisabled = false, bytes = 1000, now = 1000, active = false, memorySamples = 0;
    const imports = {
      electron: { app, screen: { getAllDisplays: () => [] }, webContents: { getAllWebContents: () => [guest] } },
      "node:os": { release: () => "test", cpus: () => [{ model: "test" }], totalmem: () => 8192 },
      "node:perf_hooks": { performance: { now: () => now },
        monitorEventLoopDelay: () => ({ enable() {}, disable() { loopDisabled = true; }, reset() {}, max: 1000000, percentile: () => 1000000 }) },
      "./realtime-diagnostics": { createAgentRealtimeRuntimeDiagnostics: () => ({
        processes: [{ pid: 100, type: "Tab", creationTime: 1, workingSetBytes: bytes, privateBytes: 500, cpuPercent: 1 }],
        targets: [{ webContentsId: 10, webContentsType: "webview", pid: 100, surfaceId: "main-chat",
          surfaceRole: "main-chat", title: "PRIVATE_TITLE", url: "PRIVATE_URL", active }],
        surfaceCount: 1, webviewCount: 1, orphanWebviewCount: 0, totalWorkingSetBytes: bytes,
      }) },
      "../support/logging/desktop": { getDesktopLogRoot: () => "unused" },
      "../support/logging/performance": { configurePerformanceDiagnostics() {}, isPerformanceDiagnosticsEnabled: () => true,
        startPerformanceWriter: () => () => { stopped = true; }, writePerformanceEvent: (record) => records.push(record) },
      "../support/logging/startup-timing": { configureStartupTimingOutput() {} },
      "../infrastructure/filesystem/user-paths": { getDesktopConfigRoot: () => "unused" },
      "../infrastructure/filesystem/profile-store": { readDesktopProfileFromRoot: () => ({ diagnostics: { performanceEnabled: false } }) },
      "./service-memory-diagnostics": { sampleServiceMemory: async () => {
        memorySamples++;
        return [{ serviceId: "agent-platform", pid: 123, workingSetBytes: 500 }];
      } },
    };
    const context = { exports: {}, require: (name) => { assert.ok(name in imports, name); return imports[name]; },
      process: { platform, arch: "test", pid: 1, uptime: () => 1, versions: {} },
      setInterval: (callback, delay) => { ticks.set(delay, callback); return { unref() {} }; }, clearInterval() {},
    };
    vm.runInNewContext(compiled, context);
    context.exports.startPerformanceDiagnostics({});
    ticks.get(5000)();
    const first = records.at(-1).processes[0];
    assert.equal(first.deltaBytes, null);
    assert.equal("privateBytes" in first, platform === "win32");
    assert.equal(records.at(-1).targets[0].backgroundDurationMs, 0);
    bytes = 1200;
    now += 5000;
    ticks.get(5000)();
    assert.equal(records.at(-1).processes[0].deltaBytes, 200);
    assert.equal(records.at(-1).targets[0].backgroundDurationMs, 5000);
    active = true;
    ticks.get(5000)();
    assert.equal(records.at(-1).targets[0].backgroundDurationMs, null);
    if (platform === "win32") {
      ticks.get(30000)();
      ticks.get(30000)();
      await Promise.resolve();
      assert.equal(memorySamples, 1);
      assert.equal(records.at(-1).services[0].workingSetBytes, 500);
    } else {
      assert.equal(ticks.has(30000), false);
    }
    assert.ok(!JSON.stringify(records).includes("PRIVATE_"));
    guest.emit("dom-ready");
    assert.equal(records.at(-1).stage, "contents-dom-ready");
    assert.equal(records.at(-1).pid, 100);
    app.emit("will-quit");
    assert.equal(stopped, true);
    assert.equal(loopDisabled, true);
    assert.equal(guest.listenerCount("dom-ready"), 0);
    assert.equal(app.listenerCount("web-contents-created"), 0);
  });
}
