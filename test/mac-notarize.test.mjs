import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertMacNotarizationHost,
  buildNotaryToolAuthArgs,
  resolveMacDmgArtifactPath
} from "../scripts/lib/mac-notarize.mjs";

test("notarytool auth args prefer keychain profile credentials", () => {
  assert.deepEqual(
    buildNotaryToolAuthArgs({
      APPLE_KEYCHAIN_PROFILE: "zenmind-notary"
    }),
    ["--keychain-profile", "zenmind-notary"]
  );
  assert.deepEqual(
    buildNotaryToolAuthArgs({
      APPLE_KEYCHAIN: "/Users/me/Library/Keychains/login.keychain-db",
      APPLE_KEYCHAIN_PROFILE: "zenmind-notary"
    }),
    ["--keychain", "/Users/me/Library/Keychains/login.keychain-db", "--keychain-profile", "zenmind-notary"]
  );
});

test("notarytool auth args validate partial credential groups", () => {
  assert.equal(buildNotaryToolAuthArgs({}), null);
  assert.throws(
    () => buildNotaryToolAuthArgs({ APPLE_ID: "dev@example.com" }),
    /APPLE_APP_SPECIFIC_PASSWORD/u
  );
  assert.throws(
    () => buildNotaryToolAuthArgs({ APPLE_API_KEY: "/tmp/AuthKey_TEST.p8", APPLE_API_KEY_ID: "KEYID" }),
    /APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER/u
  );
  assert.throws(
    () => buildNotaryToolAuthArgs({ APPLE_KEYCHAIN: "/tmp/login.keychain-db" }),
    /APPLE_KEYCHAIN_PROFILE/u
  );
});

test("mac DMG artifact resolves the current manual build without updater metadata", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-mac-dmg-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "dist", "zenmind");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(root, "VERSION"), "v0.3.5\n", "utf8");
  fs.writeFileSync(path.join(outputDir, "ZenMind-0.3.5-arm64.dmg"), "fake dmg\n", "utf8");

  assert.equal(
    resolveMacDmgArtifactPath(root, { id: "zenmind", productName: "ZenMind" }),
    path.join(outputDir, "ZenMind-0.3.5-arm64.dmg")
  );
  // An old publisher file must not cause notarization of a previous release.
  fs.writeFileSync(path.join(outputDir, "latest-mac.yml"), "path: ZenMind-0.3.4-arm64.dmg\n", "utf8");
  fs.writeFileSync(path.join(outputDir, "ZenMind-0.3.4-arm64.dmg"), "old dmg\n", "utf8");
  assert.equal(resolveMacDmgArtifactPath(root, { id: "zenmind", productName: "ZenMind" }),
    path.join(outputDir, "ZenMind-0.3.5-arm64.dmg"));
  fs.rmSync(path.join(outputDir, "ZenMind-0.3.5-arm64.dmg"));
  assert.throws(() => resolveMacDmgArtifactPath(root, { id: "zenmind", productName: "ZenMind" }), /DMG artifact not found/u);
});

test("mac DMG artifact respects its target architecture and rejects unsafe build identity", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-mac-dmg-target-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "VERSION"), "v0.3.5\n", "utf8");
  fs.mkdirSync(path.join(root, "dist", "cutej"), { recursive: true });
  const expected = path.join(root, "dist", "cutej", "CuteJ-0.3.5-x64.dmg");
  fs.writeFileSync(expected, "x64 fixture");
  assert.equal(resolveMacDmgArtifactPath(root, { id: "cutej", productName: "CuteJ" }, { arch: "x64" }), expected);
  for (const brand of [{ id: "../other", productName: "CuteJ" }, { id: "cutej", productName: "../Other" }]) {
    assert.throws(() => resolveMacDmgArtifactPath(root, brand), /Invalid macOS DMG build identity/u);
  }
});

test("mac notarization host check branches explicitly by platform", () => {
  assert.doesNotThrow(() => assertMacNotarizationHost("darwin"));
  assert.throws(() => assertMacNotarizationHost("win32"), /Windows cannot run xcrun notarytool/u);
  assert.throws(() => assertMacNotarizationHost("linux"), /linux cannot run xcrun notarytool/u);
});
