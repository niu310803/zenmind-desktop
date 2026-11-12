import test from "node:test";
import assert from "node:assert/strict";

const {
  DESKTOP_OPEN_DEEP_LINK,
  findDesktopOpenDeepLink,
  isDesktopOpenDeepLink,
  registerDesktopOpenProtocolClient
} = await import("../dist-electron/main/app/deep-link.js");
const { DESKTOP_OPEN_PROTOCOL_SCHEME } = await import("../dist-electron/shared/brand.js");

test("desktop open deep link accepts only the exact branded open action", () => {
  assert.equal(isDesktopOpenDeepLink(DESKTOP_OPEN_DEEP_LINK), true);
  for (const value of [
    `${DESKTOP_OPEN_DEEP_LINK}/`,
    `${DESKTOP_OPEN_DEEP_LINK}?route=/settings`,
    `${DESKTOP_OPEN_DEEP_LINK}#fragment`,
    DESKTOP_OPEN_DEEP_LINK.toUpperCase(),
    "https://open",
    `${DESKTOP_OPEN_PROTOCOL_SCHEME}://settings`
  ]) {
    assert.equal(isDesktopOpenDeepLink(value), false, value);
  }
  assert.equal(findDesktopOpenDeepLink(["desktop", "--flag", DESKTOP_OPEN_DEEP_LINK]), DESKTOP_OPEN_DEEP_LINK);
  assert.equal(findDesktopOpenDeepLink(["desktop", "--flag"]), null);
});

test("desktop protocol registration keeps packaged and Windows development paths explicit", () => {
  const calls = [];
  const packagedApp = {
    isPackaged: true,
    setAsDefaultProtocolClient(...args) {
      calls.push(args);
      return true;
    }
  };
  assert.equal(registerDesktopOpenProtocolClient(packagedApp, "darwin", {
    isDefaultApp: false,
    execPath: "/Applications/ZenMind"
  }), true);
  assert.deepEqual(calls[0], [new URL(DESKTOP_OPEN_DEEP_LINK).protocol.slice(0, -1)]);

  calls.length = 0;
  const developmentApp = { ...packagedApp, isPackaged: false };
  assert.equal(registerDesktopOpenProtocolClient(developmentApp, "win32", {
    isDefaultApp: true,
    execPath: "C:\\Electron\\electron.exe",
    appEntryPath: "C:\\ZenMind\\dist-electron\\main\\index.js"
  }), true);
  assert.deepEqual(calls[0], [
    new URL(DESKTOP_OPEN_DEEP_LINK).protocol.slice(0, -1),
    "C:\\Electron\\electron.exe",
    ["C:\\ZenMind\\dist-electron\\main\\index.js"]
  ]);
  assert.equal(registerDesktopOpenProtocolClient(developmentApp, "linux", {
    isDefaultApp: true,
    execPath: "/usr/bin/electron",
    appEntryPath: "/workspace/index.js"
  }), false);
});

const { DESKTOP_NAVIGATION_PATHS, readDesktopNavigationUrl } = await import("../dist-electron/shared/desktop-navigation.js");
for (const scheme of ["zenmind", "cutej"]) {
  test(`${scheme} navigation accepts static product pages only`, () => {
    for (const path of DESKTOP_NAVIGATION_PATHS) {
      assert.equal(readDesktopNavigationUrl(`${scheme}://navigate?${new URLSearchParams({ path })}`, scheme), path);
    }
    for (const path of ["https://evil.test", "//evil.test", "/settings/browser?token=x", "/agents/private", "/settings/../debug", "/unknown", "/%73ettings/browser"]) {
      assert.equal(readDesktopNavigationUrl(`${scheme}://navigate?${new URLSearchParams({ path })}`, scheme), null);
    }
    for (const url of [
      `${scheme}://navigate?path=/settings&path=/agents`, `${scheme}://navigate?path=/settings&action=delete`,
      `${scheme}://navigate?path=/settings#`, `${scheme}://navigate?path=/settings#x`,
      `${scheme}://navigate?path=/settings\n`, `${scheme}://navigate?path=/set\ttings`,
      `${scheme}://navigate/?path=/settings`, `${scheme}://user@navigate?path=/settings`,
      `${scheme}://navigate:80?path=/settings`, `other://navigate?path=/settings`,
    ]) assert.equal(readDesktopNavigationUrl(url, scheme), null, url);
  });
}
