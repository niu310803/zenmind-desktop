import { observePlatformPageTraffic, type PlatformPageTraffic, postPlatformTicket } from "./platform-navigation";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { App, WebContents } from "electron";
import { session } from "electron";
import type { WebappEntry, WebappRuntimeState, WebappCommandResult } from "../../../../shared/contracts";
import { getDesktopRoot } from "../../../infrastructure/filesystem/user-paths";
import { getService, getServiceLayout, buildServiceEnv, resolvePreferredAgentPlatformRuntimeRoot, isProcessRunning, matchProcessInstallDirAsync, terminateCapturedProcessTreeAsync, listProcessTreePidsAsync } from "../../services";
import { webappPlatformLayout, readPlatformProcessSnapshot, platformProcessIsAlive } from "./platform-layout";
import { createBaseState, createStoppedState, nowIso, writeState, readStoredState } from "./runtime-state";
import { pipeChildLogs, waitForChildExit, writeLogLine } from "./runtime-process";
import { getLogPath } from "./runtime-state";

type Ready = { pid: number; apiUrl: string; appUrl: string; platformVersion: string };
type Instance = { traffic?: PlatformPageTraffic; capturedPids: number[]; generation: number; healthFailures: number; monitoring: boolean; item: WebappEntry; child: ChildProcess | null; state: WebappRuntimeState; ready: Ready | null; timer?: NodeJS.Timeout; stopping: boolean; failures: number };
export const platformWebappPartition = (id: string) => `webapp-platform:${id}`;
export function validateReady(value: unknown, pid: number): Ready {
  const ready = value as Ready;
  if (!ready || ready.pid !== pid || typeof ready.platformVersion !== "string") throw new Error("Invalid Platform ready file.");
  for (const raw of [ready.apiUrl, ready.appUrl]) {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Platform must report a private loopback origin.");
  }
  if (new URL(ready.apiUrl).origin === new URL(ready.appUrl).origin) throw new Error("Platform API and application must have separate origins.");
  return ready;
}
export function platformLaunchOptions(app: App, item: WebappEntry, platform: NodeJS.Platform = process.platform) {
  if (platform !== "darwin" && platform !== "win32") throw new Error("Independent Platform apps require macOS or Windows Desktop.");
  const service = getService("agent-platform"), serviceLayout = getServiceLayout(app, service);
  if (!service.backend?.entry) throw new Error("Platform bundle does not declare its executable.");
  const binary = path.resolve(serviceLayout.programDir, service.backend.entry);
  const relative = path.relative(serviceLayout.programDir, binary);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid Platform executable.");
  const layout = webappPlatformLayout(app, item.id, platform);
  const node = platform === "win32" ? path.join(getDesktopRoot(app, platform), "bin", "node.exe") : path.join(getDesktopRoot(app, platform), "bin", "node");
  const hostKeys = new Set(["APPDATA", "COMSPEC", "HOME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LOCALAPPDATA", "PATH", "PATHEXT", "PROGRAMDATA", "PROGRAMFILES", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "TZ", "USERPROFILE", "WINDIR"]);
  const inherited = Object.fromEntries(Object.entries(buildServiceEnv()).filter(([key]) => hostKeys.has(key.toUpperCase())));
  const env: NodeJS.ProcessEnv = { ...inherited, AP_RUNTIME_DIR: layout.runtime, AP_RUNTIME_REGISTRIES_DIR: path.join(resolvePreferredAgentPlatformRuntimeRoot(app), "registries") };
  // Independent instances must never inherit the main Platform's identity or directory overrides.
  for (const key of Object.keys(env)) if ((key.startsWith("AP_") && key !== "AP_RUNTIME_DIR" && key !== "AP_RUNTIME_REGISTRIES_DIR") || key === "ELECTRON_RUN_AS_NODE") delete env[key];
  return { binary, layout, node, env, args: ["--runtime-mode=standalone", "--webapp-host=single", `--config-dir=${layout.config}`, "--listen=127.0.0.1:0", `--ready-file=${layout.ready}`, `--webapp-node=${node}`, `--parent-pid=${process.pid}`],
    // macOS gets a process group; Windows termination captures and kills the process tree.
    detached: platform === "darwin", windowsHide: platform === "win32" };
}
export function platformVersionSatisfies(actual: string, minimum: string) {
  const parse = (version: string) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
    if (!match) return null;
    const prerelease = match[4]?.split(".") ?? [];
    if (prerelease.some(part => !part || /^0\d+$/u.test(part))) return null;
    return { core: match.slice(1, 4).map(part => BigInt(part!)), prerelease };
  };
  const current = parse(actual), required = parse(minimum);
  if (!current || !required) return false;
  for (let index = 0; index < 3; index++) if (current.core[index] !== required.core[index]) return current.core[index]! > required.core[index]!;
  if (!current.prerelease.length || !required.prerelease.length) return !current.prerelease.length;
  for (let index = 0; index < Math.max(current.prerelease.length, required.prerelease.length); index++) {
    const left = current.prerelease[index], right = required.prerelease[index];
    if (left === right) continue;
    if (left === undefined || right === undefined) return right === undefined;
    const leftNumeric = /^\d+$/u.test(left), rightNumeric = /^\d+$/u.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right);
    if (leftNumeric !== rightNumeric) return !leftNumeric;
    return left > right;
  }
  return true;
}
export function shouldRecyclePlatform(status: unknown, traffic?: PlatformPageTraffic, now = Date.now()) {
  const activity = status as { idle?: unknown; activeRuns?: unknown; awaitingRuns?: unknown; activeRequests?: unknown; lastRequestAt?: unknown } | null;
  return activity?.idle === true && activity.activeRuns === 0 && activity.awaitingRuns === 0 && activity.activeRequests === 0 &&
    typeof activity.lastRequestAt === "number" && Number.isFinite(activity.lastRequestAt) && !traffic?.activeRequests.size &&
    now - Math.max(activity.lastRequestAt, traffic?.lastRequestAt ?? 0) >= 30 * 60_000;
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export class WebappPlatformInstances {
  private readonly records = new Map<string, Instance>();
  private readonly operations = new Map<string, Promise<WebappCommandResult>>();
  private readonly generations = new Map<string, number>();
  private readonly guests = new WeakSet<WebContents>();
  constructor(private readonly changed: (id: string) => void) {}
  has(id: string) { return this.records.has(id); }
  ids() { return [...new Set([...this.records.keys(), ...this.operations.keys()])]; }
  status(id: string) { const record = this.records.get(id); return record ? { ...record.state } : null; }
  check(app: App, item: WebappEntry) {
    try {
      const launch = platformLaunchOptions(app, item);
      if (!fs.statSync(launch.binary).isFile()) throw new Error("Platform executable is missing.");
      if (item.backend && !fs.statSync(launch.node).isFile()) throw new Error("Desktop Node runtime is not prepared.");
      if (!platformVersionSatisfies(getService("agent-platform").version, item.minPlatformVersion!)) throw new Error(`Platform ${item.minPlatformVersion} or newer is required.`);
      return { ok: true, launcher: "platform" as const, ownership: "desktop" as const, runtimeVersion: getService("agent-platform").version, externalId: launch.binary, backendUrl: "", backendPort: null, issues: [], message: "" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, launcher: "platform" as const, ownership: "desktop" as const, runtimeVersion: "", externalId: "", backendUrl: "", backendPort: null, issues: [{ code: "platform_unavailable", message }], message };
    }
  }
  private queue(id: string, task: () => Promise<WebappCommandResult>) {
    const result = (this.operations.get(id) ?? Promise.resolve()).then(task);
    this.operations.set(id, result);
    void result.finally(() => { if (this.operations.get(id) === result) this.operations.delete(id); }).catch(() => undefined);
    return result;
  }
  start(app: App, item: WebappEntry) {
    const generation = this.generations.get(item.id) ?? 0;
    return this.queue(item.id, () => this.launch(app, item, 0, generation));
  }
  private async launch(app: App, item: WebappEntry, failures = 0, generation = this.generations.get(item.id) ?? 0): Promise<WebappCommandResult> {
    if (generation !== (this.generations.get(item.id) ?? 0)) return { ok: false, item, state: createStoppedState(item), message: "Platform startup was cancelled." };
    const current = this.records.get(item.id);
    if (current?.state.status === "running") return { ok: true, item, state: current.state, message: current.state.message };
    if (current) { const stopped = await this.stopInstance(app, item); if (!stopped.ok) return stopped; }
    const stored = readStoredState(app, item);
    if (stored?.pid && isProcessRunning(stored.pid) || readPlatformProcessSnapshot(app, item.id).some(platformProcessIsAlive)) {
      const stopped = await this.stopInstance(app, item); if (!stopped.ok) return stopped;
    }
    const record: Instance = { capturedPids: [], generation, healthFailures: 0, monitoring: false, item, child: null, ready: null, stopping: false, failures, state: createBaseState(item, "starting", "") };
    this.records.set(item.id, record); writeState(app, record.state);
    try {
      const check = this.check(app, item); if (!check.ok) throw new Error(check.message);
      const launch = platformLaunchOptions(app, item);
      for (const dir of [launch.layout.runtime, launch.layout.run, launch.layout.logs]) fs.mkdirSync(dir, { recursive: true });
      fs.rmSync(launch.layout.ready, { force: true });
      const child = spawn(launch.binary, launch.args, { cwd: path.dirname(launch.binary), env: launch.env, detached: launch.detached, windowsHide: launch.windowsHide, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      record.child = child; record.state.pid = child.pid ?? null; writeState(app, record.state); pipeChildLogs(app, item.id, child);
      let spawnError: Error | null = null;
      child.on("error", error => { spawnError = error; });
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (generation !== (this.generations.get(item.id) ?? 0)) throw new Error("Platform startup was cancelled.");
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Platform exited before readiness (${child.exitCode ?? child.signalCode}).`);
        if (fs.existsSync(launch.layout.ready)) {
          const ready = validateReady(JSON.parse(await fs.promises.readFile(launch.layout.ready, "utf8")), child.pid!);
          if (!platformVersionSatisfies(ready.platformVersion, item.minPlatformVersion!)) throw new Error(`Platform ${item.minPlatformVersion} or newer is required.`);
          const health = await fetch(new URL("/healthz", ready.apiUrl), { redirect: "error", signal: AbortSignal.timeout(5000) });
          if (health.ok) { record.ready = ready; break; }
        }
        await pause(100);
      }
      if (!record.ready) throw new Error("Platform readiness timed out. See instance logs.");
      const ready = record.ready;
      record.state = { ...record.state, status: "running", runtimeVersion: ready.platformVersion, webUrl: ready.appUrl, frontendPort: Number(new URL(ready.appUrl).port), backendUrl: ready.apiUrl, backendPort: Number(new URL(ready.apiUrl).port), startedAt: nowIso(), updatedAt: nowIso(), message: "" };
      writeState(app, record.state);
      child.once("exit", () => {
        if (record.stopping || this.records.get(item.id) !== record) return;
        clearInterval(record.timer);
        record.state = { ...record.state, status: "error", webUrl: "", message: "Independent Platform exited. See instance logs.", updatedAt: nowIso() }; writeState(app, record.state); this.changed(item.id);
        if (record.failures < 3) {
          const timer = setTimeout(() => { if (!record.stopping && this.records.get(item.id) === record) void this.queue(item.id, () => this.launch(app, item, record.failures + 1, record.generation)); }, 1000 * (record.failures + 1));
          timer.unref();
        }
      });
      record.timer = setInterval(() => { void this.monitor(app, record); }, 60_000); record.timer.unref();
      this.changed(item.id);
      return { ok: true, item, state: record.state, message: "" };
    } catch (error) {
      record.stopping = true;
      const terminated = !record.child || await this.terminateChild(app, record);
      record.state = { ...record.state, status: "error", webUrl: "", pid: terminated ? null : record.child?.pid ?? null, message: error instanceof Error ? error.message : String(error), updatedAt: nowIso() };
      writeState(app, record.state); writeLogLine(getLogPath(app, item.id, "error"), record.state.message); this.changed(item.id);
      return { ok: false, item, state: record.state, message: record.state.message };
    }
  }
  private async ownerRequest(app: App, record: Instance, route: string, body?: unknown, method?: "PUT") {
    if (!record.ready || record.state.status !== "running") throw new Error("Platform is not running.");
    const credential = JSON.parse(await fs.promises.readFile(path.join(webappPlatformLayout(app, record.item.id).runtime, ".state", "webapp-owner", "owner.json"), "utf8"));
    if (typeof credential.token !== "string" || !credential.token) throw new Error("Invalid Platform owner credential.");
    const response = await fetch(new URL(route, record.ready.apiUrl), { method: method ?? (body === undefined ? "GET" : "POST"), headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Platform request failed (${response.status}).`);
    const envelope = await response.json() as { data: any }; return envelope.data;
  }
  async userConfig(app: App, item: WebappEntry, values?: unknown) {
    const started = await this.start(app, item);
    if (!started.ok) throw new Error(started.message);
    const record = this.records.get(item.id)!;
    const route = `/api/admin/webapps/${encodeURIComponent(item.id)}`;
    let config = await this.ownerRequest(app, record, route);
    if (values !== undefined) config = await this.ownerRequest(app, record, `${route}/user-config`, { expectedRevision: config.configRevision, values }, "PUT");
    return { ok: true as const, values: config.userConfig as import("../../../../shared/webapp-manifest").WebappUserConfigValues, issues: [] };
  }
  async openGuest(app: App, id: string, guest: WebContents) {
    const record = this.records.get(id);
    if (!record?.ready || guest.isDestroyed()) throw new Error("Independent Platform is not running.");
    if (guest.session !== session.fromPartition(platformWebappPartition(id))) throw new Error("Independent Platform guest session mismatch.");
    record.traffic = observePlatformPageTraffic(guest, new URL(record.ready.appUrl).origin);
    const launch = await this.ownerRequest(app, record, `/api/admin/webapps/${encodeURIComponent(id)}/launch-ticket`, { returnPath: "/" });
    if (this.records.get(id) !== record || record.stopping || guest.isDestroyed()) throw new Error("Independent Platform session changed.");
    const action = new URL(launch.action);
    if (action.origin !== new URL(record.ready.appUrl).origin || action.pathname !== "/__desktop/session/exchange" || action.search || action.hash || typeof launch.ticket !== "string") throw new Error("Invalid Platform launch ticket.");
    await postPlatformTicket(guest, action.href, new URL(record.ready.apiUrl).origin, launch.ticket);
  }
  configureGuest(app: App, guest: WebContents) {
    for (const record of this.records.values()) {
      if (!record.ready || guest.session !== session.fromPartition(platformWebappPartition(record.item.id))) continue;
      if (this.guests.has(guest)) return true;
      this.guests.add(guest);
      guest.once("dom-ready", () => { void this.openGuest(app, record.item.id, guest).catch(error => { writeLogLine(getLogPath(app, record.item.id, "error"), error instanceof Error ? error.message : String(error)); }); });
      return true;
    }
    return false;
  }
  partitionForUrl(raw: string) {
    try { const origin = new URL(raw).origin; for (const record of this.records.values()) if (record.state.status === "running" && record.ready && new URL(record.ready.appUrl).origin === origin) return platformWebappPartition(record.item.id); } catch { /* Untrusted URL. */ }
    return null;
  }
  private async monitor(app: App, record: Instance) {
    if (record.monitoring || record.stopping || !record.ready || record.state.status !== "running") return;
    record.monitoring = true;
    try {
      const health = await fetch(new URL("/healthz", record.ready.apiUrl), { redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!health.ok) throw new Error("Platform health check failed.");
      record.healthFailures = 0;
      await this.recycleIfIdle(app, record);
    } catch {
      record.healthFailures++;
      if (record.healthFailures < 3 || record.stopping || this.records.get(record.item.id) !== record) return;
      record.stopping = true;
      clearInterval(record.timer);
      const stopped = !record.child || await this.terminateChild(app, record);
      record.state = { ...record.state, status: "error", webUrl: "", message: "Independent Platform health check failed. See instance logs.", updatedAt: nowIso() };
      if (stopped) record.state.pid = null;
      writeState(app, record.state); this.changed(record.item.id);
      if (stopped && record.failures < 3) void this.queue(record.item.id, () => this.launch(app, record.item, record.failures + 1, record.generation));
    } finally { record.monitoring = false; }
  }
  private async recycleIfIdle(app: App, record: Instance) {
    try {
      const status = await this.ownerRequest(app, record, "/api/webapp/status");
      if (shouldRecyclePlatform(status, record.traffic) && this.records.get(record.item.id) === record) await this.stop(app, record.item);
    } catch { /* Failure to obtain authoritative activity never permits recycling. */ }
  }
  stop(app: App, item: WebappEntry) {
    this.generations.set(item.id, (this.generations.get(item.id) ?? 0) + 1);
    return this.queue(item.id, () => this.stopInstance(app, item));
  }
  private async terminateChild(app: App, record: Instance) {
    const child = record.child;
    if (!child?.pid) return true;
    // Platform backends use their own process groups. Capture all descendants
    // before asking the root to exit, then clean surviving groups explicitly.
    const captured = await listProcessTreePidsAsync(child.pid);
    record.capturedPids = [...new Set([...record.capturedPids, ...captured, child.pid])];
    fs.writeFileSync(webappPlatformLayout(app, record.item.id).processes, JSON.stringify({ schemaVersion: 1, pids: record.capturedPids }));
    if (process.platform === "darwin") {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(child.pid, "SIGTERM"); } catch { /* Already exited. */ }
        await waitForChildExit(child, 3000);
      }
      const stopped = await terminateCapturedProcessTreeAsync(child.pid, record.capturedPids, { platform: "darwin" });
      if (stopped) { record.capturedPids = []; fs.rmSync(webappPlatformLayout(app, record.item.id).processes, { force: true }); }
      return stopped;
    }
    if (process.platform === "win32") {
      const stopped = await terminateCapturedProcessTreeAsync(child.pid, record.capturedPids, { platform: "win32" });
      if (stopped) { record.capturedPids = []; fs.rmSync(webappPlatformLayout(app, record.item.id).processes, { force: true }); }
      return stopped;
    }
    throw new Error("Unsupported Desktop platform.");
  }
  private async stopInstance(app: App, item: WebappEntry): Promise<WebappCommandResult> {
    const record = this.records.get(item.id);
    if (record) {
      record.stopping = true; clearInterval(record.timer);
      if (record.child && !await this.terminateChild(app, record)) {
        record.state = { ...record.state, status: "error", webUrl: "", message: "Independent Platform process tree is still running.", updatedAt: nowIso() };
        writeState(app, record.state); this.changed(item.id);
        return { ok: false, item, state: record.state, message: record.state.message };
      }
      this.records.delete(item.id);
    }
    if (!record) {
      const stored = readStoredState(app, item);
      if (stored?.pid && isProcessRunning(stored.pid)) {
        if (await matchProcessInstallDirAsync(stored.pid, webappPlatformLayout(app, item.id).root) !== "matched") return { ok: false, item, state: stored, message: "Cannot verify independent Platform process ownership." };
        const pids = await listProcessTreePidsAsync(stored.pid);
        if (!await terminateCapturedProcessTreeAsync(stored.pid, pids)) return { ok: false, item, state: stored, message: "Independent Platform process tree is still running." };
      }
    }
    const remaining = readPlatformProcessSnapshot(app, item.id).filter(platformProcessIsAlive);
    for (const pid of remaining) {
      if (await matchProcessInstallDirAsync(pid, webappPlatformLayout(app, item.id).root) !== "matched") return { ok: false, item, state: record?.state ?? null, message: "Cannot verify remaining independent Platform process ownership." };
    }
    if (remaining.length && !await terminateCapturedProcessTreeAsync(remaining[0]!, remaining)) return { ok: false, item, state: record?.state ?? null, message: "Independent Platform descendants are still running." };
    fs.rmSync(webappPlatformLayout(app, item.id).processes, { force: true });
    const state = createStoppedState(item); writeState(app, state); this.changed(item.id);
    return { ok: true, item, state, message: state.message };
  }
}
