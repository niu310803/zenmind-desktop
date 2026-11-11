import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readWebappIconDataUrl, resolveWebappIconPath } = require("../dist-electron/main/modules/webs/webapps/icon.js");
const { readWebappItemFromDir } = require("../dist-electron/main/modules/webs/webapps/store.js");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="red"/></svg>');
const dataUrl = (bytes, mime = "image/svg+xml") => `data:${mime};base64,${bytes.toString("base64")}`;

function fixture(t, html = "<!doctype html><title>WebApp</title>", index = "index.html") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-icon-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "app");
  const frontend = { root: "frontend", index };
  const write = (filename, bytes) => {
    const target = path.join(packageRoot, "frontend", filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  };
  write(index, html);
  return { root, packageRoot, frontend, write, read: () => readWebappIconDataUrl(packageRoot, frontend) };
}

test("WebApp package assets override frontend favicons and work independently of frontend files", t => {
  const app = fixture(t, '<link rel=icon href="/favicon.png">');
  app.write("favicon.png", png);
  const assets = path.join(app.packageRoot, "assets");
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, "icon.svg"), svg);
  fs.writeFileSync(path.join(assets, "icon.png"), png);
  assert.equal(app.read(), dataUrl(svg));
  fs.rmSync(path.join(app.packageRoot, "frontend"), { recursive: true });
  assert.equal(app.read(), dataUrl(svg));
});

test("WebApp package PNG icons work alone and replace invalid SVG icons before frontend fallbacks", t => {
  const app = fixture(t, '<link rel=icon href="/favicon.svg">');
  app.write("favicon.svg", svg);
  const assets = path.join(app.packageRoot, "assets");
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, "icon.png"), png);
  assert.equal(app.read(), dataUrl(png, "image/png"));
  fs.writeFileSync(path.join(assets, "icon.svg"), "not an image");
  assert.equal(app.read(), dataUrl(png, "image/png"));
});

test("WebApp package assets reject oversized images and symlink escapes while retaining favicon fallback", t => {
  const app = fixture(t);
  const assets = path.join(app.packageRoot, "assets");
  fs.mkdirSync(assets);
  const outside = path.join(app.root, "outside.svg");
  fs.writeFileSync(outside, svg);
  fs.symlinkSync(outside, path.join(assets, "icon.svg"));
  fs.writeFileSync(path.join(assets, "icon.png"), Buffer.concat([png, Buffer.alloc(256 * 1024)]));
  assert.equal(app.read(), "");
  app.write("favicon.png", png);
  assert.equal(app.read(), dataUrl(png, "image/png"));
  fs.rmSync(assets, { recursive: true });
  const outsideAssets = path.join(app.root, "outside-assets");
  fs.mkdirSync(outsideAssets);
  fs.writeFileSync(path.join(outsideAssets, "icon.svg"), svg);
  fs.symlinkSync(outsideAssets, assets, process.platform === "win32" ? "junction" : "dir");
  assert.equal(app.read(), dataUrl(png, "image/png"));
});

test("WebApp icons use declared frontend icons ahead of touch icons and conventional fallbacks", t => {
  const app = fixture(t, `<link rel="apple-touch-icon" href="/touch.png"><LINK HREF='/assets/logo.svg?v=2&amp;x=1#icon' REL='shortcut icon'>`);
  app.write("touch.png", png);
  app.write("assets/logo.svg", svg);
  app.write("favicon.png", png);
  assert.equal(app.read(), dataUrl(svg));
});

test("WebApp inline SVG favicons preserve quoted > markup, emoji, and encoded characters", t => {
  const inline = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>📈</text></svg>";
  const app = fixture(t, `<link rel="icon" href="data:image/svg+xml,${inline}" />`);
  assert.equal(app.read(), dataUrl(Buffer.from(inline)));
  app.write("index.html", `<link rel=icon href='data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.toString())}'>`);
  assert.equal(app.read(), dataUrl(svg));
});

test("WebApp icons resolve nested entry-relative and URL-encoded filenames", t => {
  const app = fixture(t, '<link rel=icon href="../assets/%E5%9B%BE%20%E6%A0%87.png?version=2#preview">', "pages/index.html");
  app.write("assets/图 标.png", png);
  assert.equal(app.read(), dataUrl(png, "image/png"));
});

test("WebApp icons ignore commented and script-contained link markup and try conventional files", t => {
  const app = fixture(t, `<!-- <link rel=icon href=/comment.svg> --><script>const x='<link rel=icon href=/script.svg>';</script>`);
  app.write("comment.svg", svg);
  app.write("script.svg", svg);
  app.write("favicon.png", png);
  assert.equal(app.read(), dataUrl(png, "image/png"));
});

test("WebApp icons do not fetch external, file, or backend assets", t => {
  const app = fixture(t, `<link rel=icon href="https://example.com/icon.svg"><link rel=icon href="//example.com/icon.svg"><link rel=icon href="file:///tmp/icon.svg"><link rel=icon href="/backend/icon.svg">`);
  fs.writeFileSync(path.join(app.packageRoot, "icon.svg"), svg);
  assert.equal(app.read(), "");
  app.write("favicon.svg", svg);
  assert.equal(app.read(), dataUrl(svg));
});

test("WebApp icon paths enforce macOS and Windows frontend containment", () => {
  for (const [platform, root, expected] of [
    ["darwin", "/Users/test/app/frontend", "/Users/test/app/frontend/assets/icon.svg"],
    ["win32", "C:\\Users\\test\\app\\frontend", "C:\\Users\\test\\app\\frontend\\assets\\icon.svg"],
  ]) {
    assert.equal(resolveWebappIconPath(root, "pages/index.html", "../assets/icon.svg?version=1#preview", platform), expected);
    for (const href of ["/%2e%2e%2fsecret.svg", "/assets/%5c..%5csecret.svg", "C:\\secret.svg", "/C:/secret.svg", "//server/share/icon.svg", "/icon.svg:stream", "file:///tmp/icon.svg", "https://webapp-icon.invalid/icon.svg", "/%00icon.svg", "%ZZ"]) {
      assert.equal(resolveWebappIconPath(root, "index.html", href, platform), "", `${platform}: ${href}`);
    }
  }
});

test("WebApp icons reject symlink escapes for both icon files and frontend roots", t => {
  const app = fixture(t, '<link rel=icon href="/escape.svg">');
  const outside = path.join(app.root, "outside.svg");
  fs.writeFileSync(outside, svg);
  fs.symlinkSync(outside, path.join(app.packageRoot, "frontend", "escape.svg"));
  assert.equal(app.read(), "");
  fs.symlinkSync(app.root, path.join(app.packageRoot, "outside-frontend"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(readWebappIconDataUrl(app.packageRoot, { root: "outside-frontend", index: "outside.svg" }), "");
});

test("WebApp icons reject oversized, non-image, mismatched inline types, and SVG entity payloads", t => {
  const app = fixture(t, '<link rel=icon href="/assets/not-image.png"><link rel=icon href="/assets/large.png">');
  app.write("assets/not-image.png", JSON.stringify({ config: "not an image" }));
  app.write("assets/large.png", Buffer.concat([png, Buffer.alloc(256 * 1024)]));
  assert.equal(app.read(), "");
  for (const href of [
    dataUrl(svg, "image/png"),
    dataUrl(Buffer.from("<!DOCTYPE svg [<!ENTITY secret SYSTEM 'file:///tmp/private'>]><svg>&secret;</svg>")),
    dataUrl(Buffer.from("<html><script>alert(1)</script></html>")),
    `data:image/svg+xml,${encodeURIComponent("<svg>" + "x".repeat(256 * 1024) + "</svg>")}`,
  ]) {
    app.write("index.html", `<link rel=icon href="${href}">`);
    assert.equal(app.read(), "");
  }
});

test("WebApp icon failures are optional and package icon replacements are observed", t => {
  const app = fixture(t, '<link rel=icon href="/assets/logo.svg">');
  assert.equal(app.read(), "");
  app.write("assets/logo.svg", svg);
  assert.equal(app.read(), dataUrl(svg));
  app.write("assets/logo.svg", png);
  assert.equal(app.read(), dataUrl(png, "image/png"));
  assert.equal(readWebappIconDataUrl(path.join(app.root, "missing"), app.frontend), "");
});

test("WebApp listing projects package icons without adding manifest configuration or local paths", t => {
  const app = fixture(t, '<link rel=icon href="/favicon.svg">');
  fs.mkdirSync(path.join(app.packageRoot, "assets"));
  fs.writeFileSync(path.join(app.packageRoot, "assets/icon.svg"), svg);
  const key = "sidebar-icons";
  const manifest = { schemaVersion: 2, id: `webapp-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`, key, label: "Sidebar icons", version: "1.0.0", target: "any", frontend: app.frontend };
  const manifestPath = path.join(app.packageRoot, "webapp.json");
  const manifestJson = JSON.stringify(manifest);
  fs.writeFileSync(manifestPath, manifestJson);
  const entry = readWebappItemFromDir(app.packageRoot);
  assert.equal(entry.iconDataUrl, dataUrl(svg));
  assert.ok(!entry.iconDataUrl.includes(app.root));
  assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestJson);
});
