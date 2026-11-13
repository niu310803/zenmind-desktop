import path from "node:path";
import { processIdentityContainsPath } from "../../../infrastructure/process/process-path";
import { execFile } from "node:child_process";
import {
  buildServiceEnv
} from "./command-env";
import {
  IS_WINDOWS,
  windowsPowerShellPath
} from "./command-runner";

export type ProcessInstallDirMatch = "matched" | "mismatched" | "unknown";

function processIdentityMatchesInstallDir(identity: string, installDir: string) {
  return processIdentityContainsPath(identity, path.normalize(installDir), process.platform);
}

export async function pidMatchesInstallDir(pid: number, installDir: string) {
  return (await matchProcessInstallDirAsync(pid, installDir)) === "matched";
}

function readProcessCommandAsync(pid: number, executablePathOnly = false) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.resolve("");
  }
  const command = IS_WINDOWS
    ? windowsPowerShellPath()
    : "ps";
  const args = IS_WINDOWS
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        executablePathOnly
          ? `(Get-Process -Id ${pid} -ErrorAction Stop).Path`
          : `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
          "if ($null -ne $process) { @($process.ExecutablePath, $process.CommandLine) -join [Environment]::NewLine }"
      ]
    : ["-p", String(pid), "-o", "command="];
  return new Promise<string>((resolve) => {
    execFile(command, args, {
      encoding: "utf8",
      env: buildServiceEnv(),
      timeout: IS_WINDOWS ? (executablePathOnly ? 1500 : 3000) : 1500,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }, (error, stdout) => {
      resolve(error ? "" : String(stdout ?? "").trim());
    });
  });
}

async function probeProcessInstallDir(
  pid: number,
  installDir: string
): Promise<ProcessInstallDirMatch> {
  if (IS_WINDOWS) {
    // Script runtimes still need the command line fallback to prove their install root.
    const processPath = await readProcessCommandAsync(pid, true);
    if (processPath && processIdentityMatchesInstallDir(processPath, installDir)) return "matched";
    const command = await readProcessCommandAsync(pid);
    if (command && processIdentityMatchesInstallDir(command, installDir)) return "matched";
    return processPath || command ? "mismatched" : "unknown";
  }
  const identity = await readProcessCommandAsync(pid);
  if (!identity) {
    return "unknown";
  }
  return processIdentityMatchesInstallDir(identity, installDir)
    ? "matched"
    : "mismatched";
}

const pendingProcessProbes = new Map<string, Promise<ProcessInstallDirMatch>>();

export function matchProcessInstallDirAsync(pid: number, installDir: string) {
  const key = `${pid}\0${installDir}`;
  const pending = pendingProcessProbes.get(key);
  if (pending) {
    return pending;
  }
  const probe = probeProcessInstallDir(pid, installDir).finally(() => pendingProcessProbes.delete(key));
  pendingProcessProbes.set(key, probe);
  return probe;
}
