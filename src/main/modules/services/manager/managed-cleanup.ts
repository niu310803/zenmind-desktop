import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { App } from "electron";
import type { ServiceId } from "../../../../shared/contracts";
import type { ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { readEnvFile } from "../../../infrastructure/filesystem/env-file";
import { processIdentityContainsPath } from "../../../infrastructure/process/process-path";
import { getAllServices } from "../service-registry";
import {
  getInstallDir,
  getServiceLayout,
  type ServiceLayout
} from "./layout";
import {
  buildServiceEnv
} from "./command-env";
import {
  IS_WINDOWS,
  windowsPowerShellPath
} from "./command-runner";
import {
  isProcessRunning,
  listProcessTreePidsAsync,
  terminateProcess,
  terminateProcessTreeAsync,
  terminateCapturedProcessTreeAsync
} from "./process-cleanup";
import {
  buildProcessTreePids,
  type ProcessTreeRow
} from "./process-tree";
import {
  matchProcessInstallDirAsync,
  pidMatchesInstallDir
} from "./process-identity";
import {
  parsePort
} from "./service-network";
import {
  getManagedPidFilePaths,
  readPid,
  removePidFile,
  resolveRuntimePath,
  uniqueNonEmptyPaths
} from "./pid-files";

export type ManagedRootPid = {
  pid: number;
  serviceId: ServiceId;
  installDir?: string;
  pidFilePaths: string[];
};

export type ManagedProcessCleanupTarget = ManagedRootPid & {
  treePids: number[];
};

export type ManagedProcessCleanupTargets = {
  roots: ManagedRootPid[];
  stalePidFiles: Array<{ filePath: string; pid: number | null }>;
};

export type ManagedServiceStopState = {
  mainPidFilePath: string;
  managedMainPid: number | null;
  port: number;
  managedPortPids: number[];
};

export type ForceCleanupManagedProcessesOptions = {
  platform?: NodeJS.Platform | string;
  collectManagedProcessCleanupTargetsImpl?: (app: App) => ManagedProcessCleanupTargets | Promise<ManagedProcessCleanupTargets>;
  terminateCapturedProcessTreeImpl?: (
    rootPid: number,
    capturedPids: number[]
  ) => Promise<boolean>;
  listProcessTreePidsImpl?: (rootPid: number) => number[] | Promise<number[]>;
  isProcessRunningImpl?: (pid: number | null) => boolean;
  pidMatchesInstallDirImpl?: (pid: number, installDir: string) => boolean | Promise<boolean>;
  removePidFileImpl?: typeof removePidFile;
  consoleError?: (message: string) => void;
  maxConcurrency?: number;
};

export type ForceCleanupManagedProcessesResult = {
  ok: boolean;
  failures: Array<{
    serviceId: ServiceId;
    rootPid: number;
    pids: number[];
  }>;
  survivors: number[];
};

function readListeningPorts(command: string, args: string[]) {
  return new Promise<string>((resolve) => {
    execFile(command, args, {
      encoding: "utf8",
      env: buildServiceEnv(),
      timeout: 1500,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    }, (error, stdout) => resolve(error ? "" : stdout));
  });
}

async function readWindowsListeningPidsByPort() {
  const stdout = await readListeningPorts("netstat", ["-ano", "-p", "tcp"]);
  const listeners = new Map<number, Set<number>>();
  for (const line of stdout.split(/\r?\n/u)) {
    const [protocol, localAddress, , state, pidText] = line.trim().split(/\s+/u);
    if (protocol !== "TCP" || state?.toUpperCase() !== "LISTENING") {
      continue;
    }
    const port = Number.parseInt(localAddress.split(":").at(-1) ?? "", 10);
    const pid = Number.parseInt(pidText ?? "", 10);
    if (port <= 0 || !Number.isFinite(port) || pid <= 0 || !Number.isFinite(pid)) {
      continue;
    }
    const pids = listeners.get(port) ?? new Set<number>();
    pids.add(pid);
    listeners.set(port, pids);
  }
  return listeners;
}

let pendingWindowsListeningPids: ReturnType<typeof readWindowsListeningPidsByPort> | undefined;

export function createStartupProbeSnapshot() {
  if (process.platform !== "win32") {
    return undefined;
  }
  let snapshot: ReturnType<typeof readWindowsListeningPidsByPort> | undefined;
  return {
    async listListeningPids(port: number) {
      snapshot ??= readWindowsListeningPidsByPort();
      return [...((await snapshot).get(port) ?? [])];
    },
    invalidate() {
      snapshot = undefined;
    }
  };
}

export async function listListeningPids(port: number) {
  if (!Number.isFinite(port) || port <= 0) {
    return [];
  }
  if (process.platform === "win32") {
    // Concurrent service checks share one inventory. Later checks see a fresh snapshot.
    pendingWindowsListeningPids ??= readWindowsListeningPidsByPort().finally(() => {
      pendingWindowsListeningPids = undefined;
    });
    const listeners = await pendingWindowsListeningPids;
    return [...(listeners.get(port) ?? [])];
  }

  const stdout = await readListeningPorts("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  return [...new Set(
    stdout.split(/\r?\n/u)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isFinite(pid))
  )];
}

export async function findManagedServicePid(installDir: string, listeningPids: number[]) {
  for (const pid of listeningPids) {
    if (await pidMatchesInstallDir(pid, installDir)) {
      return pid;
    }
  }
  return null;
}

function addManagedRootPid(
  roots: Map<number, ManagedRootPid>,
  serviceId: ServiceId,
  pid: number | null,
  installDir: string,
  pidFilePath = ""
) {
  if (!pid) {
    return;
  }

  const existing = roots.get(pid);
  if (existing) {
    if (pidFilePath) {
      existing.pidFilePaths = uniqueNonEmptyPaths([...existing.pidFilePaths, pidFilePath]);
    }
    return;
  }

  roots.set(pid, {
    pid,
    serviceId,
    installDir,
    pidFilePaths: pidFilePath ? [pidFilePath] : []
  });
}

export async function collectManagedProcessCleanupTargets(app: App): Promise<ManagedProcessCleanupTargets> {
  const roots = new Map<number, ManagedRootPid>();
  const stalePidFiles = new Map<string, number | null>();

  for (const service of getAllServices()) {
    const installDir = getInstallDir(app, service);
    const layout = getServiceLayout(app, service);
    if (!fs.existsSync(installDir)) {
      continue;
    }

    for (const pidFilePath of getManagedPidFilePaths(service, layout)) {
      const pid = readPid(pidFilePath);
      if (!pid) {
        if (fs.existsSync(pidFilePath)) {
          stalePidFiles.set(pidFilePath, pid);
        }
        continue;
      }
      if (!isProcessRunning(pid)) {
        stalePidFiles.set(pidFilePath, pid);
        continue;
      }
      const match = await matchProcessInstallDirAsync(pid, installDir);
      if (readPid(pidFilePath) !== pid) {
        continue;
      }
      if (match === "mismatched") {
        stalePidFiles.set(pidFilePath, pid);
        continue;
      }
      if (match === "unknown") {
        continue;
      }
      addManagedRootPid(roots, service.id, pid, installDir, pidFilePath);
    }

    const envPath = layout.envPath;
    const env = fs.existsSync(envPath) ? readEnvFile(envPath) : new Map<string, string>();
    const port = parsePort(service, env);
    if (port > 0) {
      for (const pid of await listListeningPids(port)) {
        if (await pidMatchesInstallDir(pid, installDir)) {
          addManagedRootPid(roots, service.id, pid, installDir);
        }
      }
    }
  }

  return {
    roots: [...roots.values()],
    stalePidFiles: [...stalePidFiles].map(([filePath, pid]) => ({ filePath, pid }))
  };
}

export async function collectManagedRootPids(app: App) {
  return (await collectManagedProcessCleanupTargets(app)).roots;
}

type ManagedProcessInventoryRow = ProcessTreeRow & {
  identity: string;
};

function runInventoryCommand(command: string, args: string[], timeoutMs: number) {
  const startedAt = Date.now();
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, {
      encoding: "utf8",
      env: buildServiceEnv(),
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        // Never include stdout: it contains other processes' command lines.
        reject(new Error(`Process inventory failed: elapsedMs=${Date.now() - startedAt} timeoutMs=${timeoutMs} ` +
          `killed=${Boolean(error.killed)} signal=${error.signal ?? "none"} code=${error.code ?? "none"}; ` +
          String(stderr || error.message || "process inventory failed").trim()));
        return;
      }
      resolve(String(stdout ?? ""));
    });
  });
}

function parseWindowsManagedProcessInventory(stdout: string): ManagedProcessInventoryRow[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Empty Windows process inventory");
  }
  const parsed = JSON.parse(trimmed) as unknown;
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length === 0) throw new Error("Empty Windows process inventory");
  return entries.flatMap((entry) => {
    const value = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const pid = value.ProcessId;
    const ppid = value.ParentProcessId;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 0 ||
        typeof ppid !== "number" || !Number.isInteger(ppid) || ppid < 0) throw new Error("Invalid Windows process inventory row");
    if (pid === 0) return []; // Windows System Idle Process is not a killable root.
    return [{
      pid,
      ppid,
      identity: [value.ExecutablePath, value.CommandLine]
        .filter((item): item is string => typeof item === "string")
        .join("\n")
    }];
  });
}

function parsePosixManagedProcessInventory(stdout: string): ManagedProcessInventoryRow[] {
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u);
    if (!match) {
      return [];
    }
    return [{
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      identity: match[3]
    }];
  });
}

function inventoryIdentityMatchesInstallDir(
  identity: string,
  installDir: string,
  platform: NodeJS.Platform | string
) {
  return processIdentityContainsPath(identity, path.normalize(installDir), platform);
}

export async function captureManagedProcessCleanupSnapshotAsync(
  app: App,
  platform: NodeJS.Platform | string = process.platform,
  options: { timeoutMs?: number } = {}
) {
  const timeoutMs = options.timeoutMs ?? (platform === "win32" ? 3500 : 3000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) throw new Error("Invalid process inventory timeout");
  const inventory = platform === "win32"
    ? parseWindowsManagedProcessInventory(await runInventoryCommand(
        windowsPowerShellPath(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | " +
            "Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
        ],
        timeoutMs
      ))
    : parsePosixManagedProcessInventory(await runInventoryCommand(
        "ps",
        ["-axo", "pid=,ppid=,command="],
        timeoutMs
      ));
  const rows: ProcessTreeRow[] = inventory.map(({ pid, ppid }) => ({ pid, ppid }));
  const targets: ManagedProcessCleanupTarget[] = [];

  for (const service of getAllServices()) {
    const installDir = getInstallDir(app, service);
    if (!fs.existsSync(installDir)) {
      continue;
    }
    const matchedRows = inventory.filter((row) =>
      inventoryIdentityMatchesInstallDir(row.identity, installDir, platform)
    );
    const matchedPids = new Set(matchedRows.map((row) => row.pid));
    for (const root of matchedRows.filter((row) => !matchedPids.has(row.ppid))) {
      const layout = getServiceLayout(app, service);
      const pidFilePaths = getManagedPidFilePaths(service, layout)
        .filter((pidFilePath) => readPid(pidFilePath) === root.pid);
      targets.push({
        pid: root.pid,
        serviceId: service.id,
        installDir,
        pidFilePaths,
        treePids: buildProcessTreePids(root.pid, rows)
      });
    }
  }

  return targets;
}

export function mergeCleanupTargets(targets: ManagedProcessCleanupTarget[], roots: ManagedRootPid[]) {
  const merged = new Map<number, ManagedProcessCleanupTarget>();

  for (const target of targets) {
    merged.set(target.pid, {
      ...target,
      pidFilePaths: [...target.pidFilePaths],
      treePids: [...target.treePids]
    });
  }

  for (const root of roots) {
    const existing = merged.get(root.pid);
    if (existing) {
      existing.installDir = existing.installDir ?? root.installDir;
      existing.pidFilePaths = uniqueNonEmptyPaths([...existing.pidFilePaths, ...root.pidFilePaths]);
      continue;
    }

    merged.set(root.pid, {
      ...root,
      pidFilePaths: [...root.pidFilePaths],
      treePids: []
    });
  }

  return [...merged.values()];
}

async function buildCleanupTreePids(
  root: ManagedProcessCleanupTarget,
  listProcessTreePidsImpl: NonNullable<ForceCleanupManagedProcessesOptions["listProcessTreePidsImpl"]>
) {
  const pids = [...await listProcessTreePidsImpl(root.pid), ...root.treePids]
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== root.pid);
  return [...new Set([...pids, root.pid])];
}

async function shouldRemoveManagedPidFile(
  root: ManagedProcessCleanupTarget,
  isProcessRunningImpl: (pid: number | null) => boolean,
  pidMatchesInstallDirImpl: NonNullable<ForceCleanupManagedProcessesOptions["pidMatchesInstallDirImpl"]>
) {
  if (!isProcessRunningImpl(root.pid)) {
    return true;
  }
  if (root.installDir && !await pidMatchesInstallDirImpl(root.pid, root.installDir)) {
    return true;
  }
  return false;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  maxConcurrency: number,
  task: (item: T) => Promise<R>
) {
  if (items.length === 0) {
    return [] as R[];
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(maxConcurrency))
  );
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await task(items[index]);
      }
    })
  );
  return results;
}

export async function forceCleanupManagedProcesses(
  app: App,
  snapshot: ManagedProcessCleanupTarget[] = [],
  options: ForceCleanupManagedProcessesOptions = {}
) {
  const collectManagedProcessCleanupTargetsImpl =
    options.collectManagedProcessCleanupTargetsImpl ?? collectManagedProcessCleanupTargets;
  const isProcessRunningImpl = options.isProcessRunningImpl ?? isProcessRunning;
  const pidMatchesInstallDirImpl = options.pidMatchesInstallDirImpl ?? pidMatchesInstallDir;
  const removePidFileImpl = options.removePidFileImpl ?? removePidFile;
  const consoleError = options.consoleError ?? console.error;
  const platform = options.platform ?? process.platform;
  const listProcessTreePidsImpl = options.listProcessTreePidsImpl ??
    ((pid: number) => listProcessTreePidsAsync(pid, platform).catch(() => []));
  const maxConcurrency = options.maxConcurrency ?? 8;
  const collected = await collectManagedProcessCleanupTargetsImpl(app);
  const roots = mergeCleanupTargets(snapshot, collected.roots);
  const failureMessages: string[] = [];
  const cleanupFailures: ForceCleanupManagedProcessesResult["failures"] = [];
  const survivors = new Set<number>();

  for (const { filePath, pid } of collected.stalePidFiles) {
    if (readPid(filePath) === pid) {
      removePidFileImpl(filePath);
    }
  }

  const rootResults = await mapWithConcurrency(roots, maxConcurrency, async (root) => {
    const treePids = await buildCleanupTreePids(root, listProcessTreePidsImpl);
    if (root.installDir && isProcessRunningImpl(root.pid) && !await pidMatchesInstallDirImpl(root.pid, root.installDir)) {
      // A live PID with uncertain ownership is never a target for force cleanup.
      return { root, remainingPids: treePids.filter((pid) => isProcessRunningImpl(pid)) };
    }
    let terminated = false;
    try {
      terminated = options.terminateCapturedProcessTreeImpl
        ? await options.terminateCapturedProcessTreeImpl(root.pid, treePids)
        : await terminateCapturedProcessTreeAsync(root.pid, treePids, { platform, isProcessRunningImpl });
    } catch (error) {
      consoleError(
        `failed to terminate managed process tree for ${root.serviceId}: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (terminated || await shouldRemoveManagedPidFile(root, isProcessRunningImpl, pidMatchesInstallDirImpl)) {
      for (const pidFilePath of root.pidFilePaths) {
        const currentPid = readPid(pidFilePath);
        if (currentPid === root.pid || currentPid === null) {
          removePidFileImpl(pidFilePath);
        }
      }
    }

    const remainingPids = treePids.filter((pid) => isProcessRunningImpl(pid));
    return { root, remainingPids };
  });

  for (const { root, remainingPids } of rootResults) {
    if (remainingPids.length > 0) {
      remainingPids.forEach((pid) => survivors.add(pid));
      cleanupFailures.push({
        serviceId: root.serviceId,
        rootPid: root.pid,
        pids: remainingPids
      });
      failureMessages.push(`${root.serviceId}: PID ${remainingPids.join(", ")}`);
    }
  }

  if (failureMessages.length > 0) {
    consoleError(`failed to force-clean managed service processes: ${failureMessages.join("; ")}`);
  }

  return {
    ok: cleanupFailures.length === 0,
    failures: cleanupFailures,
    survivors: [...survivors].sort((left, right) => left - right)
  };
}

export async function collectManagedServiceStopState(
  service: ServiceDefinition,
  layoutOrInstallDir: ServiceLayout | string,
  env: Map<string, string>
): Promise<ManagedServiceStopState> {
  const installDir = typeof layoutOrInstallDir === "string" ? layoutOrInstallDir : layoutOrInstallDir.programDir;
  const mainPidFilePath = resolveRuntimePath(layoutOrInstallDir, service.runtime.pidRelativePath);
  const mainPid = readPid(mainPidFilePath);
  const port = parsePort(service, env);
  const [matchedMainPid, listeningPids] = await Promise.all([
    mainPid && isProcessRunning(mainPid) ? pidMatchesInstallDir(mainPid, installDir) : false,
    listListeningPids(port)
  ]);
  const managedMainPid = matchedMainPid && readPid(mainPidFilePath) === mainPid && isProcessRunning(mainPid)
    ? mainPid
    : null;
  const managedPortPids: number[] = [];
  for (const pid of listeningPids) {
    if (pid === managedMainPid || await pidMatchesInstallDir(pid, installDir)) {
      managedPortPids.push(pid);
    }
  }

  return {
    mainPidFilePath,
    managedMainPid,
    port,
    managedPortPids
  };
}

function buildManagedServiceStopIssues(
  _service: ServiceDefinition,
  state: ManagedServiceStopState,
  phase: "stop" | "cleanup"
) {
  const issues: string[] = [];

  if (phase === "stop" && state.managedMainPid) {
    issues.push(`stop script returned but process still alive (pid=${state.managedMainPid})`);
  }
  if (phase === "cleanup" && state.managedMainPid) {
    issues.push(`managed process still alive after cleanup (pid=${state.managedMainPid})`);
  }
  if (state.port > 0 && state.managedPortPids.length > 0) {
    issues.push(`port ${state.port} still occupied by managed process after ${phase}`);
  }

  return issues;
}

export async function forceStopServiceInstallDir(
  service: ServiceDefinition,
  layoutOrInstallDir: ServiceLayout | string,
  env: Map<string, string>,
  options: {
    isWindows?: boolean;
    collectState?: (...args: Parameters<typeof collectManagedServiceStopState>) => ManagedServiceStopState | Promise<ManagedServiceStopState>;
    terminateProcessImpl?: typeof terminateProcess;
    terminateProcessTreeImpl?: (pid: number) => boolean | Promise<boolean>;
    removePidFileImpl?: typeof removePidFile;
  } = {}
) {
  const isWindows = options.isWindows ?? IS_WINDOWS;
  const collectState = options.collectState ?? collectManagedServiceStopState;
  const installDir = typeof layoutOrInstallDir === "string" ? layoutOrInstallDir : layoutOrInstallDir.programDir;
  const verifyProcess = (pid: number) => pidMatchesInstallDir(pid, installDir);
  const terminateProcessImpl = options.terminateProcessImpl ?? (async (pid: number) => {
    if (isProcessRunning(pid) && !await verifyProcess(pid)) return false;
    return terminateProcess(pid, verifyProcess);
  });
  const terminateProcessTreeImpl = options.terminateProcessTreeImpl ??
    ((pid: number) => terminateProcessTreeAsync(pid, "win32", verifyProcess));
  const removePidFileImpl = options.removePidFileImpl ?? removePidFile;
  const state = await collectState(service, layoutOrInstallDir, env);
  const pidsToTerminate = [
    state.managedMainPid,
    ...state.managedPortPids
  ].filter((pid): pid is number => typeof pid === "number" && Number.isFinite(pid) && pid > 0);
  let allTerminated = true;

  for (const pid of [...new Set(pidsToTerminate)]) {
    const terminated = await (isWindows ? terminateProcessTreeImpl(pid) : terminateProcessImpl(pid));
    allTerminated = terminated && allTerminated;
  }

  if (allTerminated && state.managedMainPid && state.mainPidFilePath) {
    const currentPid = readPid(state.mainPidFilePath);
    if (currentPid === state.managedMainPid || currentPid === null) {
      removePidFileImpl(state.mainPidFilePath);
    }
  }

  return allTerminated;
}

export async function ensureManagedServiceStoppedForPlatform(
  service: ServiceDefinition,
  layoutOrInstallDir: ServiceLayout | string,
  env: Map<string, string>,
  options: {
    isWindows?: boolean;
    collectState?: (...args: Parameters<typeof collectManagedServiceStopState>) => ManagedServiceStopState | Promise<ManagedServiceStopState>;
    forceStop?: (...args: Parameters<typeof forceStopServiceInstallDir>) => boolean | Promise<boolean>;
  } = {}
) {
  const isWindows = options.isWindows ?? IS_WINDOWS;
  if (!isWindows) {
    return {
      ok: true,
      forcedCleanup: false,
      message: ""
    };
  }

  const collectState = options.collectState ?? collectManagedServiceStopState;
  const forceStop = options.forceStop ?? forceStopServiceInstallDir;
  const afterStopState = await collectState(service, layoutOrInstallDir, env);
  const stopIssues = buildManagedServiceStopIssues(service, afterStopState, "stop");
  if (stopIssues.length === 0) {
    return {
      ok: true,
      forcedCleanup: false,
      message: ""
    };
  }

  const terminated = await forceStop(service, layoutOrInstallDir, env);
  const afterCleanupState = await collectState(service, layoutOrInstallDir, env);
  const cleanupIssues = buildManagedServiceStopIssues(service, afterCleanupState, "cleanup");
  if (!terminated && cleanupIssues.length === 0) {
    cleanupIssues.push(...stopIssues);
  }
  if (cleanupIssues.length === 0) {
    return {
      ok: true,
      forcedCleanup: true,
      message: stopIssues.join("; ")
    };
  }

  return {
    ok: false,
    forcedCleanup: true,
    message: cleanupIssues.join("; ")
  };
}
