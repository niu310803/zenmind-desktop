import { performance } from "node:perf_hooks";

type SyncCommandTiming = {
  command: "powershell.exe";
  callSite: "readWindowsRuntimeRootFromRegistryUncached";
  durationMs: number;
  startedAt: string;
  endedAt: string;
};

let runtimeRootProbeTiming: SyncCommandTiming | undefined;

export function measureStartupSyncCommand<T>(
  command: SyncCommandTiming["command"],
  callSite: SyncCommandTiming["callSite"],
  task: () => T
): T {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    return task();
  } finally {
    runtimeRootProbeTiming = {
      command, callSite, startedAt, endedAt: new Date().toISOString(),
      durationMs: performance.now() - started
    };
  }
}

export function takeStartupSyncCommandTiming() {
  const timing = runtimeRootProbeTiming;
  runtimeRootProbeTiming = undefined;
  return timing;
}
