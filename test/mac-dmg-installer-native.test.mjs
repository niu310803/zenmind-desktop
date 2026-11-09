import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("macOS installer performs real file transactions and independently verifies shutdown", {
  skip: process.platform !== "darwin", timeout: 90_000
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-installer-native-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "installer-core-tests");
  execFileSync("/usr/bin/xcrun", ["swiftc", "-O",
    "native/macos-installer/InstallerCore.swift", "test/fixtures/mac-dmg-installer-core-tests.swift",
    "-o", executable
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  const output = execFileSync(executable, [], {
    encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"]
  });
  assert.match(output, /PASSED 35 installer checks/);
});
