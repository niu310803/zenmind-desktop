import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import plist from "plist";
import { readDesktopVersion } from "./build-metadata.mjs";
import { loadBrandConfig, DARWIN_BUNDLE_DEVELOPMENT_REGION, DARWIN_BUNDLE_LOCALIZATIONS } from "./brand-model.mjs";
import { brandIconDir, brandInstallerDir } from "./brand-paths.mjs";
import { verifyMacReleaseApp } from "./mac-app-signing.js";

export const MAC_DMG_INSTALLER_EXECUTABLE = "DesktopInstaller";
export const macDmgInstallerSourceRoot = fileURLToPath(new URL("../../native/macos-installer/", import.meta.url));

export function macDmgInstallerName(brand) {
  if (typeof brand?.productName !== "string" || !brand.productName.trim() ||
      /[\x00-\x1f/\\]/u.test(brand.productName)) {
    throw new Error("macOS installer requires a valid brand product name");
  }
  return `Install ${brand.productName}.app`;
}

export function macDmgInstallerPath(projectRoot, brand) {
  return path.join(brandInstallerDir(projectRoot, brand), macDmgInstallerName(brand));
}

export function macDmgInstallerInfo(brand, version) {
  macDmgInstallerName(brand);
  const normalizedVersion = String(version || "").replace(/^v/iu, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][a-z\d.+-]+)?$/iu.test(normalizedVersion)) {
    throw new Error("macOS installer requires the Desktop version");
  }
  const requiredFields = {
    DesktopProductName: brand.productName,
    DesktopBundleIdentifier: brand.appId,
    DesktopStorageNamespace: brand.storageNamespace,
    DesktopShutdownArgument: brand.installer?.shutdownArg,
    DesktopRuntimeRootDirName: brand.paths?.runtimeRootDirName,
    DesktopDataSubdirectory: brand.paths?.desktopDataSubdir,
    DesktopProgramDataDirName: brand.paths?.programDataDirName
  };
  if (Object.values(requiredFields).some(value => typeof value !== "string" || !value.trim())) {
    throw new Error("macOS installer requires the complete brand installation contract");
  }
  return {
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: `Install ${brand.productName}`,
    CFBundleDisplayName: `Install ${brand.productName}`,
    CFBundleIdentifier: `${brand.appId}.installer`,
    CFBundleExecutable: MAC_DMG_INSTALLER_EXECUTABLE,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: normalizedVersion,
    CFBundleVersion: normalizedVersion,
    CFBundleDevelopmentRegion: DARWIN_BUNDLE_DEVELOPMENT_REGION,
    CFBundleLocalizations: DARWIN_BUNDLE_LOCALIZATIONS,
    CFBundleIconFile: "icon.icns",
    LSMinimumSystemVersion: "12.0",
    NSHighResolutionCapable: true,
    ...requiredFields
  };
}

function installerLocalizedInfo(brand, locale) {
  const label = `${locale === "zh-Hans" ? "安装" : "Install"} ${brand.productName}`;
  return { CFBundleDisplayName: label, CFBundleName: label };
}

function command(program, args, options = {}) {
  return execFileSync(program, args, {
    encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], ...options
  });
}

function assertInstallerContents(appPath, brand, version) {
  if (fs.lstatSync(appPath).isSymbolicLink()) throw new Error("macOS installer must be a regular application bundle");
  const contents = path.join(appPath, "Contents");
  const info = plist.parse(fs.readFileSync(path.join(contents, "Info.plist"), "utf8"));
  const expected = macDmgInstallerInfo(brand, version);
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(info[key]) !== JSON.stringify(value)) {
      throw new Error(`macOS installer brand contract does not match: ${key}`);
    }
  }
  const executable = path.join(contents, "MacOS", MAC_DMG_INSTALLER_EXECUTABLE);
  if (!fs.lstatSync(executable).isFile()) throw new Error("macOS installer executable must be a regular file");
  fs.accessSync(executable, fs.constants.X_OK);
  if (!fs.statSync(path.join(contents, "Resources", "icon.icns")).size) throw new Error("macOS installer icon is missing");
  for (const locale of DARWIN_BUNDLE_LOCALIZATIONS) {
    const file = path.join(contents, "Resources", `${locale}.lproj`, "InfoPlist.strings");
    const localized = plist.parse(fs.readFileSync(file, "utf8"));
    if (JSON.stringify(localized) !== JSON.stringify(installerLocalizedInfo(brand, locale))) {
      throw new Error(`macOS installer localized name does not match its brand: ${locale}`);
    }
  }
}

export function verifyMacDmgInstaller({
  projectRoot, brand, hostAppPath, appPath = macDmgInstallerPath(projectRoot, brand),
  version = readDesktopVersion(projectRoot), verifyRelease = verifyMacReleaseApp
}) {
  assertInstallerContents(appPath, brand, version);
  const host = verifyRelease(hostAppPath, { expectedBundleId: brand.appId });
  return verifyRelease(appPath, { expectedBundleId: `${brand.appId}.installer`, expectedTeamId: host.teamIdentifier });
}

/** Build the DMG-only installer after the host app has been signed. */
export function buildMacDmgInstaller({
  projectRoot, brand, hostAppPath, arch = process.arch, version = readDesktopVersion(projectRoot),
  platform = process.platform, keychain, timestamp, run = command, verifyRelease = verifyMacReleaseApp
}) {
  if (platform === "win32") throw new Error("Windows must not build the macOS DMG installer");
  if (platform !== "darwin") throw new Error("macOS DMG installer can only be built on macOS");
  if (arch !== "arm64" && arch !== "x64") throw new Error(`Unsupported macOS installer architecture: ${arch}`);
  const info = macDmgInstallerInfo(brand, version);
  const host = verifyRelease(hostAppPath, { expectedBundleId: brand.appId });
  const identity = host.authorities.find(authority => authority.startsWith("Developer ID Application:"));
  if (!identity) throw new Error("macOS installer requires its host's Developer ID Application signing identity");
  const output = macDmgInstallerPath(projectRoot, brand);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stagingRoot = fs.mkdtempSync(path.join(path.dirname(output), ".native-installer-"));
  const stagedApp = path.join(stagingRoot, macDmgInstallerName(brand));
  const contents = path.join(stagedApp, "Contents");
  const executable = path.join(contents, "MacOS", MAC_DMG_INSTALLER_EXECUTABLE);
  const moduleCache = path.join(projectRoot, "build", "macos-installer-module-cache", arch);
  try {
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.mkdirSync(moduleCache, { recursive: true });
    run("/usr/bin/xcrun", [
      "swiftc", "-O", "-module-name", "DesktopInstaller",
      "-target", `${arch === "x64" ? "x86_64" : "arm64"}-apple-macos12.0`,
      "-module-cache-path", moduleCache,
      path.join(macDmgInstallerSourceRoot, "InstallerCore.swift"),
      path.join(macDmgInstallerSourceRoot, "main.swift"),
      "-o", executable, "-framework", "AppKit", "-framework", "Security",
      "-Xlinker", "-rpath", "-Xlinker", "/usr/lib/swift"
    ], { timeout: 300_000 });
    fs.chmodSync(executable, 0o755);
    fs.writeFileSync(path.join(contents, "Info.plist"), plist.build(info));
    const resources = path.join(contents, "Resources");
    fs.mkdirSync(resources, { recursive: true });
    fs.copyFileSync(path.join(brandIconDir(projectRoot, brand), "icon.icns"), path.join(resources, "icon.icns"));
    for (const locale of DARWIN_BUNDLE_LOCALIZATIONS) {
      const localized = path.join(resources, `${locale}.lproj`);
      fs.mkdirSync(localized, { recursive: true });
      fs.writeFileSync(path.join(localized, "InfoPlist.strings"), plist.build(installerLocalizedInfo(brand, locale)));
    }
    // A private build-log umask must not make the distributed app accessible
    // only to the build account after another user mounts the disk image.
    for (const directory of [stagedApp, contents, path.dirname(executable), resources,
      ...DARWIN_BUNDLE_LOCALIZATIONS.map(locale => path.join(resources, `${locale}.lproj`))]) fs.chmodSync(directory, 0o755);
    for (const file of [path.join(contents, "Info.plist"), path.join(resources, "icon.icns"),
      ...DARWIN_BUNDLE_LOCALIZATIONS.map(locale => path.join(resources, `${locale}.lproj`, "InfoPlist.strings"))]) fs.chmodSync(file, 0o644);
    run("/usr/bin/codesign", [
      "--force", "--sign", identity,
      ...(keychain ? ["--keychain", keychain] : []),
      timestamp === "none" ? "--timestamp=none" : timestamp ? `--timestamp=${timestamp}` : "--timestamp",
      "--options", "runtime", stagedApp
    ]);
    assertInstallerContents(stagedApp, brand, version);
    verifyRelease(stagedApp, { expectedBundleId: info.CFBundleIdentifier, expectedTeamId: host.teamIdentifier });
    fs.rmSync(output, { recursive: true, force: true });
    fs.renameSync(stagedApp, output);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
  return output;
}

export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  // Keep the existing release gates, then sign the installer while builder's
  // imported CI keychain is still available. The signed host is never modified.
  const verifyHost = await import("../verify-mac-services-signing.js");
  await verifyHost.default.default(context);
  const projectRoot = context.packager.projectDir;
  const brand = loadBrandConfig(projectRoot, process.env.BRAND);
  if (brand.appId !== context.packager.appInfo.id) throw new Error("macOS installer brand does not match the signed host");
  const signing = await context.packager.codeSigningInfo.value;
  buildMacDmgInstaller({
    projectRoot, brand,
    hostAppPath: path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
    arch: context.arch === 3 ? "arm64" : context.arch === 1 ? "x64" : context.arch,
    keychain: signing.keychainFile,
    timestamp: context.packager.platformSpecificBuildOptions.timestamp
  });
}
