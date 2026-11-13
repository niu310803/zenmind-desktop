import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { App } from "electron";
import type { Manifest } from "../../../shared/contracts";
import { normalizeManifest, readManifestFile, readManifestFromArchive, type ServiceDefinition } from "../../support/manifest/manifest-utils";
import { isZipArchive } from "../../support/archive/archive-utils";
import { replaceBuiltinServices } from "./service-registry";
import { beginStartupTiming } from "../../support/logging/startup-timing";
import { getServicesRoot } from "../../infrastructure/filesystem/user-paths";
import { readServicePortDefaultsConfig } from "./port-defaults";
import { getBuiltinAssetsRoot } from "./builtin-assets-root";
import { isInstallHealthy } from "./manager/bundle-assets";
import { BUILTIN_EXTRACTION_PREFIX } from "./manager/builtin-install";
import { getServiceLayout } from "./manager/layout";
import { readInitializationState } from "./manager/state-files";

export { getBuiltinAssetsRoot };

const manifestCache = new Map<string, { key: string; manifest: Manifest }>();
export const MIN_AGENT_WEBCLIENT_BRIDGE_V6_BUNDLE_VERSION = "v0.3.60";

type BuiltinAssetIndexEntry = {
  id: string;
  version: string;
  assetSignature?: string;
  manifestSha256?: string;
};

type InstalledBuiltin = {
  definition: ServiceDefinition;
  manifestPath: string;
  manifestSha256?: string;
};

function archiveExtensionsForCurrentPlatform() {
  if (process.platform === "win32") {
    return [".zip"];
  }
  if (process.platform === "darwin") {
    return [".tar.gz", ".tgz"];
  }
  return [".tar.gz", ".tgz"];
}

function isArchiveAssetFileName(fileName: string) {
  const normalized = fileName.toLowerCase();
  return archiveExtensionsForCurrentPlatform().some((extension) => normalized.endsWith(extension));
}

function isDirectoryBuiltinAsset(assetPath: string) {
  return fs.existsSync(path.join(assetPath, "manifest.json"));
}

function listBuiltinAssetPaths(root: string) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const assetPaths: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const serviceDir = path.join(root, entry.name);
    for (const asset of fs.readdirSync(serviceDir, { withFileTypes: true })) {
      const assetPath = path.join(serviceDir, asset.name);
      if (asset.isDirectory() && isDirectoryBuiltinAsset(assetPath)) {
        assetPaths.push(assetPath);
        continue;
      }
      if (asset.isFile() && isArchiveAssetFileName(asset.name)) {
        assetPaths.push(assetPath);
      }
    }
  }

  assetPaths.sort((left, right) => left.localeCompare(right));
  return assetPaths;
}

function readBuiltinAssetIndex(root: string) {
  const indexPath = path.join(root, "manifest.json");
  const byAssetPath = new Map<string, BuiltinAssetIndexEntry>();
  if (!fs.existsSync(indexPath)) {
    return byAssetPath;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8")) as unknown;
    const services = parsed && typeof parsed === "object" && Array.isArray((parsed as { services?: unknown }).services)
      ? (parsed as { services: unknown[] }).services
      : [];
    for (const item of services) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const version = typeof record.version === "string" ? record.version.trim() : "";
      const assetFileName = typeof record.assetFileName === "string" ? record.assetFileName.trim() : "";
      const assetSignature = typeof record.assetSignature === "string" ? record.assetSignature : undefined;
      const manifestSha256 = typeof record.manifestSha256 === "string" && /^[a-f0-9]{64}$/u.test(record.manifestSha256)
        ? record.manifestSha256 : undefined;
      if (id && version && assetFileName) {
        byAssetPath.set(`${id}/${assetFileName}`, { id, version, assetSignature, manifestSha256 });
      }
    }
  } catch (error) {
    console.warn(`[builtin-loader] failed to read builtin asset index ${indexPath}`, error);
  }

  return byAssetPath;
}

async function readCachedManifest(assetPath: string) {
  const assetStat = fs.statSync(assetPath);
  const statPath = assetStat.isDirectory()
    ? path.join(assetPath, "manifest.json")
    : assetPath;
  const stat = fs.statSync(statPath);
  const cacheKey = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  const cached = manifestCache.get(assetPath);
  if (cached && cached.key === cacheKey) {
    return cached.manifest;
  }

  const manifest = assetStat.isDirectory()
    ? readManifestFile(path.join(assetPath, "manifest.json"))
    : await readManifestFromArchive(assetPath, { cache: true });
  manifestCache.set(assetPath, {
    key: cacheKey,
    manifest
  });
  return manifest;
}

function getCurrentManifestOs() {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      return process.platform;
  }
}

function isPlatformMatch(manifestOs: string) {
  return manifestOs.trim().toLowerCase() === getCurrentManifestOs();
}

function normalizeBuiltinVersion(version: string) {
  return version
    .trim()
    .replace(/^v/iu, "")
    .split(".")
    .map((segment) => {
      const match = segment.match(/^(\d+)(.*)$/u);
      if (!match) {
        return { number: Number.NaN, suffix: segment };
      }
      return {
        number: Number.parseInt(match[1], 10),
        suffix: match[2] ?? ""
      };
    });
}

function compareBuiltinVersions(leftVersion: string, rightVersion: string) {
  const left = normalizeBuiltinVersion(leftVersion);
  const right = normalizeBuiltinVersion(rightVersion);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? { number: 0, suffix: "" };
    const rightPart = right[index] ?? { number: 0, suffix: "" };
    const leftNumber = Number.isFinite(leftPart.number) ? leftPart.number : -1;
    const rightNumber = Number.isFinite(rightPart.number) ? rightPart.number : -1;
    if (leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
    if (leftPart.suffix !== rightPart.suffix) {
      return leftPart.suffix.localeCompare(rightPart.suffix);
    }
  }
  return 0;
}

export function isSupportedAgentWebclientBundle(manifest: Manifest) {
  return manifest.id !== "agent-webclient" ||
    compareBuiltinVersions(manifest.version, MIN_AGENT_WEBCLIENT_BRIDGE_V6_BUNDLE_VERSION) >= 0;
}

function listInstalledBuiltinManifestPaths(app: App) {
  const servicesRoot = getServicesRoot(app);
  if (!fs.existsSync(servicesRoot)) {
    return [];
  }

  const manifestPaths: string[] = [];
  for (const serviceEntry of fs.readdirSync(servicesRoot, { withFileTypes: true })) {
    if (!serviceEntry.isDirectory()) {
      continue;
    }
    const serviceRoot = path.join(servicesRoot, serviceEntry.name);
    for (const versionEntry of fs.readdirSync(serviceRoot, { withFileTypes: true })) {
      if (!versionEntry.isDirectory() || versionEntry.name.startsWith(BUILTIN_EXTRACTION_PREFIX)) {
        continue;
      }
      const manifestPath = path.join(serviceRoot, versionEntry.name, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        manifestPaths.push(manifestPath);
      }
    }
  }

  return manifestPaths.sort((left, right) => left.localeCompare(right));
}

function loadInstalledBuiltinServices(app: App, coreServiceDefaultPorts: Record<string, number> | undefined) {
  const latestByServiceId = new Map<string, InstalledBuiltin>();

  for (const manifestPath of listInstalledBuiltinManifestPaths(app)) {
    try {
      const raw = process.platform === "win32" ? fs.readFileSync(manifestPath) : undefined;
      const manifest = raw
        ? JSON.parse(raw.toString("utf8").replace(/^\uFEFF/u, "")) as Manifest
        : readManifestFile(manifestPath);
      const manifestKind = manifest && typeof manifest === "object" && !Array.isArray(manifest)
        ? (manifest as { kind?: unknown }).kind
        : undefined;
      if (manifestKind !== "builtin") {
        continue;
      }
      if (manifest.platform?.os && !isPlatformMatch(manifest.platform.os)) {
        continue;
      }
      if (!isSupportedAgentWebclientBundle(manifest)) {
        console.warn(
          `[builtin-loader] rejecting agent-webclient ${manifest.version}; minimum supported Program bundle is ${MIN_AGENT_WEBCLIENT_BRIDGE_V6_BUNDLE_VERSION}`
        );
        continue;
      }
      const current = latestByServiceId.get(manifest.id);
      if (!current || compareBuiltinVersions(manifest.version, current.definition.version) > 0) {
        const definition = normalizeManifest(manifest, {
          defaultKind: "builtin",
          coreServiceDefaultPorts
        });
        latestByServiceId.set(definition.id, {
          definition,
          manifestPath,
          ...(raw ? { manifestSha256: createHash("sha256").update(raw).digest("hex") } : {})
        });
      }
    } catch (error) {
      console.warn(`[builtin-loader] failed to read installed builtin manifest ${manifestPath}`, error);
    }
  }

  return latestByServiceId;
}

function readIndexedWindowsReceipt(
  app: App,
  service: ServiceDefinition,
  asset: BuiltinAssetIndexEntry
) {
  if (
    service.kind !== "builtin" ||
    asset.id !== service.id ||
    asset.version !== service.version ||
    !asset.assetSignature ||
    !asset.manifestSha256
  ) {
    return;
  }
  const layout = getServiceLayout(app, service);
  const receipt = readInitializationState(layout);
  if (
    receipt?.status === "succeeded" &&
    receipt.version === service.version &&
    receipt.assetSignature === asset.assetSignature
  ) {
    return layout;
  }
}

function reuseInstalledWindowsBuiltin(
  app: App,
  installed: InstalledBuiltin,
  asset: BuiltinAssetIndexEntry,
  assetFileName: string
): ServiceDefinition | undefined {
  const { definition } = installed;
  const layout = readIndexedWindowsReceipt(app, definition, asset);
  if (
    !layout ||
    installed.manifestPath !== path.join(layout.programDir, "manifest.json") ||
    installed.manifestSha256 !== asset.manifestSha256 ||
    !isInstallHealthy(definition, layout.programDir)
  ) {
    return;
  }
  return {
    ...definition,
    assetFileName,
    desktop: { ...definition.desktop, assetFileName }
  };
}

export async function loadBuiltinServices(app: App) {
  const timing = beginStartupTiming("loadBuiltinServices");
  let loadedCount = 0;
  let reusedCount = 0;
  try {
    const builtinAssetsRoot = getBuiltinAssetsRoot(app);
    const portDefaultsConfig = readServicePortDefaultsConfig(app);
    const coreServiceDefaultPorts = portDefaultsConfig
      ? Object.fromEntries(Object.entries(portDefaultsConfig.services).map(([serviceId, config]) => [
          serviceId,
          config.defaultPort
        ]))
      : undefined;
    const installedByServiceId = loadInstalledBuiltinServices(app, coreServiceDefaultPorts);
    const registeredByServiceId = new Map(
      [...installedByServiceId].map(([id, installed]) => [id, installed.definition])
    );
    const definitions = [...registeredByServiceId.values()];
    const assetIndex = readBuiltinAssetIndex(builtinAssetsRoot);

    for (const assetPath of listBuiltinAssetPaths(builtinAssetsRoot)) {
      const assetFileName = path.basename(assetPath);
      const indexedAsset = assetIndex.get(`${path.basename(path.dirname(assetPath))}/${assetFileName}`);
      const installed = indexedAsset ? installedByServiceId.get(indexedAsset.id) : undefined;
      if (indexedAsset) {
        const existing = registeredByServiceId.get(indexedAsset.id);
        if (existing && compareBuiltinVersions(existing.version, indexedAsset.version) > 0) {
          continue;
        }
        const reused = installed && process.platform === "win32" && isZipArchive(assetPath)
          ? reuseInstalledWindowsBuiltin(app, installed, indexedAsset, assetFileName)
          : undefined;
        if (reused) {
          definitions.push(reused);
          registeredByServiceId.set(reused.id, reused);
          reusedCount += 1;
          continue;
        }
      }

      const manifest = await readCachedManifest(assetPath);
      if (manifest.platform?.os && !isPlatformMatch(manifest.platform.os)) {
        continue;
      }
      if (!isSupportedAgentWebclientBundle(manifest)) {
        console.warn(
          `[builtin-loader] rejecting agent-webclient ${manifest.version}; minimum supported Program bundle is ${MIN_AGENT_WEBCLIENT_BRIDGE_V6_BUNDLE_VERSION}`
        );
        continue;
      }
      const definition = normalizeManifest(manifest, {
        defaultKind: "builtin",
        coreServiceDefaultPorts,
        desktop: { assetFileName }
      });
      if (
        process.platform === "win32" && isZipArchive(assetPath) &&
        indexedAsset?.manifestSha256 && installed?.manifestSha256 !== indexedAsset.manifestSha256
      ) {
        const indexedLayout = readIndexedWindowsReceipt(app, definition, indexedAsset);
        if (indexedLayout && fs.existsSync(indexedLayout.programDir)) {
          // The installed bytes must be repaired even when the version and bundle receipt match.
          definition.builtinAssetManifestSha256 = indexedAsset.manifestSha256;
        }
      }
      definitions.push(definition);
      if (definition.kind === "builtin") {
        registeredByServiceId.set(definition.id, definition);
      }
    }

    replaceBuiltinServices(definitions);
    const sorted = [...registeredByServiceId.values()].sort((left, right) => left.id.localeCompare(right.id));
    loadedCount = sorted.length;
    return sorted;
  } finally {
    timing.end({ count: loadedCount, reusedInstalled: reusedCount });
  }
}
