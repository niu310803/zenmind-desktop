import fs from "node:fs";
import path from "node:path";
import { type ServiceDefinition } from "../../../support/manifest/manifest-utils";
import {
  type ServiceLayout,
  getInitializationStatePath,
  getInstallDir,
  getServiceLayout,
  resolveConfigPath,
  resolveConfigTemplatePath
} from "./layout";
import { type App } from "electron";
import { readInitializationState } from "./state-files";
import { computeAssetSignature, ensureBundleAssetHealthy, getBuiltinAssetPath, readSyncedBuiltinAssetSignature } from "./bundle-assets";

export function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

export function isDirectoryAssetPath(assetPath: string) {
  return fs.existsSync(assetPath) && fs.statSync(assetPath).isDirectory();
}

export async function copyDirectoryAssetToTempRoot(assetPath: string, tempRoot: string) {
  const targetRoot = path.join(tempRoot, path.basename(assetPath));
  await fs.promises.cp(assetPath, targetRoot, { recursive: true, force: true });
  return targetRoot;
}

export function prepareServiceExecutionLayout(_service: ServiceDefinition, layout: ServiceLayout) {
  ensureDir(layout.configDir);
  ensureDir(layout.dataDir);
  ensureDir(layout.stateDir);
  ensureDir(layout.logDir);
}

export async function isAssetNewerThanInstall(
  assetPath: string,
  layout: ServiceLayout,
  app?: App,
  service?: ServiceDefinition
) {
  try {
    const initStatePath = getInitializationStatePath(layout);
    if (!fs.existsSync(initStatePath)) {
      return true;
    }
    const initializationState = readInitializationState(layout);
    if (initializationState?.assetSignature) {
      const bundledSignature = app && service ? readSyncedBuiltinAssetSignature(app, service) : undefined;
      const assetSignature = bundledSignature ?? await computeAssetSignature(assetPath);
      return initializationState.assetSignature !== assetSignature;
    }
    const assetMtime = fs.statSync(assetPath).mtimeMs;
    return assetMtime > fs.statSync(initStatePath).mtimeMs;
  } catch {
    return true;
  }
}

export async function needsBundledAssetRefresh(app: App, service: ServiceDefinition) {
  if (service.kind !== "builtin") {
    return false;
  }

  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  try {
    const assetPath = getBuiltinAssetPath(app, service);
    if (fs.existsSync(installDir) && !await isAssetNewerThanInstall(assetPath, layout, app, service)) {
      return false;
    }
    await ensureBundleAssetHealthy(app, service);
    return true;
  } catch {
    return false;
  }
}

export function ensureDefaultConfig(service: ServiceDefinition, layout: ServiceLayout) {
  for (const configFile of service.configFiles) {
    const targetPath = resolveConfigPath(layout, configFile.relativePath);
    if (fs.existsSync(targetPath)) {
      continue;
    }
    if (!configFile.templateRelativePath) {
      continue;
    }
    const templatePath = resolveConfigTemplatePath(layout, configFile.templateRelativePath);
    if (fs.existsSync(templatePath)) {
      ensureDir(path.dirname(targetPath));
      fs.copyFileSync(templatePath, targetPath);
    }
  }
}
