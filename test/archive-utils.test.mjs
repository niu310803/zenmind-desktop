import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const {
  extractArchiveToDir,
  listArchiveEntries,
  readFileFromArchive
} = require("../dist-electron/main/support/archive/archive-utils.js");
const { readManifestFromArchive } = require("../dist-electron/main/support/manifest/manifest-utils.js");

async function writeZipArchive(archivePath, entries, options = {}) {
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.file(entryPath, content);
  }
  fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer", ...options }));
}

test("zip entry listings larger than 1 MiB remain complete", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-archive-large-list-"));
  const archivePath = path.join(tempRoot, "large.zip");
  const zip = new JSZip();
  const expected = Array.from({ length: 11000 }, (_, index) =>
    `bundle/libexec/git-bash/windows-amd64/usr/share/resources/${"x".repeat(60)}/${index}.txt`
  );
  for (const name of expected) {
    zip.file(name, "", { createFolders: false });
  }
  assert.ok(Buffer.byteLength(expected.join("\n")) > 1024 * 1024);
  try {
    fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    const actual = await listArchiveEntries(archivePath);
    assert.equal(actual.size, expected.length);
    for (const name of expected) assert.ok(actual.has(name), name);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Windows-style ZIP metadata is read without opening unrelated file payloads", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-archive-selective-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archivePath = path.join(root, "内置服务.zip");
  const manifest = { id: "fixture", name: "平台服务", version: "v1.0.0" };
  await writeZipArchive(archivePath, {
    "bundle\\engine.exe": "This entry's local header is damaged",
    "bundle\\manifest.json": `\uFEFF${JSON.stringify(manifest)}`,
    "bundle\\中文.txt": "中文"
  }, { compression: "DEFLATE" });
  const buffer = fs.readFileSync(archivePath);
  assert.equal(buffer.readUInt32LE(0), 0x04034b50);
  buffer.writeUInt32LE(0, 0);
  fs.writeFileSync(archivePath, buffer);

  const originalReadFile = fs.readFile;
  const originalReadFileSync = fs.readFileSync;
  const originalReadFileAsync = fs.promises.readFile;
  t.mock.method(fs, "readFile", (target, ...args) => {
    assert.notEqual(target, archivePath, "ZIP must use random-access reads");
    return originalReadFile(target, ...args);
  });
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    assert.notEqual(target, archivePath, "ZIP must use random-access reads");
    return originalReadFileSync(target, ...args);
  });
  t.mock.method(fs.promises, "readFile", (target, ...args) => {
    assert.notEqual(target, archivePath, "ZIP must use random-access reads");
    return originalReadFileAsync(target, ...args);
  });

  const entries = await listArchiveEntries(archivePath);
  assert.ok(entries.has("bundle/engine.exe"));
  assert.ok(entries.has("bundle/中文.txt"));
  assert.deepEqual(await readManifestFromArchive(archivePath), manifest);
  assert.equal(await readFileFromArchive(archivePath, "bundle\\中文.txt"), "中文");
  await assert.rejects(readFileFromArchive(archivePath, "bundle/engine.exe"), /local file header/iu);
});

test("ZIP metadata rejects traversal and a damaged manifest checksum", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-archive-invalid-metadata-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archivePath = path.join(root, "invalid.zip");
  await writeZipArchive(archivePath, { "../manifest.json": "{}" });
  await assert.rejects(listArchiveEntries(archivePath), /invalid relative path/iu);
  await assert.rejects(readManifestFromArchive(archivePath), /invalid relative path/iu);

  await writeZipArchive(archivePath, { "manifest.json": '{"id":"test"}' });
  const archive = fs.readFileSync(archivePath);
  const eocdOffset = archive.length - 22;
  assert.equal(archive.readUInt32LE(eocdOffset), 0x06054b50);
  const directoryOffset = archive.readUInt32LE(eocdOffset + 16);
  assert.equal(archive.readUInt32LE(directoryOffset), 0x02014b50);
  archive.writeUInt32LE((archive.readUInt32LE(directoryOffset + 16) ^ 1) >>> 0, directoryOffset + 16);
  fs.writeFileSync(archivePath, archive);
  await assert.rejects(readManifestFromArchive(archivePath), /checksum mismatch/iu);
});

test("ZIP64 end records remain readable by the metadata path", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-archive-zip64-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archivePath = path.join(root, "zip64.zip");
  const manifest = { id: "zip64-service" };
  await writeZipArchive(archivePath, { "manifest.json": JSON.stringify(manifest) });
  const archive = fs.readFileSync(archivePath);
  const eocdOffset = archive.length - 22;
  const eocd = archive.subarray(eocdOffset);
  assert.equal(eocd.readUInt32LE(0), 0x06054b50);
  const zip64End = Buffer.alloc(56);
  zip64End.writeUInt32LE(0x06064b50, 0);
  zip64End.writeBigUInt64LE(44n, 4);
  zip64End.writeUInt16LE(45, 12);
  zip64End.writeUInt16LE(45, 14);
  zip64End.writeBigUInt64LE(BigInt(eocd.readUInt16LE(8)), 24);
  zip64End.writeBigUInt64LE(BigInt(eocd.readUInt16LE(10)), 32);
  zip64End.writeBigUInt64LE(BigInt(eocd.readUInt32LE(12)), 40);
  zip64End.writeBigUInt64LE(BigInt(eocd.readUInt32LE(16)), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(eocdOffset), 8);
  locator.writeUInt32LE(1, 16);
  eocd.fill(0xff, 8, 20);
  fs.writeFileSync(archivePath, Buffer.concat([archive.subarray(0, eocdOffset), zip64End, locator, eocd]));

  assert.deepEqual(await listArchiveEntries(archivePath), new Set(["manifest.json"]));
  assert.deepEqual(await readManifestFromArchive(archivePath), manifest);
});

test("zip archives expose entries, manifest, and required paths", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-archive-zip-"));
  const archivePath = path.join(tempRoot, "zip-plugin.zip");
  const extractDir = path.join(tempRoot, "extract");
  const manifest = {
    id: "zip-plugin",
    name: "Zip Plugin",
    version: "v0.1.0",
    runtime: {
      requiredPaths: ["manifest.json", "backend/server.mjs"]
    },
    desktop: {
      bundleTopLevelDir: "zip-plugin"
    }
  };

  await writeZipArchive(archivePath, {
    "zip-plugin/manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "zip-plugin/backend/server.mjs": "export const ok = true;\n"
  });

  try {
    const entries = await listArchiveEntries(archivePath);
    assert.equal(entries.has("zip-plugin/manifest.json"), true);
    assert.equal(entries.has("zip-plugin/backend/server.mjs"), true);

    assert.deepEqual(await readManifestFromArchive(archivePath), manifest);

    await extractArchiveToDir(archivePath, extractDir);
    assert.equal(fs.existsSync(path.join(extractDir, "zip-plugin", "manifest.json")), true);
    assert.equal(fs.existsSync(path.join(extractDir, "zip-plugin", "backend", "server.mjs")), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("zip extraction rejects zip-slip paths", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-archive-zipslip-"));
  const archivePath = path.join(tempRoot, "unsafe.zip");
  const extractDir = path.join(tempRoot, "extract");

  await writeZipArchive(archivePath, {
    "zip-plugin/manifest.json": "{}\n",
    "../escaped.txt": "nope\n"
  });

  try {
    await assert.rejects(
      () => extractArchiveToDir(archivePath, extractDir),
      /archive contains unsafe path|archive entry escapes target directory/u
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
