import { type App } from "electron";
import { type ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { InstallBuiltinServiceOptions, integrationPorts, CORE_SERVICE_IDS } from "./manager-contracts";
import path from "node:path";
import { type ServiceLayout, getInstallDir, getServiceLayout } from "./layout";
import { type DesktopServiceConfigResetContext } from "./desktop-config-upgrade";
import { type ServicesIntegrationPorts } from "../integration-ports";
import { appendConfiguredServiceLifecycleArgs } from "../lifecycle-args";
import {
  appendAgentPlatformDesktopDeployArgs,
  appendAgentPlatformRuntimeResourceDeployArgs,
  appendDesktopConfigResetDeployArgs,
  appendDesktopDeployOutputDir
} from "./lifecycle-command-policy";
import fs from "node:fs";
import { t } from "../../../support/i18n/main-i18n";
import { type ServiceId, type ServiceCommandResult } from "../../../../shared/contracts";
import { getService } from "../service-registry";
import { builtinInstallQueues, inFlightBuiltinInstalls } from "./session-state";
import { beginStartupTiming } from "../../../support/logging/startup-timing";
import {
  ensureArchiveHealthy,
  ensureBundleAssetHealthy,
  computeAssetSignature,
  isInstallHealthy,
  moveExtractedBuiltinRoot,
  readBuiltinAssetSignature
} from "./bundle-assets";
import {
  isAssetNewerThanInstall,
  ensureDir,
  isDirectoryAssetPath,
  copyDirectoryAssetToTempRoot,
  prepareServiceExecutionLayout,
  ensureDefaultConfig
} from "./execution-layout";
import { BUILTIN_EXTRACTION_PREFIX, reconcileBuiltinSiblingInstallDirs, stopBuiltinInstallDir } from "./builtin-install";
import { extractArchiveToDir } from "../../../support/archive/archive-utils";
import { beginStartupCheckpoints } from "../../../support/logging/startup-checkpoints";
import { getServiceState } from "./service-state";
import { fixShellScriptPermissions } from "./program-layout";
import { buildDesktopServiceCommandEnv } from "./command-environment";
import { runExecFile, SERVICE_DEPLOY_TIMEOUT_MS } from "./command-runner";
import { writeInitializationState } from "./state-files";
import { readEnvFile } from "../../../infrastructure/filesystem/env-file";
import { applyEnvBindings, getServicePortForEnvSync } from "./environment-bindings";
import { writeEnvFileUpdates } from "./env-content";
import { resolveDesktopCapability } from "./capabilities";
import { setTimeout as delay } from "node:timers/promises";
import { retryWindowsFileOperation } from "../../../infrastructure/filesystem/windows-file-retry";

async function cleanupPreviousExtractions(finalInstallDir: string, serviceId: ServiceId) {
  const versionRoot = path.dirname(finalInstallDir);
  const entries = await fs.promises.readdir(versionRoot, { withFileTypes: true });
  const previousInstalls: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && /^\.extract-[a-zA-Z0-9]{6}$/u.test(entry.name)) {
      const extractionRoot = path.join(versionRoot, entry.name);
      const backupPath = path.join(extractionRoot, ".previous-install");
      const backup = await fs.promises.lstat(backupPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!backup) {
        await cleanupBuiltinExtraction(extractionRoot, serviceId);
      } else if (backup.isDirectory() && !backup.isSymbolicLink()) {
        const marker = await fs.promises.readFile(path.join(extractionRoot, ".install-version"), "utf8").catch(() => "");
        if (marker === path.basename(finalInstallDir)) previousInstalls.push(backupPath);
      }
    }
  }
  if (previousInstalls.length === 1 && !fs.existsSync(finalInstallDir)) {
    const backupPath = previousInstalls[0];
    await retryWindowsFileOperation(process.platform, () => fs.promises.rename(backupPath, finalInstallDir));
    await cleanupBuiltinExtraction(path.dirname(backupPath), serviceId);
  }
}

async function cleanupBuiltinExtraction(tempRoot: string, serviceId: ServiceId) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" &&
          ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"].includes(code ?? "") && attempt < 4) {
        await delay(100 * 2 ** attempt);
        continue;
      }
      // Temporary cleanup cannot replace the install result or its original error.
      console.warn(`[service-manager] retained extraction directory for ${serviceId} at ${tempRoot}`, error);
      return;
    }
  }
}

export function createBuiltinInstallKey(app: App, service: ServiceDefinition, options: InstallBuiltinServiceOptions) {
  const appScope = (() => {
    try {
      return app.getPath("userData");
    } catch {
      return "unknown-user-data";
    }
  })();
  const assetScope = options.archivePath ? path.resolve(options.archivePath) : "bundled";
  return [
    appScope,
    service.id,
    service.version,
    options.force ? "force" : "normal",
    options.skipInitialize ? "skip-initialize" : "initialize",
    assetScope
  ].join("\0");
}

export async function buildDesktopManagedDeployCommand(
  app: App,
  service: ServiceDefinition,
  command: string[],
  layout: ServiceLayout,
  desktopConfigReset?: DesktopServiceConfigResetContext,
  ports?: ServicesIntegrationPorts
) {
  const commandWithConfiguredArgs = appendConfiguredServiceLifecycleArgs(app, service, command, "deploy");
  if (service.id === "agent-platform") {
    const [containerHubBaseUrl, publicKeySourceFile] = await Promise.all([
      getDesktopManagedAgentPlatformContainerHubBaseUrl(app),
      resolveAgentPlatformDeployPublicKeySourceFile(app, ports)
    ]);
    const desktopCommand = appendAgentPlatformDesktopDeployArgs(
      commandWithConfiguredArgs,
      app,
      layout,
      containerHubBaseUrl,
      publicKeySourceFile
    );
    return appendAgentPlatformRuntimeResourceDeployArgs(
      appendDesktopConfigResetDeployArgs(desktopCommand, desktopConfigReset),
      service,
      desktopConfigReset,
      integrationPorts(ports).getDesktopDeviceId(app)
    );
  }
  if (
    service.id === "agent-container-hub" ||
    service.id === "identity-center" ||
    service.id === "agent-webclient"
  ) {
    return appendDesktopConfigResetDeployArgs(
      appendDesktopDeployOutputDir(commandWithConfiguredArgs, layout),
      desktopConfigReset
    );
  }
  return commandWithConfiguredArgs;
}

export async function ensureMutableInstallDir(
  app: App,
  service: ServiceDefinition,
  ports?: ServicesIntegrationPorts
) {
  const installDir = getInstallDir(app, service);
  if (fs.existsSync(installDir)) {
    return installDir;
  }

  if (service.kind === "builtin") {
    await installBuiltinService(app, service.id, {
      source: "ensureMutableInstallDir",
      integrationPorts: ports
    });
    return getInstallDir(app, service);
  }

  throw new Error(t("service.pluginNotImported", { name: service.name }));
}

export async function installBuiltinService(
  app: App,
  serviceId: ServiceId,
  options: InstallBuiltinServiceOptions = {}
) {
  const service = getService(serviceId);
  if (service.kind !== "builtin") {
    throw new Error(`service ${serviceId} is not a builtin service`);
  }

  const installKey = createBuiltinInstallKey(app, service, options);
  const existingInstall = inFlightBuiltinInstalls.get(installKey);
  if (existingInstall) {
    return existingInstall;
  }

  // Different import/repair options still write the same service program and
  // state directories. Serialize those transactions while deduping identical ones.
  const queueKey = path.dirname(getInstallDir(app, service));
  const previousInstall = builtinInstallQueues.get(queueKey);
  const installTask = (previousInstall ? previousInstall.catch(() => undefined) : Promise.resolve())
    .then(() => installBuiltinServiceInternal(app, service, options));
  const trackedInstallTask = installTask.finally(() => {
    if (inFlightBuiltinInstalls.get(installKey) === trackedInstallTask) {
      inFlightBuiltinInstalls.delete(installKey);
    }
    if (builtinInstallQueues.get(queueKey) === trackedInstallTask) {
      builtinInstallQueues.delete(queueKey);
    }
  });
  builtinInstallQueues.set(queueKey, trackedInstallTask);
  inFlightBuiltinInstalls.set(installKey, trackedInstallTask);
  return trackedInstallTask;
}

async function installBuiltinServiceInternal(
  app: App,
  service: ServiceDefinition,
  options: InstallBuiltinServiceOptions = {}
) {
  const serviceId = service.id;
  const timing = beginStartupTiming("installBuiltinService", {
    serviceId,
    force: Boolean(options.force),
    source: options.source ?? "direct"
  });
  let didExtract = false;
  try {
    if (service.kind !== "builtin") {
      throw new Error(`service ${serviceId} is not a builtin service`);
    }
    const finalInstallDir = getInstallDir(app, service);
    const versionRoot = path.dirname(finalInstallDir);
    await fs.promises.mkdir(versionRoot, { recursive: true });
    await cleanupPreviousExtractions(finalInstallDir, serviceId);
    const assetPath = options.archivePath
      ? await ensureArchiveHealthy(service, options.archivePath, t("service.archivePackageLabel"))
      : await ensureBundleAssetHealthy(app, service);
    const initializationAssetSignature = options.archivePath ? await computeAssetSignature(assetPath) : undefined;

    const layout = getServiceLayout(app, service);
    const needsExtract =
      options.force ||
      !fs.existsSync(finalInstallDir) ||
      !isInstallHealthy(service, finalInstallDir) ||
      await isAssetNewerThanInstall(assetPath, layout, options.archivePath ? undefined : app, service);

    if (needsExtract && serviceId === "agent-platform") await options.integrationPorts?.stopWebappPlatformsForBundleReplacement?.(app);
    await reconcileBuiltinSiblingInstallDirs(app, service, finalInstallDir);

    if (!needsExtract) {
      if (options.skipInitialize) {
        return finalInstallDir;
      }
      const initialization = await initializeServiceInternal(app, serviceId, {
        assetSignatureOverride: initializationAssetSignature,
        integrationPorts: options.integrationPorts
      });
      if (!initialization.ok) {
        throw new Error(initialization.message);
      }
      return finalInstallDir;
    }

    const tempRoot = await fs.promises.mkdtemp(path.join(versionRoot, BUILTIN_EXTRACTION_PREFIX));
    let preserveExtraction = false;
    try {
      let extractedRoot: string;
      if (isDirectoryAssetPath(assetPath)) {
        extractedRoot = await copyDirectoryAssetToTempRoot(assetPath, tempRoot);
      } else {
        await extractArchiveToDir(assetPath, tempRoot);
        const entries = await fs.promises.readdir(tempRoot);
        if (entries.length !== 1) {
          throw new Error(`unexpected archive layout for ${service.id}`);
        }
        extractedRoot = path.join(tempRoot, entries[0]);
      }
      didExtract = true;
      let previousInstall: string | undefined;
      if (fs.existsSync(finalInstallDir)) {
        await stopBuiltinInstallDir(service, finalInstallDir, layout);
        const backupPath = path.join(tempRoot, ".previous-install");
        await fs.promises.writeFile(path.join(tempRoot, ".install-version"), path.basename(finalInstallDir), { flag: "wx" });
        await retryWindowsFileOperation(process.platform, () => fs.promises.rename(finalInstallDir, backupPath));
        previousInstall = backupPath;
      }
      try {
        await moveExtractedBuiltinRoot(extractedRoot, finalInstallDir);
      } catch (error) {
        if (previousInstall) {
          const backupPath = previousInstall;
          try {
            await retryWindowsFileOperation(process.platform, () => fs.promises.rename(backupPath, finalInstallDir));
          } catch (restoreError) {
            preserveExtraction = true;
            throw new AggregateError([error, restoreError], `Builtin publication and rollback failed; previous installation is at ${previousInstall}`, { cause: error });
          }
        }
        throw error;
      }
      if (options.skipInitialize) {
        return finalInstallDir;
      }
      const initialization = await initializeServiceInternal(app, serviceId, {
        assetSignatureOverride: initializationAssetSignature,
        integrationPorts: options.integrationPorts
      });
      if (!initialization.ok) {
        throw new Error(initialization.message);
      }
      return finalInstallDir;
    } finally {
      if (!preserveExtraction) {
        await cleanupBuiltinExtraction(tempRoot, serviceId);
      }
    }
  } finally {
    timing.end({ extracted: didExtract });
  }
}

export async function initializeServiceInternal(
  app: App,
  serviceId: ServiceId,
  options: {
    assetSignatureOverride?: string;
    desktopConfigReset?: DesktopServiceConfigResetContext;
    integrationPorts?: ServicesIntegrationPorts;
  } = {}
): Promise<ServiceCommandResult> {
  const timing = beginStartupTiming("initializeServiceInternal", {
    serviceId
  });
  const checkpoints = beginStartupCheckpoints(serviceId, "initialize");
  const service = getService(serviceId);
  try {
    checkpoints.next("read-initial-state");
    const installDir = getInstallDir(app, service);
    const layout = getServiceLayout(app, service);
    const currentState = await getServiceState(app, serviceId, {
      integrationPorts: options.integrationPorts
    });

    if (!currentState.installed) {
      checkpoints.end("skipped");
      return {
        ok: false,
        message: service.kind === "plugin"
          ? t("service.pluginNotImported", { name: service.name })
          : t("service.notInstalled", { name: service.name }),
        service: currentState
      };
    }

    checkpoints.next("validate-install");
    if (!isInstallHealthy(service, installDir)) {
      checkpoints.end("failed");
      return {
        ok: false,
        message: currentState.message,
        service: currentState
      };
    }

    try {
      checkpoints.next("prepare-execution-layout");
      fixShellScriptPermissions(installDir);
      prepareServiceExecutionLayout(service, layout);
      const serviceDeployOwnsConfig = service.kind === "builtin" && CORE_SERVICE_IDS.has(service.id) && Boolean(service.deployCommand);
      if (!serviceDeployOwnsConfig) {
        ensureDefaultConfig(service, layout);
      }
      if (service.deployCommand) {
        checkpoints.next("build-deploy-command");
        const deployCommand = await buildDesktopManagedDeployCommand(
          app,
          service,
          service.deployCommand,
          layout,
          options.desktopConfigReset,
          options.integrationPorts
        );
        checkpoints.next("build-deploy-env");
        const env = buildDesktopServiceCommandEnv(app, service, layout, undefined, options.integrationPorts);
        checkpoints.next("execute-deploy");
        await runExecFile(deployCommand[0], deployCommand.slice(1), installDir, {
          env,
          timeoutMs: SERVICE_DEPLOY_TIMEOUT_MS
        });
      }
      checkpoints.next("check-initialization-requirements");
      await ensureInitializationRequirements(app, service, layout, options.integrationPorts);
      checkpoints.next("sync-plugin-resources");
      if (service.kind === "plugin" && service.serviceMode === "resource") {
        const desiredStatus = integrationPorts(options.integrationPorts).initializePluginResourceState(app, service);
        if (desiredStatus === "running") {
          await integrationPorts(options.integrationPorts).syncPluginResources(app, service, installDir);
        }
      } else {
        await integrationPorts(options.integrationPorts).syncPluginResources(app, service, installDir);
      }
      checkpoints.next("read-asset-signature");
      const assetSignature = options.assetSignatureOverride ?? await readBuiltinAssetSignature(app, service);
      checkpoints.next("persist-initialization-state");
      writeInitializationState(layout, {
        version: service.version,
        status: "succeeded",
        updatedAt: new Date().toISOString(),
        ...(assetSignature ? { assetSignature } : {})
      });
      if (service.kind === "plugin") {
        integrationPorts(options.integrationPorts).emitPluginBridgeHook("plugin.initialized", { pluginId: service.id });
      }
    } catch (error) {
      checkpoints.end("failed");
      writeInitializationState(layout, {
        version: service.version,
        status: "failed",
        updatedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error)
      });
      const nextState = await getServiceState(app, serviceId, { integrationPorts: options.integrationPorts });
      return {
        ok: false,
        message: nextState.message,
        service: nextState
      };
    }

    checkpoints.next("read-final-state");
    const nextState = await getServiceState(app, serviceId, { integrationPorts: options.integrationPorts });
    checkpoints.end();
    return {
      ok: true,
      message: t("service.initialized", { name: service.name }),
      service: nextState
    };
  } finally {
    checkpoints.end("failed");
    timing.end();
  }
}

export async function ensureInitializationRequirements(
  app: App,
  service: ServiceDefinition,
  layout: ServiceLayout,
  ports?: ServicesIntegrationPorts
) {
  if (CORE_SERVICE_IDS.has(service.id)) {
    return;
  }

  const envPath = layout.envPath;
  const env = readEnvFile(envPath);
  const updates = new Map<string, string>();
  await applyEnvBindings(app, service, env, updates, ports);
  if (updates.size > 0) {
    writeEnvFileUpdates(envPath, updates);
  }
}

export async function initializeService(
  app: App,
  serviceId: ServiceId,
  ports?: ServicesIntegrationPorts
): Promise<ServiceCommandResult> {
  return initializeServiceInternal(app, serviceId, { integrationPorts: ports });
}

export async function resolveAgentPlatformDeployPublicKeySourceFile(
  app: App,
  ports?: ServicesIntegrationPorts
) {
  const capability = await resolveDesktopCapability(app, "auth.publicKey", {
    ports: integrationPorts(ports),
    ensureProviderInstall: async (providerService) => {
      await ensureMutableInstallDir(app, providerService, ports);
    }
  });
  if (capability.filePath && fs.existsSync(capability.filePath) && fs.statSync(capability.filePath).isFile()) {
    return capability.filePath;
  }

  throw new Error("auth.publicKey capability did not produce a usable local public key file.");
}

export async function getDesktopManagedAgentPlatformContainerHubBaseUrl(app: App) {
  const hubPort = await getServicePortForEnvSync(app, "agent-container-hub");
  return `http://127.0.0.1:${hubPort || getService("agent-container-hub").web.defaultPort}`;
}
