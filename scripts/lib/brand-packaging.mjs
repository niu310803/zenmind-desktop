import fs from "node:fs";
import path from "node:path";
import { desktopBuiltinServicesRelativePath, desktopNodeRuntimeRelativePath } from "./desktop-resources.mjs";
import { macDocumentFileAssociations } from "./document-file-associations.mjs";
import {
  BRAND_RUNTIME_ASSET_DIR_NAME,
  DARWIN_BUNDLE_DEVELOPMENT_REGION,
  DARWIN_BUNDLE_LOCALIZATIONS,
  SUPPORTED_LOCALES
} from "./brand-model.mjs";
import {
  brandBuildRelativePath,
  brandBuildTargetKey,
  currentBrandBuildTarget,
  electronBuilderConfigPath
} from "./brand-paths.mjs";
import { buildNotaryToolAuthArgs } from "./mac-notarize.mjs";

function parseBooleanEnv(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${name} must be a boolean value`);
  }
}

function shouldSkipMacTimestamp(env = process.env) {
  return (
    parseBooleanEnv(env.SKIP_NOTARIZE, "SKIP_NOTARIZE") === true ||
    parseBooleanEnv(env.DESKTOP_SKIP_MAC_TIMESTAMP, "DESKTOP_SKIP_MAC_TIMESTAMP") === true
  );
}

export function shouldBuildMacDmgInstaller(env = process.env, { validateNotaryConfig = false } = {}) {
  // A quarantined DMG can only launch the install helper if it passes Gatekeeper.
  if (shouldSkipMacTimestamp(env)) return false;
  try {
    return buildNotaryToolAuthArgs(env) !== null;
  } catch (error) {
    // Brand sync also runs for development builds, where partial credentials are harmless.
    if (validateNotaryConfig) throw error;
    return false;
  }
}

function writeFileIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) {
    return;
  }
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath, value) {
  writeFileIfChanged(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function nodeRuntimeResourceFilters(target) {
  const filters = ["npm/**/*"];
  if (target.os === "win32") {
    if (target.arch === "x64" || target.arch === "amd64") filters.push("amd64/node.exe");
    else if (target.arch === "arm64") filters.push("arm64/node.exe");
    else throw new Error(`Unsupported Windows Node launcher architecture: ${target.arch}`);
  }
  return filters;
}

export function electronBuilderConfig(brand, target = currentBrandBuildTarget(), env = process.env) {
  const useMacDmgInstaller = target.os === "darwin" && shouldBuildMacDmgInstaller(env);
  return {
    appId: brand.appId,
    productName: brand.productName,
    protocols: [
      {
        name: `${brand.productName} Open`,
        schemes: [brand.protocols.open.scheme]
      }
    ],
    directories: {
      app: brandBuildRelativePath(brand, "app", brandBuildTargetKey(target)),
      output: path.posix.join("dist", brand.id)
    },
    files: [
      "dist-renderer/**/*",
      "dist-electron/**/*",
      "package.json",
      "node_modules/**/*",
      "!node_modules/@napi-rs/canvas-linux-*",
      "!node_modules/@napi-rs/canvas-linux-*/**/*",
      "!node_modules/**/*.d.ts",
      "!node_modules/**/*.map"
    ],
    asarUnpack: [
      "node_modules/@napi-rs/canvas-*/**/*",
      "node_modules/@koromix/koffi-*/**/*"
    ],
    npmRebuild: false,
    extraResources: [
      { from: "resources/chrome-extension", to: "resources/chrome-extension" },
      { from: desktopNodeRuntimeRelativePath(), to: "node-runtime", filter: nodeRuntimeResourceFilters(target) },
      {
        from: desktopBuiltinServicesRelativePath(),
        to: "services"
      },
      {
        from: brandBuildRelativePath(brand, "resources", "env"),
        to: "env"
      },
      {
        from: brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "brand-icon.png"),
        to: "brand-icon.png"
      },
      {
        from: brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "brand-mark.png"),
        to: "brand-mark.png"
      },
      {
        from: brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "tray-icon.png"),
        to: "tray-icon.png"
      },
      {
        from: brandBuildRelativePath(brand, "installer", "uninstall.sh"),
        to: "uninstall.sh"
      }
    ],
    mac: {
      icon: brandBuildRelativePath(brand, "icons", "icon.icns"),
      fileAssociations: macDocumentFileAssociations(),
      extendInfo: {
        CFBundleDevelopmentRegion: DARWIN_BUNDLE_DEVELOPMENT_REGION,
        CFBundleLocalizations: DARWIN_BUNDLE_LOCALIZATIONS,
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
        NSMicrophoneUsageDescription: brand.mac.microphoneUsageDescription,
        NSSpeechRecognitionUsageDescription: brand.mac.speechRecognitionUsageDescription
      },
      target: ["dmg"],
      category: "public.app-category.developer-tools",
      forceCodeSigning: true,
      type: "distribution",
      hardenedRuntime: true,
      sign: "./scripts/sign-mac-app.js",
      notarize: false,
      timestamp: shouldSkipMacTimestamp(env) ? "none" : undefined
    },
    electronLanguages: SUPPORTED_LOCALES,
    afterPack: "./scripts/after-pack.js",
    afterSign: useMacDmgInstaller
      ? "./scripts/lib/mac-dmg-installer.mjs"
      : "./scripts/verify-mac-services-signing.js",
    dmg: {
      artifactName: "${productName}-${version}-${arch}.${ext}",
      backgroundColor: "#f5f5f7",
      window: { width: 540, height: 380 },
      iconSize: 80,
      contents: [
        { x: 130, y: 220 },
        useMacDmgInstaller ? {
          x: 410, y: 220, type: "dir",
          path: brandBuildRelativePath(brand, "installer", `Install ${brand.productName}.app`)
        } : { x: 410, y: 220, type: "link", path: "/Applications" }
      ]
    },
    win: {
      icon: brandBuildRelativePath(brand, "icons", "icon.ico"),
      // NSIS registers OpenWithProgids in our include; builder's association macro changes defaults.
      fileAssociations: [],
      signAndEditExecutable: true,
      target: ["nsis"]
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      include: brandBuildRelativePath(brand, "installer", "installer.nsh")
    }
  };
}

export function writeElectronBuilderConfig(rootDir, brand, target) {
  writeJson(electronBuilderConfigPath(rootDir, brand.id), electronBuilderConfig(brand, target));
}
