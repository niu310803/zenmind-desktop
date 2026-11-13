import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { App } from "electron";
import { getPluginsRoot, getProgramsRoot } from "../../infrastructure/filesystem/user-paths";
import { processIdentityContainsPath } from "../../infrastructure/process/process-path";
import { buildServiceEnv } from "../../modules/services";
import { terminateProcessTreeAsync } from "../../modules/services";
import { windowsPowerShellPath } from "../../modules/services";

export const PROGRAM_DATA_VERSION_FILE = "VERSION";

type ProcessInfo = {
  pid: number;
  identity: string;
};

type CleanupFailure = {
  path: string;
  message: string;
};

type CleanupOptions = {
  platform?: NodeJS.Platform;
  terminateProcessTreeImpl?: typeof terminateProcessTreeAsync;
  listProcessesImpl?: (platform: NodeJS.Platform) => ProcessInfo[] | Promise<ProcessInfo[]>;
};

export type ProgramDataVersionCleanupResult = {
  programRoot: string;
  pluginsRoot: string;
  versionPath: string;
  currentVersion: string;
  previousVersion: string;
  cleaned: boolean;
  skipped: boolean;
  removedPaths: string[];
  failedPaths: CleanupFailure[];
  stoppedPids: number[];
};

function pathApiForPlatform(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function namesEqual(left: string, right: string, platform: NodeJS.Platform) {
  return platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function normalizeProgramDataVersion(value: unknown) {
  const version = String(value ?? "").trim().replace(/^v/iu, "");
  return version ? `v${version}` : "";
}

function readProgramDataVersion(versionPath: string) {
  try {
    return normalizeProgramDataVersion(fs.readFileSync(versionPath, "utf8"));
  } catch {
    return "";
  }
}

function isPreservedProgramDataEntry(entry: fs.Dirent, platform: NodeJS.Platform) {
  // Windows Electron holds this single-instance lock before profile relocation.
  // It is process-owned, not a replaceable service asset.
  if (platform === "win32" && namesEqual(entry.name, "lockfile", platform) && entry.isFile()) {
    return true;
  }
  if (namesEqual(entry.name, "plugins", platform)) {
    return true;
  }
  if (namesEqual(entry.name, PROGRAM_DATA_VERSION_FILE, platform) && !entry.isDirectory()) {
    return true;
  }
  return false;
}

export function listProgramDataRemovalTargets(
  programRoot: string,
  platform: NodeJS.Platform = process.platform
) {
  if (!fs.existsSync(programRoot)) {
    return [];
  }

  return fs
    .readdirSync(programRoot, { withFileTypes: true })
    .filter((entry) => !isPreservedProgramDataEntry(entry, platform))
    .map((entry) => path.join(programRoot, entry.name));
}

function parsePosixProcesses(output: string): ProcessInfo[] {
  return output
    .split(/\r?\n/u)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+([\s\S]*)$/u);
      if (!match) {
        return null;
      }
      return {
        pid: Number.parseInt(match[1], 10),
        identity: match[2].trim()
      };
    })
    .filter((item): item is ProcessInfo => Boolean(item && item.pid > 0 && item.identity));
}

function parseWindowsProcesses(output: string): ProcessInfo[] {
  if (!output.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(output) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records
      .map((record) => {
        if (!record || typeof record !== "object") {
          return null;
        }
        const item = record as Record<string, unknown>;
        const pid = typeof item.ProcessId === "number"
          ? item.ProcessId
          : Number.parseInt(String(item.ProcessId ?? ""), 10);
        const identity = [
          typeof item.ExecutablePath === "string" ? item.ExecutablePath : "",
          typeof item.CommandLine === "string" ? item.CommandLine : ""
        ].filter(Boolean).join("\n");
        return { pid, identity };
      })
      .filter((item): item is ProcessInfo => Boolean(item && item.pid > 0 && item.identity));
  } catch {
    return [];
  }
}

function readProcessList(command: string, args: string[], timeout: number) {
  return new Promise<string>((resolve) => {
    execFile(command, args, {
      encoding: "utf8",
      env: buildServiceEnv(),
      timeout,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    }, (error, stdout) => resolve(error ? "" : stdout));
  });
}

async function listProcesses(platform: NodeJS.Platform): Promise<ProcessInfo[]> {
  if (platform === "win32") {
    const command = "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | " +
      "Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress";
    return parseWindowsProcesses(await readProcessList(
      windowsPowerShellPath(),
      ["-NoProfile", "-NonInteractive", "-Command", command],
      5000
    ));
  }
  return parsePosixProcesses(await readProcessList("ps", ["-axo", "pid=,command="], 3000));
}

function processIdentityMatchesRoot(identity: string, root: string, platform: NodeJS.Platform) {
  return processIdentityContainsPath(identity, pathApiForPlatform(platform).normalize(root), platform);
}

async function stopProcessesUnderRoots(
  roots: string[],
  options: Required<CleanupOptions>
) {
  const processes = await options.listProcessesImpl(options.platform);
  const pids = processes
    .filter((processInfo) =>
      processInfo.pid !== process.pid &&
      roots.some((root) => processIdentityMatchesRoot(processInfo.identity, root, options.platform))
    )
    .map((processInfo) => processInfo.pid);

  const stoppedPids: number[] = [];
  const failedPids: number[] = [];
  const verifyRoot = async (pid: number) => {
    const current = (await options.listProcessesImpl(options.platform)).find((candidate) => candidate.pid === pid);
    return Boolean(current && roots.some((root) => processIdentityMatchesRoot(current.identity, root, options.platform)));
  };
  for (const pid of [...new Set(pids)]) {
    if (await options.terminateProcessTreeImpl(pid, options.platform, verifyRoot)) {
      stoppedPids.push(pid);
    } else {
      failedPids.push(pid);
    }
  }
  return { stoppedPids, failedPids };
}

async function removeProgramDataTargets(targets: string[]) {
  const removedPaths: string[] = [];
  const failedPaths: CleanupFailure[] = [];

  for (const targetPath of targets) {
    try {
      await fs.promises.rm(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removedPaths.push(targetPath);
    } catch (error) {
      failedPaths.push({
        path: targetPath,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { removedPaths, failedPaths };
}

export async function cleanupProgramDataForVersion(
  app: App,
  currentVersion: string,
  options: CleanupOptions = {}
): Promise<ProgramDataVersionCleanupResult> {
  const platform = options.platform ?? process.platform;
  const terminateProcessTreeImpl = options.terminateProcessTreeImpl ?? terminateProcessTreeAsync;
  const listProcessesImpl = options.listProcessesImpl ?? listProcesses;
  const programRoot = getProgramsRoot(app);
  const pluginsRoot = getPluginsRoot(app);
  const versionPath = path.join(programRoot, PROGRAM_DATA_VERSION_FILE);
  const normalizedCurrentVersion = normalizeProgramDataVersion(currentVersion);
  const previousVersion = readProgramDataVersion(versionPath);

  fs.mkdirSync(pluginsRoot, { recursive: true });

  const baseResult = {
    programRoot,
    pluginsRoot,
    versionPath,
    currentVersion: normalizedCurrentVersion,
    previousVersion,
    removedPaths: [] as string[],
    failedPaths: [] as CleanupFailure[],
    stoppedPids: [] as number[]
  };

  if (!normalizedCurrentVersion) {
    return {
      ...baseResult,
      cleaned: false,
      skipped: true,
      failedPaths: [{ path: versionPath, message: "current version is empty" }]
    };
  }

  if (previousVersion === normalizedCurrentVersion) {
    return {
      ...baseResult,
      cleaned: false,
      skipped: true
    };
  }

  const removalTargets = listProgramDataRemovalTargets(programRoot, platform);
  const { stoppedPids, failedPids } = removalTargets.length > 0
    ? await stopProcessesUnderRoots(removalTargets, {
      platform,
      terminateProcessTreeImpl,
      listProcessesImpl
    })
    : { stoppedPids: [], failedPids: [] };
  if (failedPids.length > 0) {
    return {
      ...baseResult,
      stoppedPids,
      cleaned: false,
      skipped: false,
      failedPaths: [{ path: programRoot, message: `Could not stop process(es): ${failedPids.join(", ")}` }]
    };
  }
  const { removedPaths, failedPaths } = await removeProgramDataTargets(removalTargets);

  if (failedPaths.length === 0) {
    try {
      fs.writeFileSync(versionPath, `${normalizedCurrentVersion}\n`, "utf8");
    } catch (error) {
      failedPaths.push({
        path: versionPath,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    ...baseResult,
    cleaned: failedPaths.length === 0,
    skipped: false,
    removedPaths,
    failedPaths,
    stoppedPids
  };
}

export const __testInternals = {
  listProgramDataRemovalTargets,
  normalizeProgramDataVersion,
  parsePosixProcesses,
  parseWindowsProcesses
};
