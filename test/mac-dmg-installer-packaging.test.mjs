import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import plist from "plist";
import { loadBrandConfig, DARWIN_BUNDLE_LOCALIZATIONS } from "../scripts/lib/brand-model.mjs";
import { electronBuilderConfig } from "../scripts/lib/brand-packaging.mjs";
import {
  MAC_APPLICATIONS_FOLDER_ICON_PATH, buildMacDmgInstaller, macDmgInstallerInfo, macDmgInstallerPath, verifyMacDmgInstaller
} from "../scripts/lib/mac-dmg-installer.mjs";

const require = createRequire(import.meta.url);
const brand = loadBrandConfig(process.cwd(), "cutej");
const hostSignature = {
  teamIdentifier: "ABCDE12345",
  authorities: ["Developer ID Application: Fixture Publisher (ABCDE12345)"]
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-installer-packaging-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "VERSION"), "v0.9.3\n");
  const iconPath = path.join(root, "ApplicationsFolderIcon.icns");
  fs.writeFileSync(iconPath, "fixture Applications folder icon");
  return { root, hostAppPath: path.join(root, "CuteJ.app"), iconPath };
}

function fakeCompiler(commands) {
  return (program, args) => {
    commands.push({ program, args });
    if (args[0] === "swiftc") fs.writeFileSync(args[args.indexOf("-o") + 1], "fixture executable");
    return "";
  };
}

test("both brands provide an independent installer identity and the existing shutdown/data contract", () => {
  for (const brandId of ["cutej", "zenmind"]) {
    const configured = loadBrandConfig(process.cwd(), brandId);
    const info = plist.parse(plist.build(macDmgInstallerInfo(configured, "v0.9.3")));
    assert.equal(info.CFBundleIdentifier, `${configured.appId}.installer`);
    assert.notEqual(info.CFBundleIdentifier, configured.appId);
    assert.equal(info.CFBundleVersion, "0.9.3");
    assert.equal(info.DesktopProductName, configured.productName);
    assert.equal(info.DesktopBundleIdentifier, configured.appId);
    assert.equal(info.DesktopStorageNamespace, configured.storageNamespace);
    assert.equal(info.DesktopShutdownArgument, configured.installer.shutdownArg);
    assert.equal(info.DesktopRuntimeRootDirName, configured.paths.runtimeRootDirName);
    assert.equal(info.DesktopDataSubdirectory, configured.paths.desktopDataSubdir);
    assert.equal(info.DesktopProgramDataDirName, configured.paths.programDataDirName);
    assert.equal(info.CFBundleDisplayName, "Install to Applications");
    assert.deepEqual(info.CFBundleDocumentTypes, [{
      CFBundleTypeName: "macOS Application",
      CFBundleTypeRole: "Viewer",
      LSHandlerRank: "None",
      LSItemContentTypes: ["com.apple.application-bundle"]
    }]);
    assert.equal(info.LSFileQuarantineEnabled, undefined);
    assert.equal(info.CFBundleDocumentTypes[0].CFBundleTypeExtensions, undefined);
  }
});

test("installer compilation signs only its own bundle using the verified host publisher and active CI keychain", t => {
  const { root, hostAppPath, iconPath } = fixture(t);
  const commands = [], verifications = [];
  const output = buildMacDmgInstaller({
    projectRoot: root, brand, hostAppPath, iconPath, platform: "darwin", arch: "arm64", keychain: "/fixture/ci.keychain-db",
    run: fakeCompiler(commands),
    verifyRelease: (app, options) => { verifications.push({ app, options }); return hostSignature; }
  });
  assert.equal(output, macDmgInstallerPath(root, brand));
  const info = plist.parse(fs.readFileSync(path.join(output, "Contents", "Info.plist"), "utf8"));
  assert.equal(info.CFBundleShortVersionString, "0.9.3");
  assert.equal(fs.readFileSync(path.join(output, "Contents", "Resources", "icon.icns"), "utf8"), "fixture Applications folder icon");
  for (const [locale, expectedName] of [["zh-Hans", "安装到应用程序"], ["en", "Install to Applications"]]) {
    assert.ok(DARWIN_BUNDLE_LOCALIZATIONS.includes(locale));
    assert.deepEqual(plist.parse(fs.readFileSync(path.join(output, "Contents", "Resources", `${locale}.lproj`, "InfoPlist.strings"), "utf8")), {
      CFBundleDisplayName: expectedName, CFBundleName: expectedName
    });
  }
  assert.deepEqual(verifications[0], { app: hostAppPath, options: { expectedBundleId: brand.appId } });
  assert.equal(verifications[1].options.expectedBundleId, `${brand.appId}.installer`);
  assert.equal(verifications[1].options.expectedTeamId, hostSignature.teamIdentifier);
  assert.equal(commands[0].program, "/usr/bin/xcrun");
  assert.ok(commands[0].args.includes("arm64-apple-macos12.0"));
  assert.ok(commands[0].args.some(arg => arg.endsWith("InstallerCore.swift")));
  assert.ok(commands[0].args.some(arg => arg.endsWith("main.swift")));
  const signing = commands[1];
  assert.equal(signing.program, "/usr/bin/codesign");
  assert.equal(signing.args[signing.args.indexOf("--sign") + 1], hostSignature.authorities[0]);
  assert.equal(signing.args[signing.args.indexOf("--keychain") + 1], "/fixture/ci.keychain-db");
  assert.ok(signing.args.includes("--timestamp"));
  assert.ok(signing.args.includes("runtime"));
  assert.notEqual(signing.args.at(-1), hostAppPath);
});

test("a private build umask does not restrict the distributed installer to its build user", { skip: process.platform === "win32" }, t => {
  const { root, hostAppPath, iconPath } = fixture(t);
  const originalMask = process.umask(0o077);
  let output;
  try {
    output = buildMacDmgInstaller({
      projectRoot: root, brand, hostAppPath, iconPath, platform: "darwin", run: fakeCompiler([]), verifyRelease: () => hostSignature
    });
  } finally { process.umask(originalMask); }
  for (const relative of ["", "Contents", "Contents/MacOS", "Contents/Resources", "Contents/Resources/zh-Hans.lproj"]) {
    assert.equal(fs.statSync(path.join(output, relative)).mode & 0o777, 0o755);
  }
  for (const relative of ["Contents/Info.plist", "Contents/Resources/icon.icns", "Contents/Resources/zh-Hans.lproj/InfoPlist.strings"]) {
    assert.equal(fs.statSync(path.join(output, relative)).mode & 0o777, 0o644);
  }
});

test("production receiver uses the macOS Applications folder icon", { skip: process.platform !== "darwin" }, t => {
  const { root, hostAppPath } = fixture(t);
  assert.ok(fs.existsSync(MAC_APPLICATIONS_FOLDER_ICON_PATH));
  const expectedIcon = fs.readFileSync(MAC_APPLICATIONS_FOLDER_ICON_PATH);
  assert.equal(expectedIcon.subarray(0, 4).toString(), "icns");
  const app = buildMacDmgInstaller({
    projectRoot: root, brand, hostAppPath, run: fakeCompiler([]), verifyRelease: () => hostSignature
  });
  const copiedIcon = path.join(app, "Contents", "Resources", "icon.icns");
  assert.ok(fs.readFileSync(copiedIcon).equals(expectedIcon));
  verifyMacDmgInstaller({ projectRoot: root, brand, hostAppPath, verifyRelease: () => hostSignature });
  fs.writeFileSync(copiedIcon, "brand app icon must not replace the folder target");
  assert.throws(() => verifyMacDmgInstaller({ projectRoot: root, brand, hostAppPath, verifyRelease: () => hostSignature }), /Applications folder icon/u);
});

test("a missing folder icon fails before native compilation or signing", t => {
  const { root, hostAppPath } = fixture(t);
  assert.throws(() => buildMacDmgInstaller({
    projectRoot: root, brand, hostAppPath, platform: "darwin", iconPath: path.join(root, "missing-folder.icns"),
    run: () => assert.fail("missing production input must not reach the compiler"),
    verifyRelease: () => assert.fail("missing production input must not reach signing")
  }), /Applications folder icon/u);
});

test("a failed compiler or mismatched installer publisher preserves the prior generated installer", t => {
  const { root, hostAppPath, iconPath } = fixture(t);
  const output = macDmgInstallerPath(root, brand);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "prior.txt"), "prior valid installer");
  for (const failure of ["compiler", "publisher"]) {
    assert.throws(() => buildMacDmgInstaller({
      projectRoot: root, brand, hostAppPath, iconPath, platform: "darwin", arch: "x64",
      run: (program, args) => {
        if (failure === "compiler") throw new Error("compiler failure");
        return fakeCompiler([])(program, args);
      },
      verifyRelease: (app) => {
        if (app !== hostAppPath) throw new Error("publisher mismatch");
        return hostSignature;
      }
    }), failure === "compiler" ? /compiler failure/u : /publisher mismatch/u);
    assert.equal(fs.readFileSync(path.join(output, "prior.txt"), "utf8"), "prior valid installer");
    assert.equal(fs.readdirSync(path.dirname(output)).some(name => name.startsWith(".native-installer-")), false);
  }
});

test("release verification rejects an installer carrying another brand's shutdown or data layout", t => {
  const { root, hostAppPath, iconPath } = fixture(t);
  const output = buildMacDmgInstaller({
    projectRoot: root, brand, hostAppPath, iconPath, platform: "darwin", run: fakeCompiler([]), verifyRelease: () => hostSignature
  });
  const infoFile = path.join(output, "Contents", "Info.plist");
  const info = plist.parse(fs.readFileSync(infoFile, "utf8"));
  info.DesktopRuntimeRootDirName = ".another-brand";
  fs.writeFileSync(infoFile, plist.build(info));
  assert.throws(() => verifyMacDmgInstaller({
    projectRoot: root, brand, hostAppPath, iconPath,
    verifyRelease: () => assert.fail("invalid metadata must fail before release acceptance")
  }), /DesktopRuntimeRootDirName/u);
});

test("release verification rejects missing or unexpected localized receiver names", t => {
  const { root, hostAppPath, iconPath } = fixture(t);
  for (const locale of DARWIN_BUNDLE_LOCALIZATIONS) {
    const output = buildMacDmgInstaller({
      projectRoot: root, brand, hostAppPath, iconPath, platform: "darwin", run: fakeCompiler([]), verifyRelease: () => hostSignature
    });
    const localizedFile = path.join(output, "Contents", "Resources", `${locale}.lproj`, "InfoPlist.strings");
    fs.writeFileSync(localizedFile, plist.build({ CFBundleDisplayName: "Install Another Brand", CFBundleName: "Install Another Brand" }));
    assert.throws(() => verifyMacDmgInstaller({ projectRoot: root, brand, hostAppPath, iconPath, verifyRelease: () => hostSignature }), /localized name/u);
    fs.rmSync(localizedFile);
    assert.throws(() => verifyMacDmgInstaller({ projectRoot: root, brand, hostAppPath, iconPath, verifyRelease: () => hostSignature }), /ENOENT/u);
  }
});

test("native Bundle selects the Chinese and English installer display names", { skip: process.platform !== "darwin" }, t => {
  const { root, hostAppPath, iconPath } = fixture(t);
  const app = buildMacDmgInstaller({
    projectRoot: root, brand, hostAppPath, iconPath, run: fakeCompiler([]), verifyRelease: () => hostSignature
  });
  // Use a tiny native reader inside this temporary fixture as the main bundle,
  // so Foundation applies the same InfoPlist localization lookup as Finder.
  const source = path.join(root, "inspect.swift");
  fs.writeFileSync(source, "import Foundation\nprint(Bundle.main.localizedInfoDictionary?[\"CFBundleDisplayName\"] ?? \"missing\")\n");
  const executable = path.join(app, "Contents", "MacOS", "DesktopInstaller");
  execFileSync("/usr/bin/xcrun", ["swiftc", source, "-o", executable], { timeout: 60_000 });
  for (const [locale, expectedName] of [["zh-Hans", "安装到应用程序"], ["en", "Install to Applications"]]) {
    const name = execFileSync(executable, ["-AppleLanguages", `(${locale})`], { encoding: "utf8", timeout: 10_000 }).trim();
    assert.equal(name, expectedName);
  }
});

test("the builder hook is loadable by the installed electron-builder and skips Windows", async () => {
  const { resolveFunction } = require("app-builder-lib/out/platformPackager.js");
  const hook = await resolveFunction(undefined, path.resolve("scripts/lib/mac-dmg-installer.mjs"), "afterSign");
  assert.equal(typeof hook, "function");
  await hook({ electronPlatformName: "win32", get packager() { assert.fail("Windows must not access native signing"); } });
  assert.throws(() => buildMacDmgInstaller({ projectRoot: "unused", brand, version: "0.9.3", platform: "win32" }), /Windows/u);
});

test("DMG keeps the classic two-icon layout with a folder-shaped application receiver", async () => {
  const config = electronBuilderConfig(brand, { os: "darwin", arch: "arm64" });
  assert.equal(config.afterSign, "./scripts/lib/mac-dmg-installer.mjs");
  assert.equal(config.dmg.artifactName, "${productName}-${version}-${arch}.${ext}");
  assert.deepEqual(config.dmg.window, { width: 540, height: 380 });
  assert.equal(config.dmg.contents.length, 2);
  assert.deepEqual(config.dmg.contents[0], { x: 130, y: 220 });
  assert.deepEqual(config.dmg.contents[1], {
    x: 410, y: 220, type: "dir", path: "build/brands/cutej/installer/Install CuteJ.app"
  });
  assert.equal(config.dmg.contents.some(item => item.type === "link"), false);
  assert.equal(config.win.target[0], "nsis");
  assert.equal(config.nsis.include, "build/brands/cutej/installer/installer.nsh");
  assert.equal(config.extraResources.some(resource => resource.from.includes("Install CuteJ.app")), false);
  const { validateConfig } = require("app-builder-lib/out/util/config.js");
  await validateConfig(config, { isEnabled: false });
  await validateConfig(electronBuilderConfig(brand, { os: "win32", arch: "x64" }), { isEnabled: false });
});
