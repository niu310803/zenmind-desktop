import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { App } from "electron";
import type { MarketCommandResult, MarketItem } from "../../../shared/contracts";
import { WEBAPP_ID_PATTERN } from "../../../shared/webapp-manifest";
import { WebappPackageValidationError } from "../../support/archive/package-safety.js";
import { validateWebappArchiveLayout } from "../webs";
import { extractArchiveToDir, inspectZipArchiveSafety } from "../../support/archive/archive-utils";
import { t } from "../../support/i18n/main-i18n";
import {
  getDesktopWebappDataRoot,
  getDesktopWebappInstallStagingRoot,
  getDesktopWebappLogsRoot,
  getDesktopWebappStateRoot,
  getDesktopWebappsDataRoot
} from "../../infrastructure/filesystem/user-paths";
import { disposeWebappInstallation } from "../webs";
import {
  readInstalledWebappItems,
  readWebappItemFromDir
} from "../webs";
import {
  WebappInstallError,
  WebappInstallPolicyError,
  WebappRuntimeRequiredError,
  type WebappInstallStage
} from "../webs";
import { webappRuntime } from "../webs";
import { webappWindowManager } from "../webs";
import {
  activateWebappInstall,
  commitWebappInstall,
  hasPendingWebappInstallTransaction,
  markWebappInstallRollback,
  removeWebappDirectory,
  rollbackWebappInstall,
  type WebappInstallTransaction
} from "../webs";
import {
  downloadAsset,
  findCatalogItem,
  loadMarketplaceCatalog,
  mergeCatalogItems,
  normalizeCatalog,
  readInstalledRecords,
  resolveMarketAsset,
  upsertInstalledRecord,
  type Catalog,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

const installingWebappKeys = new Set<string>();

type WebsiteAppCatalogResult = {
  catalog: Catalog;
  offline: boolean;
  message: string;
  sourceUrl: string;
};

type WebsiteAppArchiveInstallOptions = {
  expectedId?: string;
  marketItemId?: string;
  displayName?: string;
  version?: string;
  source?: "cloud" | "local";
  platform?: string;
  assetUrl?: string;
  sha256?: string;
  removeArchive?: boolean;
  recordInstallation?: boolean;
  webs?: MarketplaceOptions["webs"];
};

export { WebappInstallError, WebappInstallPolicyError, WebappRuntimeRequiredError };
export type { WebappInstallStage };

function toWebappInstallError(
  error: unknown,
  stage: WebappInstallStage,
  code: string,
  details: Record<string, unknown> = {}
) {
  if (error instanceof WebappInstallError) {
    return error;
  }
  if (error instanceof WebappPackageValidationError) {
    return new WebappInstallError(error.stage, error.code, error.message, error.details);
  }
  return new WebappInstallError(
    stage,
    code,
    error instanceof Error ? error.message : String(error),
    details
  );
}

function websiteAppOnlyCatalog(catalog: Catalog): Catalog {
  return {
    ...catalog,
    items: catalog.items.filter((item) =>
      item.type === "website-app" && item.websiteKind === "local-app"
    )
  };
}

async function loadWebsiteAppCatalog(
  app: App,
  options: MarketplaceOptions = {}
): Promise<WebsiteAppCatalogResult> {
  if (options.catalog) {
    return {
      catalog: websiteAppOnlyCatalog(normalizeCatalog(options.catalog)),
      offline: false,
      message: t("market.main.catalogLoaded"),
      sourceUrl: options.catalogUrl ?? ""
    };
  }

  const result = await loadMarketplaceCatalog(app, options, "website app market catalog request");
  return {
    ...result,
    catalog: websiteAppOnlyCatalog(result.catalog)
  };
}

function validateWebappId(value: unknown) {
  const id = typeof value === "string" ? value : "";
  return WEBAPP_ID_PATTERN.test(id) ? id : "";
}

function compareSemver(left: string, right: string) {
  const parse = (value: string) => {
    const separator = value.indexOf("-");
    const core = separator >= 0 ? value.slice(0, separator) : value;
    const prerelease = separator >= 0 ? value.slice(separator + 1) : "";
    return {
      core: core!.split(".").map(Number),
      prerelease: prerelease ? prerelease.split(".") : []
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined || bPart === undefined) return aPart === bPart ? 0 : aPart === undefined ? -1 : 1;
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/u.test(aPart);
    const bNumeric = /^\d+$/u.test(bPart);
    if (aNumeric && bNumeric) return Math.sign(Number(aPart) - Number(bPart));
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

function calculateDirectoryDigest(rootPath: string) {
  const hash = createHash("sha256");
  const visit = (directoryPath: string) => {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        throw new Error(`WebApp packages must not contain symbolic links: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        visit(absolutePath);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0`);
        hash.update(fs.readFileSync(absolutePath));
        hash.update("\0");
      }
    }
  };
  visit(rootPath);
  return hash.digest("hex");
}

function listLocalWebsiteApps(app: App): MarketItem[] {
  return readInstalledWebappItems(app).map((item) => ({
    id: item.id,
    type: "website-app",
    name: item.label,
    version: item.version,
    description: "",
    tags: [],
    state: "local-imported",
    source: "local",
    installedVersion: item.version,
    installPath: item.installPath,
    websiteKind: "local-app"
  }));
}

export async function listWebsiteAppMarketItems(
  app: App,
  options: MarketplaceOptions = {}
): Promise<MarketSectionResult> {
  const result = await loadWebsiteAppCatalog(app, options);
  return {
    items: mergeCatalogItems(app, result.catalog.items, listLocalWebsiteApps(app)),
    offline: result.offline,
    message: result.message,
    sourceUrl: result.sourceUrl
  };
}

export async function installWebsiteAppMarketItem(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketCommandResult> {
  const { catalog } = await loadWebsiteAppCatalog(app, options);
  const catalogItem = findCatalogItem(catalog, itemId, "website-app");
  const resolved = await resolveMarketAsset(app, catalogItem, options);
  const item = resolved.item;
  if (item.websiteKind !== "local-app" || resolved.asset.archiveType !== "zip") {
    throw new WebappInstallError(
      "archive",
      "unsupported_market_artifact",
      t("market.websiteApp.localZipRequired")
    );
  }
  const archivePath = await downloadAsset(app, item, resolved.asset, options, resolved.downloadUrl);
  return installWebsiteAppArchiveFromPath(app, archivePath, {
    marketItemId: item.id,
    displayName: item.name,
    version: item.version,
    source: "cloud",
    platform: resolved.platform,
    assetUrl: resolved.asset.url,
    sha256: resolved.asset.sha256,
    removeArchive: true,
    webs: options.webs
  });
}

export async function installWebsiteAppArchiveFromPath(
  app: App,
  archivePath: string,
  options: WebsiteAppArchiveInstallOptions = {}
): Promise<MarketCommandResult> {
  const runtime = options.webs?.webappRuntime ?? webappRuntime;
  const windowManager = options.webs?.webappWindowManager ?? webappWindowManager;
  if (path.extname(archivePath).toLowerCase() !== ".zip") {
    throw new WebappInstallError("archive", "unsupported_format", "WebApp packages must be ZIP archives.", {
      path: archivePath
    });
  }
  const hasExpectedId = Object.hasOwn(options, "expectedId");
  const expectedId = hasExpectedId ? validateWebappId(options.expectedId) : "";
  if (hasExpectedId && !expectedId) {
    throw new WebappInstallPolicyError(
      "invalid_id",
      t("market.websiteApp.invalidId"),
      { expectedId: options.expectedId }
    );
  }
  const tempId = expectedId || `local-${Date.now()}`;
  const stagingRoot = getDesktopWebappInstallStagingRoot(app);
  fs.mkdirSync(stagingRoot, { recursive: true });
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempRoot = path.join(stagingRoot, `${tempId}-${nonce}`);
  const preparedPath = path.join(stagingRoot, `${tempId}-${nonce}-package`);
  let transaction: WebappInstallTransaction | null = null;
  let installation: ReturnType<typeof runtime.beginInstallation> = null;
  let releaseWebappDisposal: (() => void) | null = null;
  let reservedKey: string | null = null;
  let activatedWebappId = "";
  let replacingExistingPackage = false;
  let previousPackageWasRunning = false;
  let previousPackageVersion = "";
  let previousPackageStopped = false;
  let installationId = "";
  let installationPath = "";
  let createdRuntimeDirectories: string[] = [];
  try {
    let archiveRootName: string;
    try {
      const { entries } = await inspectZipArchiveSafety(archivePath);
      archiveRootName = validateWebappArchiveLayout(entries, WEBAPP_ID_PATTERN);
      await extractArchiveToDir(archivePath, tempRoot);
    } catch (error) {
      throw toWebappInstallError(error, "archive", "invalid_archive", { path: archivePath });
    }
    const webappRoot = path.join(tempRoot, archiveRootName);
    if (!fs.existsSync(webappRoot) || !fs.statSync(webappRoot).isDirectory()) {
      throw new WebappInstallError("package", "package_root_missing", t("market.websiteApp.invalidPackage"), {
        path: webappRoot
      });
    }

    let webapp;
    try {
      webapp = readWebappItemFromDir(webappRoot, expectedId || archiveRootName);
    } catch (error) {
      throw toWebappInstallError(error, "manifest", "invalid_manifest", {
        path: path.join(webappRoot, "webapp.json")
      });
    }
    if (!webapp) {
      throw new WebappInstallError("package", "invalid_package", t("market.websiteApp.invalidPackage"));
    }
    const safeWebappDirName = validateWebappId(expectedId || webapp.id);
    if (!safeWebappDirName) {
      throw new WebappInstallError("manifest", "invalid_id", t("market.websiteApp.invalidId"));
    }
    if (webapp.id !== safeWebappDirName) {
      throw new WebappInstallError(
        "manifest",
        "id_mismatch",
        t("market.websiteApp.idMismatch", { expected: safeWebappDirName, actual: webapp.id }),
        { expected: safeWebappDirName, actual: webapp.id }
      );
    }
    if (archiveRootName !== webapp.id) {
      throw new WebappInstallError(
        "archive",
        "id_mismatch",
        t("market.websiteApp.idMismatch", { expected: archiveRootName, actual: webapp.id }),
        { expected: archiveRootName, actual: webapp.id }
      );
    }
    if (options.version && webapp.version !== options.version) {
      throw new WebappInstallError(
        "manifest",
        "version_mismatch",
        t("market.websiteApp.versionMismatch", {
          expected: options.version,
          actual: webapp.version
        }),
        { expected: options.version, actual: webapp.version }
      );
    }
    installation = runtime.beginInstallation(safeWebappDirName);
    if (!installation) {
      throw new WebappInstallError("install", "webapp_busy", t("webapp.removing"), {
        id: safeWebappDirName
      });
    }
    installationId = safeWebappDirName;
    if (hasPendingWebappInstallTransaction(app, safeWebappDirName)) {
      throw new WebappInstallError("install", "installation_recovery_required", t("webapp.installRecoveryRequired"), {
        id: safeWebappDirName
      });
    }
    if (installingWebappKeys.has(webapp.key)) {
      throw new WebappInstallError("install", "webapp_busy", t("webapp.removing"), {
        id: safeWebappDirName
      });
    }
    // The WebApp ID can differ between packages with the same key. Reserve
    // both identities before the asynchronous directory transaction begins.
    installingWebappKeys.add(webapp.key);
    reservedKey = webapp.key;
    releaseWebappDisposal = windowManager.beginDisposal(safeWebappDirName, {
      closeImmediately: false
    });
    const keyConflict = readInstalledWebappItems(app).find((item) =>
      item.key === webapp.key && item.id !== webapp.id
    );
    if (keyConflict) {
      throw new WebappInstallError(
        "install",
        "key_conflict",
        `WebApp key is already installed: ${webapp.key} (${keyConflict.id}).`,
        { key: webapp.key, installedId: keyConflict.id }
      );
    }

    const targetRoot = getDesktopWebappsDataRoot(app);
    const installPath = path.join(targetRoot, safeWebappDirName);
    installationPath = installPath;
    const replacingExisting = fs.existsSync(installPath);
    replacingExistingPackage = replacingExisting;
    if (replacingExisting) {
      const installed = readWebappItemFromDir(installPath, safeWebappDirName);
      if (!installed) {
        throw new WebappInstallError("install", "installed_package_invalid", t("market.websiteApp.invalidPackage"), {
          id: safeWebappDirName
        });
      }
      previousPackageVersion = installed.version;
      const versionOrder = compareSemver(webapp.version, installed.version);
      if (versionOrder < 0) {
        throw new WebappInstallPolicyError(
          "downgrade_not_allowed",
          `Cannot downgrade WebApp ${webapp.id} from ${installed.version} to ${webapp.version}.`,
          { id: webapp.id, installedVersion: installed.version, incomingVersion: webapp.version }
        );
      }
      if (versionOrder === 0) {
        const incomingDigest = calculateDirectoryDigest(webappRoot);
        const installedDigest = calculateDirectoryDigest(installPath);
        if (incomingDigest !== installedDigest) {
          throw new WebappInstallPolicyError(
            "version_content_conflict",
            `WebApp ${webapp.id} ${webapp.version} is already installed with different content.`,
            { id: webapp.id, version: webapp.version, installedDigest, incomingDigest }
          );
        }
        if (options.recordInstallation !== false) {
          upsertInstalledRecord(app, {
            id: options.marketItemId || webapp.id,
            type: "website-app",
            version: webapp.version,
            ...(options.platform ? { platform: options.platform } : {}),
            source: options.source ?? "local",
            ...(options.assetUrl ? { assetUrl: options.assetUrl } : {}),
            ...(options.sha256 ? { sha256: options.sha256 } : {}),
            installPath,
            ...(options.marketItemId ? { resourceKey: webapp.id } : {}),
            installedAt: new Date().toISOString()
          });
        }
        runtime.emitLifecycleChange("installed", webapp.id);
        return {
          ok: true,
          itemId: webapp.id,
          type: "website-app",
          state: "installed",
          message: t("market.websiteApp.installed", { name: options.displayName || webapp.label }),
          installPath
        };
      }
    }
    const previousState = replacingExisting ? runtime.getStatus(app, safeWebappDirName) : null;
    const previousWasRunning = previousState?.status === "running";
    previousPackageWasRunning = previousWasRunning;
    const prerequisites = runtime.checkItemPrerequisites(app, webapp, webappRoot);
    if (!prerequisites.ok) {
      if (
        webapp.backend?.command.type === "runtime" &&
        prerequisites.issues.some((entry) =>
          entry.code === "runtime_missing" || entry.code === "runtime_version_too_low"
        )
      ) {
        throw new WebappRuntimeRequiredError(
          webapp.id,
          webapp.backend.command.runtime,
          prerequisites.message
        );
      }
      throw new WebappInstallError("runtime", "runtime_invalid", prerequisites.message, {
        issues: prerequisites.issues
      });
    }
    if (replacingExisting) {
      const stopped = await runtime.stop(app, safeWebappDirName, t("market.websiteApp.replaced"));
      if (!stopped.ok) {
        throw new WebappInstallError(
          "install",
          "existing_runtime_stop_failed",
          t("webapp.marketReplaceActive", { message: stopped.message }),
          { id: safeWebappDirName }
        );
      }
      previousPackageStopped = true;
      await windowManager.closeForDisposal(safeWebappDirName);
    }
    fs.mkdirSync(targetRoot, { recursive: true });
    if (webappRoot === tempRoot) {
      fs.renameSync(tempRoot, preparedPath);
    } else {
      fs.renameSync(webappRoot, preparedPath);
    }
    createdRuntimeDirectories = [
      getDesktopWebappDataRoot(app, safeWebappDirName),
      getDesktopWebappStateRoot(app, safeWebappDirName),
      getDesktopWebappLogsRoot(app, safeWebappDirName)
    ].filter((directory) => !fs.existsSync(directory));
    transaction = await activateWebappInstall({
      app,
      id: safeWebappDirName,
      installPath,
      stagingPath: preparedPath
    });
    activatedWebappId = safeWebappDirName;

    {
      const started = await installation.start(app);
      if (!started.ok) {
        throw new WebappInstallError(
          "startup",
          "startup_failed",
          t("webapp.marketStartupValidationFailed", { message: started.message }),
          { id: safeWebappDirName }
        );
      }
      if (!previousWasRunning) {
        const stopped = await runtime.stop(app, safeWebappDirName);
        if (!stopped.ok) {
          throw new WebappInstallError("startup", "validation_stop_failed", stopped.message, {
            id: safeWebappDirName
          });
        }
      }
    }
    if (options.recordInstallation !== false) {
      upsertInstalledRecord(app, {
        id: options.marketItemId || webapp.id,
        type: "website-app",
        version: webapp.version,
        ...(options.platform ? { platform: options.platform } : {}),
        source: options.source ?? "local",
        ...(options.assetUrl ? { assetUrl: options.assetUrl } : {}),
        ...(options.sha256 ? { sha256: options.sha256 } : {}),
        installPath,
        ...(options.marketItemId ? { resourceKey: webapp.id } : {}),
        installedAt: new Date().toISOString()
      });
    }
    await commitWebappInstall(app, transaction);
    transaction = null;
    runtime.emitLifecycleChange(replacingExisting ? "updated" : "installed", webapp.id);

    return {
      ok: true,
      itemId: webapp.id,
      type: "website-app",
      state: "installed",
      message: t("market.websiteApp.installed", { name: options.displayName || webapp.label }),
      installPath
    };
  } catch (error) {
    let failure = toWebappInstallError(error, "install", "install_failed", { path: archivePath });
    if (transaction && activatedWebappId) {
      try {
        // Persist the rollback intent even if stopping fails. Recovery must not
        // mistake a failed new package for an installation ready to commit.
        await markWebappInstallRollback(app, transaction);
        const stopped = await runtime.stop(app, activatedWebappId);
        if (!stopped.ok) throw new Error(stopped.message);
        await windowManager.closeForDisposal(activatedWebappId);
        await rollbackWebappInstall(app, transaction);
        transaction = null;
        if (!replacingExistingPackage) {
          for (const directory of createdRuntimeDirectories) {
            await removeWebappDirectory(directory);
          }
        }
      } catch (recoveryError) {
        const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        failure = new WebappInstallError(failure.stage, failure.code, `${failure.message}\n${recoveryMessage}`, {
          ...failure.details,
          recovery: {
            message: recoveryMessage,
            installPath: installationPath,
            backupPath: transaction?.backupPath
          }
        });
      }
    }
    if (!transaction && previousPackageStopped && previousPackageWasRunning && installation) {
      // Activation can fail before it returns a transaction. Restart only a
      // verified old package, never an incompletely restored new directory.
      try {
        const restored = readWebappItemFromDir(installationPath, installationId);
        if (restored?.version === previousPackageVersion) await installation.start(app);
      } catch (restoreError) {
        console.warn("failed to restart restored WebApp", installationId, restoreError);
      }
    }
    throw failure;
  } finally {
    try {
      if (options.removeArchive) {
        await fs.promises.rm(archivePath, { force: true }).catch((error) => {
          console.warn("failed to clean WebApp archive", archivePath, error);
        });
      }
      await removeWebappDirectory(tempRoot).catch((error) => {
        console.warn("failed to clean WebApp extraction directory", tempRoot, error);
      });
    } finally {
      releaseWebappDisposal?.();
      installation?.release();
      if (reservedKey !== null) installingWebappKeys.delete(reservedKey);
    }
  }
}

export async function uninstallWebsiteAppMarketItem(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketCommandResult> {
  const marketRecord = readInstalledRecords(app).find((record) =>
    record.id === itemId && record.type === "website-app"
  );
  const webappId = marketRecord?.resourceKey || itemId;
  const target = readInstalledWebappItems(app).find((item) => item.id === webappId);
  if (!target) {
    throw new Error(t("webapp.notFound"));
  }
  if (target.removable === false) {
    throw new Error(t("webapp.managedNotRemovable", { label: target.label }));
  }
  const removed = await (options.webs?.disposeWebappInstallation ?? disposeWebappInstallation)(
    app,
    {
      id: target.id,
      label: target.label,
      installPath: target.installPath,
      removeMarketRecord: true,
      preserveUserData: true
    },
    t("market.websiteApp.uninstalled", { name: target.label })
  );
  if (!removed.ok) {
    throw new Error(removed.message);
  }
  return {
    ok: true,
    itemId,
    type: "website-app",
    state: "not-installed",
    message: t("market.websiteApp.uninstalled", { name: itemId })
  };
}

export const __websiteAppMarketInternals = {
  installWebsiteAppArchiveFromPath,
  loadWebsiteAppCatalog,
  validateWebappId
};
