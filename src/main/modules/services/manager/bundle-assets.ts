import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { App } from "electron";
import type { ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { getBuiltinAssetsRoot } from "../builtin-assets-root";
import { listArchiveEntries } from "../../../support/archive/archive-utils";
import { t } from "../../../support/i18n/main-i18n";
import { isWindowsFileLock, retryWindowsFileOperation } from "../../../infrastructure/filesystem/windows-file-retry";

const syncedAssetManifestCache = new Map<string, { key: string; services: SyncedAssetManifestService[] }>();

type SyncedAssetManifestService = {
  id?: unknown;
  version?: unknown;
  assetFileName?: unknown;
  assetSignature?: unknown;
};

export function getBuiltinAssetPath(app: App, service: ServiceDefinition) {
  if (!service.desktop.assetFileName) {
    throw new Error(t("service.assetFileNameMissing", { serviceId: service.id }));
  }
  return path.join(getBuiltinAssetsRoot(app), service.id, service.desktop.assetFileName);
}

export async function computeAssetSignature(assetPath: string) {
  const stat = await fs.promises.lstat(assetPath);
  const hash = createHash("sha256");
  if (stat.isDirectory()) {
    let totalSize = 0;
    for (const filePath of await listRegularFiles(assetPath)) {
      const relativePath = path.relative(assetPath, filePath).replace(/\\/g, "/");
      const fileStat = await fs.promises.lstat(filePath);
      hash.update(relativePath);
      hash.update("\0");
      hash.update(String(fileStat.mode & 0o777));
      hash.update("\0");
      if (fileStat.isSymbolicLink()) {
        hash.update("symlink");
        hash.update("\0");
        hash.update(await fs.promises.readlink(filePath));
        hash.update("\0");
        continue;
      }
      totalSize += fileStat.size;
      hash.update("file");
      hash.update("\0");
      for await (const chunk of fs.createReadStream(filePath)) {
        hash.update(chunk);
      }
      hash.update("\0");
    }
    return `dir:${totalSize}:${hash.digest("hex")}`;
  }

  for await (const chunk of fs.createReadStream(assetPath)) {
    hash.update(chunk);
  }
  return `${stat.size}:${hash.digest("hex")}`;
}

async function listRegularFiles(rootDir: string) {
  const result: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) {
      continue;
    }
    const stat = await fs.promises.lstat(currentPath);
    if (stat.isSymbolicLink()) {
      result.push(currentPath);
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of await fs.promises.readdir(currentPath, { withFileTypes: true })) {
        stack.push(path.join(currentPath, entry.name));
      }
      continue;
    }
    if (stat.isFile()) {
      result.push(currentPath);
    }
  }

  return result.sort((left, right) => left.localeCompare(right));
}

export async function moveExtractedBuiltinRoot(extractedRoot: string, finalInstallDir: string) {
  try {
    await retryWindowsFileOperation(process.platform, () => fs.promises.rename(extractedRoot, finalInstallDir));
    return;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code !== "EXDEV" && !isWindowsFileLock(error)) {
      throw error;
    }
  }

  // Prepare the fallback copy outside the live version so readers never see
  // a partial install. The caller removes the transaction directory.
  const stagingCopy = path.join(path.dirname(extractedRoot), ".publish-copy");
  await fs.promises.cp(extractedRoot, stagingCopy, { recursive: true, force: true });
  await retryWindowsFileOperation(process.platform, () => fs.promises.rename(stagingCopy, finalInstallDir));
}

function readSyncedBuiltinAssetManifest(app: App) {
  const manifestPath = path.join(getBuiltinAssetsRoot(app), "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  try {
    const stat = fs.statSync(manifestPath);
    const cacheKey = `${stat.size}:${stat.mtimeMs}`;
    const cached = syncedAssetManifestCache.get(manifestPath);
    if (cached && cached.key === cacheKey) {
      return cached.services;
    }

    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { services?: unknown };
    const services = Array.isArray(parsed.services)
      ? parsed.services.filter((item): item is SyncedAssetManifestService => Boolean(item) && typeof item === "object")
      : [];
    syncedAssetManifestCache.set(manifestPath, {
      key: cacheKey,
      services
    });
    return services;
  } catch {
    return [];
  }
}

export function readSyncedBuiltinAssetSignature(app: App, service: ServiceDefinition) {
  const assetFileName = service.desktop.assetFileName;
  if (!assetFileName) {
    return undefined;
  }

  const match = readSyncedBuiltinAssetManifest(app).find((entry) =>
    entry.id === service.id &&
    entry.version === service.version &&
    entry.assetFileName === assetFileName &&
    typeof entry.assetSignature === "string" &&
    entry.assetSignature.trim().length > 0
  );

  return typeof match?.assetSignature === "string" ? match.assetSignature : undefined;
}

export async function readBuiltinAssetSignature(app: App, service: ServiceDefinition) {
  if (service.kind !== "builtin") {
    return undefined;
  }
  const syncedSignature = readSyncedBuiltinAssetSignature(app, service);
  if (syncedSignature) {
    return syncedSignature;
  }
  const assetPath = await getOptionalBundleAssetPath(app, service);
  return assetPath ? computeAssetSignature(assetPath) : undefined;
}

export function listMissingRuntimeFiles(service: ServiceDefinition, installDir: string) {
  const missing = service.runtime.requiredPaths.filter((relativePath) =>
    !fs.existsSync(path.join(installDir, relativePath))
  );
  if (service.builtinAssetManifestSha256 && !missing.includes("manifest.json")) {
    try {
      const raw = fs.readFileSync(path.join(installDir, "manifest.json"));
      if (createHash("sha256").update(raw).digest("hex") === service.builtinAssetManifestSha256) {
        return missing;
      }
    } catch {
      // An unreadable installed manifest needs the same repair as a missing one.
    }
    missing.push("manifest.json");
  }
  return missing;
}

export function isInstallHealthy(service: ServiceDefinition, installDir: string) {
  return listMissingRuntimeFiles(service, installDir).length === 0;
}

export async function listMissingBundleEntries(service: ServiceDefinition, archivePath: string) {
  const entries = await listArchiveEntries(archivePath, { cache: true });
  return service.runtime.requiredPaths.filter((relativePath) => {
    const normalizedRelativePath = relativePath.replace(/\\/g, "/");
    const expectedPath = `${service.desktop.bundleTopLevelDir}/${normalizedRelativePath}`;
    if (entries.has(expectedPath) || entries.has(`${expectedPath}/`)) {
      return false;
    }
    const backslashPath = expectedPath.replace(/\//g, "\\");
    if (entries.has(backslashPath) || entries.has(`${backslashPath}\\`)) {
      return false;
    }
    const prefix = expectedPath.endsWith("/") ? expectedPath : `${expectedPath}/`;
    const backslashPrefix = backslashPath.endsWith("\\") ? backslashPath : `${backslashPath}\\`;
    return ![...entries].some(
      (entry) => entry.startsWith(prefix) || entry.startsWith(backslashPrefix)
    );
  });
}

export function listMissingBundleDirectoryEntries(service: ServiceDefinition, directoryPath: string) {
  return service.runtime.requiredPaths.filter((relativePath) => {
    const normalizedRelativePath = relativePath.replace(/\\/g, "/");
    return !fs.existsSync(path.join(directoryPath, ...normalizedRelativePath.split("/").filter(Boolean)));
  });
}

export async function ensureArchiveHealthy(service: ServiceDefinition, archivePath: string, sourceLabel: string) {
  if (!fs.existsSync(archivePath)) {
    throw new Error(t("service.archiveMissing", { sourceLabel, path: archivePath }));
  }

  const missingEntries = await listMissingBundleEntries(service, archivePath);
  if (missingEntries.length > 0) {
    throw new Error(t("service.archiveIncomplete", { sourceLabel, entries: missingEntries.join(", ") }));
  }

  return archivePath;
}

export function ensureDirectoryAssetHealthy(service: ServiceDefinition, directoryPath: string, sourceLabel: string) {
  if (!fs.existsSync(directoryPath)) {
    throw new Error(t("service.archiveMissing", { sourceLabel, path: directoryPath }));
  }
  if (!fs.statSync(directoryPath).isDirectory()) {
    throw new Error(t("service.archiveMissing", { sourceLabel, path: directoryPath }));
  }

  const missingEntries = listMissingBundleDirectoryEntries(service, directoryPath);
  if (missingEntries.length > 0) {
    throw new Error(t("service.archiveIncomplete", { sourceLabel, entries: missingEntries.join(", ") }));
  }

  return directoryPath;
}

export async function ensureBundleAssetHealthy(app: App, service: ServiceDefinition) {
  const assetPath = getBuiltinAssetPath(app, service);
  if (fs.existsSync(assetPath) && fs.statSync(assetPath).isDirectory()) {
    return ensureDirectoryAssetHealthy(service, assetPath, t("service.builtinAssetLabel"));
  }
  return ensureArchiveHealthy(service, assetPath, t("service.builtinAssetLabel"));
}

export async function getOptionalBundleAssetPath(app: App, service: ServiceDefinition) {
  try {
    return await ensureBundleAssetHealthy(app, service);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[service-manager] builtin asset unavailable for ${service.id}; using installed service when possible: ${message}`
    );
    return null;
  }
}
