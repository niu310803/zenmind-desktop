import { execFile } from "node:child_process";
import {
  buildServiceEnv
} from "./command-env";
import {
  windowsPowerShellPath
} from "./command-runner";
import {
  buildProcessTreePids,
  parseProcessTreeRowsFromPs,
  parseProcessTreeRowsFromWindowsPowerShell
} from "./process-tree";

export function isProcessRunning(pid: number | null) {
  if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function execFileAsync(
  command: string,
  args: string[],
  options: {
    timeout: number;
  }
) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile(command, args, {
      encoding: "utf8",
      env: buildServiceEnv(),
      timeout: options.timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    }, (error, stdout, stderr) => {
      const status = typeof (error as NodeJS.ErrnoException & { code?: number } | null)?.code === "number"
        ? (error as NodeJS.ErrnoException & { code: number }).code
        : error
          ? 1
          : 0;
      resolve({
        status,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "")
      });
    });
  });
}

async function readProcessTreeRowsAsync(platform: NodeJS.Platform | string = process.platform) {
  if (platform === "win32") {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId | ConvertTo-Json -Compress"
    ].join("; ");
    const result = await execFileAsync(
      windowsPowerShellPath(),
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { timeout: 3000 }
    );
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || "Windows process snapshot failed.");
    }
    return parseProcessTreeRowsFromWindowsPowerShell(result.stdout);
  }

  const result = await execFileAsync("ps", ["-axo", "pid=,ppid="], { timeout: 3000 });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Process snapshot failed.");
  }
  return parseProcessTreeRowsFromPs(result.stdout);
}

export async function listProcessTreePidsAsync(
  rootPid: number,
  platform: NodeJS.Platform | string = process.platform
) {
  return buildProcessTreePids(rootPid, await readProcessTreeRowsAsync(platform));
}

export async function terminateProcessTreeAsync(
  rootPid: number,
  platform: NodeJS.Platform | string = process.platform,
  verifyRoot?: (pid: number) => boolean | Promise<boolean>
) {
  if (!isProcessRunning(rootPid)) {
    return true;
  }
  const capturedPids = await listProcessTreePidsAsync(rootPid, platform).catch(() => [rootPid]);
  if (verifyRoot && (!await verifyRoot(rootPid) || !isProcessRunning(rootPid))) {
    return !isProcessRunning(rootPid) && capturedPids.every((pid) => !isProcessRunning(pid));
  }
  return terminateCapturedProcessTreeAsync(rootPid, capturedPids, { platform });
}

export async function terminateProcess(pid: number, verifyProcess?: (pid: number) => boolean | Promise<boolean>) {
  if (!isProcessRunning(pid)) {
    return true;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isProcessRunning(pid);
  }

  if (await waitForProcessesExitAsync([pid], 2500, isProcessRunning)) {
    return true;
  }

  if (verifyProcess && !await verifyProcess(pid)) {
    return !isProcessRunning(pid);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return !isProcessRunning(pid);
  }

  return waitForProcessesExitAsync([pid], 1000, isProcessRunning);
}

function signalProcessList(pids: number[], signal: NodeJS.Signals) {
  for (const pid of pids) {
    if (!isProcessRunning(pid)) {
      continue;
    }
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between the liveness check and signal delivery.
    }
  }
}

async function waitForProcessesExitAsync(
  pids: number[],
  timeoutMs: number,
  isProcessRunningImpl: (pid: number | null) => boolean
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessRunningImpl(pid))) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return pids.every((pid) => !isProcessRunningImpl(pid));
}

export async function requestWindowsProcessTreeExitAsync(
  rootPid: number,
  capturedPids: number[],
  options: {
    platform?: NodeJS.Platform | string;
    isProcessRunningImpl?: (pid: number | null) => boolean;
    runCommandImpl?: typeof execFileAsync;
    timeoutMs?: number;
  } = {}
) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return false;
  }
  const isProcessRunningImpl = options.isProcessRunningImpl ?? isProcessRunning;
  const runCommandImpl = options.runCommandImpl ?? execFileAsync;
  const pids = [...new Set([...capturedPids, rootPid])]
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (pids.every((pid) => !isProcessRunningImpl(pid))) {
    return true;
  }

  await runCommandImpl(
    "taskkill.exe",
    ["/PID", String(rootPid), "/T"],
    { timeout: 1_000 }
  );
  return waitForProcessesExitAsync(
    pids,
    options.timeoutMs ?? 1_000,
    isProcessRunningImpl
  );
}

export async function terminateCapturedProcessTreeAsync(
  rootPid: number,
  capturedPids: number[],
  options: {
    platform?: NodeJS.Platform | string;
    isProcessRunningImpl?: (pid: number | null) => boolean;
    runCommandImpl?: typeof execFileAsync;
  } = {}
) {
  const platform = options.platform ?? process.platform;
  const isProcessRunningImpl = options.isProcessRunningImpl ?? isProcessRunning;
  const pids = [...new Set([...capturedPids, rootPid])]
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (pids.every((pid) => !isProcessRunningImpl(pid))) {
    return true;
  }

  if (platform === "win32") {
    const runCommandImpl = options.runCommandImpl ?? execFileAsync;
    if (isProcessRunningImpl(rootPid)) {
      await runCommandImpl(
        "taskkill.exe",
        ["/PID", String(rootPid), "/T", "/F"],
        { timeout: 2000 }
      );
      if (await waitForProcessesExitAsync(pids, 800, isProcessRunningImpl)) {
        return true;
      }
    }
    const remaining = pids.filter((pid) => isProcessRunningImpl(pid));
    await Promise.all(
      remaining.map((pid) =>
        runCommandImpl("taskkill.exe", ["/PID", String(pid), "/F"], { timeout: 1000 })
      )
    );
    return waitForProcessesExitAsync(pids, 700, isProcessRunningImpl);
  }

  signalProcessList(pids, "SIGTERM");
  if (await waitForProcessesExitAsync(pids, 2000, isProcessRunningImpl)) {
    return true;
  }
  signalProcessList(pids, "SIGKILL");
  return waitForProcessesExitAsync(pids, 1000, isProcessRunningImpl);
}
