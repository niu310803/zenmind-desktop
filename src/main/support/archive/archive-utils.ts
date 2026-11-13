import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import packageValidation = require("./package-safety.js");
import { beginStartupTiming } from "../logging/startup-timing";
import { windowsPowerShellPath } from "../../infrastructure/process/windows-powershell";
import { listZipEntries, readZipEntryText } from "./zip-reader";

const {
  WEBAPP_PACKAGE_LIMITS,
  validateZipEntrySafety
} = packageValidation;

export function isZipArchive(archivePath: string) {
  return archivePath.toLowerCase().endsWith(".zip");
}

function isTarArchive(archivePath: string) {
  const normalized = archivePath.toLowerCase();
  return normalized.endsWith(".tar.gz") || normalized.endsWith(".tgz");
}

function ensureSupportedArchive(archivePath: string) {
  if (isZipArchive(archivePath)) {
    return "zip" as const;
  }

  if (isTarArchive(archivePath)) {
    return "tar" as const;
  }

  throw new Error(`unsupported archive format: ${archivePath}`);
}

function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

const ARCHIVE_TIMEOUT_MS = 300_000;
// PortableGit bundle listings exceed Node's default 1 MiB stdout limit.
const ARCHIVE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
function tarCommand() {
  if (process.platform === "win32") {
    return "tar.exe";
  }
  if (process.platform === "darwin") {
    return "tar";
  }
  return "tar";
}

function runArchiveCommand(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", windowsHide: true, timeout: ARCHIVE_TIMEOUT_MS, maxBuffer: ARCHIVE_MAX_BUFFER_BYTES },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout || "");
        }
      }
    );
  });
}

function runPowerShell(script: string) {
  return runArchiveCommand(windowsPowerShellPath(), [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    "$ErrorActionPreference = 'Stop';\n" + script
  ]);
}

function unsafeArchiveEntryPath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  return normalized === "" ||
    normalized.startsWith("/") ||
    normalized.includes("../") ||
    normalized === ".." ||
    /^[A-Za-z]:\//u.test(normalized);
}

function resolveSafeArchiveTarget(rootDir: string, entryName: string) {
  const normalized = entryName.trim().replace(/\\/g, "/");
  if (unsafeArchiveEntryPath(normalized)) {
    throw new Error(`archive contains unsafe path: ${entryName}`);
  }
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...normalized.split("/").filter(Boolean));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`archive entry escapes target directory: ${entryName}`);
  }
  return target;
}

export async function inspectZipArchiveSafety(
  archivePath: string,
  limits: {
    maxArchiveBytes?: number;
    maxExpandedBytes?: number;
    maxFileBytes?: number;
    maxEntries?: number;
    maxCompressionRatio?: number;
  } = {}
) {
  if (!isZipArchive(archivePath)) {
    throw new Error(`unsupported archive format: ${archivePath}`);
  }
  const archiveStat = await fs.promises.stat(archivePath);
  const maxArchiveBytes = limits.maxArchiveBytes ?? WEBAPP_PACKAGE_LIMITS.maxArchiveBytes;
  if (!archiveStat.isFile() || archiveStat.size > maxArchiveBytes) {
    throw new Error(`archive exceeds the size limit: ${archivePath}`);
  }
  const zip = await JSZip.loadAsync(await fs.promises.readFile(archivePath), { checkCRC32: true });
  const entries = Object.values(zip.files);
  const inspected = validateZipEntrySafety(entries.map((entry) => {
    const data = (entry as unknown as {
      _data?: { compressedSize?: number; uncompressedSize?: number };
    })._data;
    return {
      name: entry.name,
      dir: entry.dir,
      unixPermissions: typeof entry.unixPermissions === "number" ? entry.unixPermissions : undefined,
      compressedSize: Number(data?.compressedSize ?? 0),
      uncompressedSize: Number(data?.uncompressedSize ?? 0)
    };
  }), {
    archiveBytes: archiveStat.size,
    ...limits
  });
  return {
    entries: inspected.entries,
    archiveBytes: archiveStat.size,
    expandedBytes: inspected.expandedBytes
  };
}

async function extractZipArchiveWithJSZip(archivePath: string, targetDir: string) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(archivePath));
  for (const entry of Object.values(zip.files)) {
    const entryName = entry.name.trim().replace(/\\/g, "/");
    if (!entryName) {
      continue;
    }
    const targetPath = resolveSafeArchiveTarget(targetDir, entryName);
    if (entry.dir || entryName.endsWith("/")) {
      fs.mkdirSync(targetPath, { recursive: true });
      if (typeof entry.unixPermissions === "number") {
        await fs.promises.chmod(targetPath, entry.unixPermissions & 0o777).catch(() => undefined);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, await entry.async("nodebuffer"));
    if (typeof entry.unixPermissions === "number") {
      await fs.promises.chmod(targetPath, entry.unixPermissions & 0o777).catch(() => undefined);
    }
  }
}

async function readArchiveEntries(archivePath: string) {
  const archiveType = ensureSupportedArchive(archivePath);
  if (archiveType === "zip") {
    return listZipEntries(archivePath);
  }

  const output = await runArchiveCommand(tarCommand(), ["-tzf", archivePath]);

  return new Set(
    output
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

const archiveEntryCache = new Map<string, { fingerprint: string; entries: Promise<Set<string>> }>();

export async function listArchiveEntries(archivePath: string, options: { cache?: boolean } = {}) {
  if (!options.cache) {
    return readArchiveEntries(archivePath);
  }

  const stat = await fs.promises.stat(archivePath);
  const fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  const cached = archiveEntryCache.get(archivePath);
  if (cached?.fingerprint === fingerprint) {
    return cached.entries;
  }

  const entries = readArchiveEntries(archivePath).catch((error) => {
    if (archiveEntryCache.get(archivePath)?.entries === entries) {
      archiveEntryCache.delete(archivePath);
    }
    throw error;
  });
  if (archiveEntryCache.size >= 16) {
    const oldest = archiveEntryCache.keys().next().value;
    if (oldest !== undefined) archiveEntryCache.delete(oldest);
  }
  archiveEntryCache.set(archivePath, { fingerprint, entries });
  return entries;
}

export async function extractArchiveToDir(archivePath: string, targetDir: string): Promise<void> {
  const timing = beginStartupTiming("extractArchiveToDir", {
    archive: archivePath.split(/[\\/]/u).pop() ?? archivePath
  });
  const archiveType = ensureSupportedArchive(archivePath);
  try {
    await fs.promises.mkdir(targetDir, { recursive: true });

    if (archiveType === "zip") {
      const isWindows = process.platform === "win32";
      if (!isWindows) {
        await extractZipArchiveWithJSZip(archivePath, targetDir);
        return;
      }
      try {
        await runArchiveCommand("tar.exe", ["-xf", archivePath, "-C", targetDir]);
        return;
      } catch (tarError) {
        console.warn(`[archive-utils] tar.exe failed to extract, falling back to PowerShell:`, tarError);
        try {
          await fs.promises.rm(targetDir, { recursive: true, force: true });
        } catch {}
        await fs.promises.mkdir(targetDir, { recursive: true });
        await runPowerShell(`
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dest = ${quotePowerShell(targetDir)}
[System.IO.Compression.ZipFile]::ExtractToDirectory(${quotePowerShell(archivePath)}, $dest)
`);
        return;
      }
    }

    await runArchiveCommand(tarCommand(), ["-xzf", archivePath, "-C", targetDir]);
  } finally {
    timing.end({ type: archiveType });
  }
}


export async function readFileFromArchive(archivePath: string, entryPath: string) {
  const archiveType = ensureSupportedArchive(archivePath);
  if (archiveType === "zip") {
    const normalizedPath = entryPath.replace(/\\/g, "/");
    const entry = await readZipEntryText(archivePath, (name) => name === normalizedPath);
    if (entry === null) {
      throw new Error(`archive entry not found: ${entryPath}`);
    }
    return entry;
  }

  return runArchiveCommand(tarCommand(), ["-xzf", archivePath, "-O", entryPath]);
}
