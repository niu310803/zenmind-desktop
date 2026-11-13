import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const childProcess = require("node:child_process");
const { loadBuiltinServices } = require("../dist-electron/main/modules/services/builtin-loader.js");
const { isInstallHealthy } = require("../dist-electron/main/modules/services/manager/bundle-assets.js");
const { getServiceLayout } = require("../dist-electron/main/modules/services/manager/layout.js");
const { writeInitializationState } = require("../dist-electron/main/modules/services/manager/state-files.js");
const { writeServicePortDefaultsConfig } = require("../dist-electron/main/modules/services/port-defaults.js");
const { clearServices, getService } = require("../dist-electron/main/modules/services/service-registry.js");
const { openPromise } = require("yauzl");

async function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-windows-builtin-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => clearServices());
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", platform));

  // Keep the fixture's Desktop data and registry lookup independent of the host.
  t.mock.method(childProcess, "execFileSync", () => Buffer.alloc(0));
  const assets = path.join(root, "assets");
  const originalAssetsRoot = process.env.DESKTOP_BUILTIN_ASSETS_ROOT;
  process.env.DESKTOP_BUILTIN_ASSETS_ROOT = assets;
  t.after(() => {
    if (originalAssetsRoot === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_ROOT;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_ROOT = originalAssetsRoot;
    }
  });
  const app = {
    isPackaged: true,
    getPath(name) {
      assert.ok(["home", "appData"].includes(name), name);
      return path.join(root, name);
    }
  };
  const service = {
    id: "identity-center",
    name: "Packaged Identity Center",
    kind: "builtin",
    version: "v1.2.3",
    platform: { os: "windows", arch: "amd64" },
    lifecycle: { start: "start.ps1", stop: "stop.ps1" },
    runtime: { requiredPaths: ["manifest.json", "start.ps1"] }
  };
  const assetFileName = "identity-center-release.zip";
  const assetPath = path.join(assets, service.id, assetFileName);
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  const manifestText = `${JSON.stringify(service, null, 2)}\r\n`;
  const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
  const zip = new JSZip();
  zip.file(`${service.id}/manifest.json`, manifestText);
  zip.file(`${service.id}/start.ps1`, "exit 0");
  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(assetPath, archive);
  const assetSignature = `${archive.length}:${createHash("sha256").update(archive).digest("hex")}`;
  fs.writeFileSync(path.join(assets, "manifest.json"), JSON.stringify({ services: [{
    id: service.id,
    version: service.version,
    assetFileName,
    assetSignature,
    ...(options.legacyIndex ? {} : { manifestSha256 })
  }] }));

  const layout = getServiceLayout(app, service);
  const manifestPath = path.join(layout.programDir, "manifest.json");
  if (!options.freshInstall) {
    fs.mkdirSync(layout.programDir, { recursive: true });
    const installedText = options.installedText?.(service) ?? manifestText;
    fs.writeFileSync(manifestPath, installedText);
    if (!options.missingRuntimeFile) {
      fs.writeFileSync(path.join(layout.programDir, "start.ps1"), "exit 0");
    }
    writeInitializationState(layout, {
      version: service.version,
      status: "succeeded",
      updatedAt: "2026-11-13T00:00:00Z",
      assetSignature: options.receiptSignature ?? assetSignature
    });
  }
  writeServicePortDefaultsConfig(app, {
    schemaVersion: 1,
    services: { "identity-center": { defaultPort: 37076 } }
  });
  return { app, service, assetPath, assetFileName, layout, manifestPath, manifestText };
}

test("matching Windows bundle and manifest signatures reuse the installed definition without opening ZIP", async (t) => {
  const fixture = await createFixture(t);
  const yauzl = require("yauzl");
  const open = t.mock.method(yauzl, "openPromise", (assetPath, ...args) => {
    assert.notEqual(assetPath, fixture.assetPath);
    return openPromise(assetPath, ...args);
  });
  await loadBuiltinServices(fixture.app);

  assert.equal(open.mock.callCount(), 0);
  const definition = getService(fixture.service.id);
  assert.equal(definition.name, fixture.service.name);
  assert.equal(definition.assetFileName, fixture.assetFileName);
  assert.equal(definition.desktop.assetFileName, fixture.assetFileName);
  assert.equal(definition.web.defaultPort, 37076);
});

for (const scenario of [
  { label: "a first install", options: { freshInstall: true } },
  { label: "a legacy index", options: { legacyIndex: true } },
  { label: "a different receipt signature", options: { receiptSignature: "older-bundle" } },
  { label: "a missing required file", options: { missingRuntimeFile: true } },
  {
    label: "a modified manifest",
    options: { installedText: (service) => JSON.stringify({ ...service, name: "Edited Identity Center" }) },
    repair: true
  },
  { label: "an invalid manifest", options: { installedText: () => "{" }, repair: true }
]) {
  test(`Windows loads the bundled manifest for ${scenario.label}`, async (t) => {
    const fixture = await createFixture(t, scenario.options);
    const open = t.mock.method(require("yauzl"), "openPromise", openPromise);
    await loadBuiltinServices(fixture.app);

    assert.deepEqual(open.mock.calls.map(({ arguments: [archivePath] }) => archivePath), [fixture.assetPath]);
    const definition = getService(fixture.service.id);
    assert.equal(definition.name, fixture.service.name);
    assert.equal(definition.assetFileName, fixture.assetFileName);
    if (scenario.repair) {
      assert.equal(isInstallHealthy(definition, fixture.layout.programDir), false);
      fs.writeFileSync(fixture.manifestPath, fixture.manifestText);
      assert.equal(isInstallHealthy(definition, fixture.layout.programDir), true);
    }
  });
}
