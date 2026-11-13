import { app, screen, webContents, type WebContents } from "electron";
import os from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { BrowserSurfaceRegistry } from "../modules/web-surfaces";
import { createAgentRealtimeRuntimeDiagnostics } from "./realtime-diagnostics";
import { getDesktopLogRoot } from "../support/logging/desktop";
import { configurePerformanceDiagnostics, isPerformanceDiagnosticsEnabled, startPerformanceWriter, writePerformanceEvent } from "../support/logging/performance";
import { configureStartupTimingOutput } from "../support/logging/startup-timing";
import { getDesktopConfigRoot } from "../infrastructure/filesystem/user-paths";
import { readDesktopProfileFromRoot } from "../infrastructure/filesystem/profile-store";
import { sampleServiceMemory } from "./service-memory-diagnostics";

export function startPerformanceDiagnostics(registry: BrowserSurfaceRegistry) {
  const logRoot = getDesktopLogRoot(app);
  configureStartupTimingOutput(logRoot);
  try {
    configurePerformanceDiagnostics(readDesktopProfileFromRoot(getDesktopConfigRoot(app)).diagnostics.performanceEnabled);
  } catch {
    console.warn("[performance] unable to read performance preference");
  }
  if (!isPerformanceDiagnosticsEnabled()) return;
  const stopWriter = startPerformanceWriter(logRoot);
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const cleanups = new Map<number, () => void>();
  const track = (contents: WebContents) => {
    if (cleanups.has(contents.id)) return;
    const id = contents.id;
    const type = contents.getType();
    let pid = 0;
    const emit = (stage: string) => {
      try { if (!contents.isDestroyed()) pid = contents.getOSProcessId(); } catch { /* Guest is exiting. */ }
      writePerformanceEvent({ stage, webContentsId: id, type, pid });
    };
    const started = () => emit("contents-loading");
    const ready = () => emit("contents-dom-ready");
    const finished = () => emit("contents-loaded");
    const gone = () => emit("contents-render-process-gone");
    const destroyed = () => { emit("contents-destroyed"); cleanups.delete(id); };
    contents.on("did-start-loading", started);
    contents.on("dom-ready", ready);
    contents.on("did-finish-load", finished);
    contents.on("render-process-gone", gone);
    contents.once("destroyed", destroyed);
    cleanups.set(id, () => {
      contents.removeListener("did-start-loading", started);
      contents.removeListener("dom-ready", ready);
      contents.removeListener("did-finish-load", finished);
      contents.removeListener("render-process-gone", gone);
      contents.removeListener("destroyed", destroyed);
    });
    emit("contents-observed");
  };
  const created = (_event: Electron.Event, contents: WebContents) => track(contents);
  app.on("web-contents-created", created);
  webContents.getAllWebContents().forEach(track);
  writePerformanceEvent({ stage: "session-start", mainPid: process.pid,
    processElapsedMs: Math.round(process.uptime() * 1000),
    platform: process.platform, osRelease: os.release(), arch: process.arch,
    desktopVersion: app.getVersion(), electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome, cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(), gpuFeatures: app.getGPUFeatureStatus(),
    displays: screen.getAllDisplays().map(({ size, scaleFactor }) => ({ size, scaleFactor })),
  });
  let previous = new Map<string, number>();
  let backgroundSince = new Map<number, number>();
  const sample = () => {
    try {
      const snapshot = createAgentRealtimeRuntimeDiagnostics(app, registry);
      const next = new Map<string, number>();
      const processes = snapshot.processes.map((item) => {
        const key = `${item.pid}:${item.creationTime}`;
        next.set(key, item.workingSetBytes);
        // Windows private bytes and macOS working set have different accounting semantics.
        const memory = process.platform === "win32" ? { privateBytes: item.privateBytes } : {};
        return { pid: item.pid, type: item.type, creationTime: item.creationTime,
          cpuPercent: item.cpuPercent, workingSetBytes: item.workingSetBytes, ...memory,
          deltaBytes: previous.has(key) ? item.workingSetBytes - previous.get(key)! : null };
      });
      previous = next;
      const sampledAt = performance.now();
      const nextBackgroundSince = new Map<number, number>();
      const targets = snapshot.targets.map((target) => {
        let backgroundDurationMs: number | null = null;
        if (target.webContentsType === "webview" && target.webContentsId && !target.active && !target.orphaned) {
          const since = backgroundSince.get(target.webContentsId) ?? sampledAt;
          nextBackgroundSince.set(target.webContentsId, since);
          backgroundDurationMs = Math.round(sampledAt - since);
        }
        return { surfaceId: target.surfaceId, surfaceRole: target.surfaceRole, surfaceType: target.surfaceType,
          webContentsId: target.webContentsId, pid: target.pid, active: target.active, backgroundDurationMs,
          orphaned: target.orphaned, loading: target.loading,
          devToolsOpened: target.devToolsOpened, backgroundThrottling: target.backgroundThrottling };
      });
      backgroundSince = nextBackgroundSince;
      writePerformanceEvent({ stage: "resources", processes,
        surfaceCount: snapshot.surfaceCount, webviewCount: snapshot.webviewCount,
        orphanWebviewCount: snapshot.orphanWebviewCount,
        totalWorkingSetBytes: snapshot.totalWorkingSetBytes,
        mainEventLoopMaxMs: loop.max / 1e6, mainEventLoopP99Ms: loop.percentile(99) / 1e6,
        targets
      });
      loop.reset();
    } catch { writePerformanceEvent({ stage: "resource-sample-failed" }); }
  };
  const timer = setInterval(sample, 5000);
  timer.unref();
  let stopped = false;
  let samplingServiceMemory = false;
  const serviceTimer = process.platform === "win32" ? setInterval(() => {
    if (samplingServiceMemory) return;
    samplingServiceMemory = true;
    void sampleServiceMemory(app).then((services) => {
      if (stopped) return;
      // Join by service and process identity when comparing repeated samples.
      // WebClient runs in Main and is already included in Electron's sample.
      writePerformanceEvent({ stage: "service-resources", services });
    }).catch(() => {
      if (!stopped) writePerformanceEvent({ stage: "service-resource-sample-failed" });
    }).finally(() => { samplingServiceMemory = false; });
  }, 30_000) : undefined;
  serviceTimer?.unref();
  app.once("will-quit", () => {
    stopped = true;
    clearInterval(timer); loop.disable();
    if (serviceTimer) clearInterval(serviceTimer);
    app.removeListener("web-contents-created", created);
    cleanups.forEach((cleanup) => cleanup()); cleanups.clear();
    writePerformanceEvent({ stage: "session-end" });
    void stopWriter();
  });
}
