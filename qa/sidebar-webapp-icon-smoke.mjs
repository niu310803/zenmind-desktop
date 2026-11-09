// Isolated installed-package -> sidebar check; no user profile or business services.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { createCanvas } from "@napi-rs/canvas";
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { readWebappItemFromDir } = require("../dist-electron/main/modules/webs/webapps/store.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-webapp-icon-"));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#f5b93e"/><path d="M10 9h12v16H10z" fill="white"/><path d="M13 14h6m-6 4h6" stroke="#b76d12" stroke-width="2"/></svg>';
const canvas = createCanvas(32, 32);
const context = canvas.getContext("2d");
context.fillStyle = "#6853df";
context.fillRect(0, 0, 32, 32);
context.fillStyle = "white";
context.fillRect(8, 8, 16, 5);
context.fillRect(8, 17, 10, 7);
const png = canvas.toBuffer("image/png");
const fixtures = [
  { key: "qa-notes", label: "便签", html: '<link rel="icon" href="/favicon.svg">', files: { "favicon.svg": svg } },
  { key: "qa-chart", label: "图表工具", html: '<link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'><text y=\'26\' font-size=\'26\'>📈</text></svg>">', files: {} },
  { key: "qa-raster", label: "PNG 应用", html: '<link rel="icon" href="assets/icon.png?v=2">', files: { "assets/icon.png": png } },
  { key: "qa-no-icon", label: "外部应用（无图标）", html: "", files: {} },
  { key: "qa-broken-icon", label: "损坏图标回退", html: '<link rel="icon" href="favicon.png">', files: { "favicon.png": png.subarray(0, 8) } },
];
const items = fixtures.map(({ key, label, html, files }) => {
  const id = `webapp-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  const directory = path.join(root, "packages", id);
  const frontend = path.join(directory, "frontend");
  fs.mkdirSync(frontend, { recursive: true });
  fs.writeFileSync(path.join(frontend, "index.html"), `<!doctype html><head><title>${label}</title>${html}</head><body>${label}</body>`);
  for (const [filename, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(frontend, filename)), { recursive: true });
    fs.writeFileSync(path.join(frontend, filename), bytes);
  }
  fs.writeFileSync(path.join(directory, "webapp.json"), JSON.stringify({
    schemaVersion: 2, id, key, label, version: "1.0.0", target: "any", frontend: { root: "frontend", index: "index.html" },
  }));
  return readWebappItemFromDir(directory);
});
assert.ok(items[0].iconDataUrl && items[1].iconDataUrl && items[2].iconDataUrl);
assert.equal(items[3].iconDataUrl, undefined);
const website = { id: "qa-website", entryKey: "website:qa-website", label: "普通网站", kind: "website", url: "https://example.invalid", createdAt: 1, updatedAt: 1 };

await build({
  stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {MemoryRouter,useLocation,useNavigate} from 'react-router-dom';
    import {AppSidebar} from './src/renderer/app-shell/navigation/AppSidebar';
    import './src/renderer/styles.css';
    const initialItems=${JSON.stringify([...items, website])};
    window.fixtureErrors=[];window.addEventListener('error',event=>window.fixtureErrors.push(String(event.error?.stack||event.message)));
    window.fixtureKeys=initialItems.map(item=>item.entryKey);window.menuRequests=[];window.navigations=[];
    window.electronAPI={assistant:{getProjectCreationOptions:async()=>({ok:false,message:'Fixture has no project creation'})},sidebarContextMenu:{popup:async request=>{window.menuRequests.push(request);return {actionId:null}}}};
    function Fixture(){
      const location=useLocation(),navigate=useNavigate();
      const [webItems,setWebItems]=useState(initialItems);
      const [options,setOptions]=useState({collapsed:false,platform:'darwin',running:true});
      window.setOptions=patch=>setOptions(current=>({...current,...patch}));
      window.replaceIcon=(entryKey,iconDataUrl)=>setWebItems(current=>current.map(item=>item.entryKey===entryKey?{...item,iconDataUrl}:item));
      window.iconState=entryKey=>{const row=document.querySelector('a[href="/webs/'+entryKey+'"]');const icon=row?.querySelector('.sidebar-webapp-icon');const img=icon?.querySelector('img');const bounds=icon?.getBoundingClientRect();return {exists:!!icon,loaded:!!img?.complete&&img.naturalWidth>0,src:img?.getAttribute('src'),fallback:!!icon?.querySelector('.settings-sidebar-icon-webapps'),width:bounds?.width,height:bounds?.height,objectFit:img&&getComputedStyle(img).objectFit};};
      return <div className={'app-shell '+(options.platform==='darwin'?'is-mac-platform':'is-windows-platform')} style={{'--app-sidebar-width':options.collapsed?'64px':'240px'}}>
        <div className="app-sidebar-shell"><AppSidebar isCollapsed={options.collapsed} isMac={options.platform==='darwin'} isWindows={options.platform==='win32'}
          currentPathname={location.pathname} currentRoute={location.pathname} sidebarMode="primary" sidebarNavOrder={['kanban','schedules','new-chat',initialItems[0].entryKey,'chats','group:assistants','group:webs']}
          webItems={webItems} pinnedWebEntryKeys={[initialItems[0].entryKey]} websiteNavOrder={initialItems.map(item=>item.entryKey)}
          webRunningEntryKeys={options.running?initialItems.slice(0,3).map(item=>item.entryKey):[]}
          faviconCache={{[${JSON.stringify(website.entryKey)}]:{websiteUrl:${JSON.stringify(website.url)},faviconUrl:${JSON.stringify(`data:image/png;base64,${png.toString("base64")}`)}}}}
          onShareChat={()=>{}} onRequestNavigate={to=>{window.navigations.push(to);navigate(to);return true;}}
          toolMenuOpen={false} onRequestToolMenuOpen={()=>{}} onAutoOpenToolMenu={()=>{}} onCloseToolMenu={()=>{}} /></div>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/webs/'+initialItems[1].entryKey]}><Fixture/></MemoryRouter>);
  `, resolveDir: repo, loader: "tsx" },
  outfile: path.join(root, "fixture.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic", loader: { ".svg": "file" },
  define: { "process.env.NODE_ENV": '"production"', __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(repo, resolveBrandId()))) },
});
fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><html data-theme="light"><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'"><link rel="stylesheet" href="fixture.css"><style>body{margin:0}.app-shell,.app-sidebar-shell,.app-sidebar{height:100vh}*,*::before,*::after{transition:none!important;animation:none!important}</style><div id="root"></div><script src="fixture.js"></script></html>`);

async function runChecks() {
  const { app, BrowserWindow, session } = require("electron");
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  app.setPath("userData", path.join(__dirname, "profile"));
  app.setPath("sessionData", path.join(__dirname, "session"));
  await app.whenReady();
  const server = require("node:http").createServer((request, response) => {
    try {
      const filename = path.resolve(__dirname, `.${decodeURIComponent(new URL(request.url, "http://fixture.invalid").pathname)}`);
      const relative = path.relative(__dirname, filename);
      if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.statSync(filename).isFile()) throw new Error("Not found");
      response.setHeader("Content-Type", ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" })[path.extname(filename)] || "application/octet-stream");
      response.end(fs.readFileSync(filename));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
  const requests = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const remote = /^https?:/u.test(details.url) && new URL(details.url).origin !== fixtureOrigin;
    if (remote) requests.push(details.url);
    callback({ cancel: remote });
  });
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  const js = code => win.webContents.executeJavaScript(code);
  const until = async code => {
    for (let count = 0; count < 100; count++) {
      if (await js(code)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timeout: ${code}; errors: ${await js('JSON.stringify(window.fixtureErrors)')}`);
  };
  await win.loadURL(`${fixtureOrigin}/index.html`);
  await until("!!window.iconState");
  const keys = await js("window.fixtureKeys");
  const queryIcon = key => `window.iconState(${JSON.stringify(key)})`;
  for (const platform of ["darwin", "win32"]) {
    for (const theme of ["light", "dark"]) {
      for (const collapsed of [false, true]) {
        await js(`window.setOptions(${JSON.stringify({ platform, collapsed })});document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        await until(`!!document.querySelector('.app-sidebar${collapsed ? ".is-collapsed" : ":not(.is-collapsed)"}')`);
        assert.equal(await js("getComputedStyle(document.querySelector('.sidebar-nav')).flexDirection"), "column");
        if (collapsed) {
          await js("document.querySelector('[data-sidebar-group-id=webs]').click()");
          await until("!!document.querySelector('.worker-popover-content')");
        }
        for (const key of keys.slice(0, 3)) {
          await until(`${queryIcon(key)}.loaded`);
          const state = await js(queryIcon(key));
          assert.equal(state.objectFit, "contain");
          assert.equal(state.width, collapsed && key === keys[0] ? 24 : 16);
          assert.equal(state.height, state.width);
        }
        for (const key of keys.slice(3, 5)) await until(`${queryIcon(key)}.fallback`);
        assert.equal(await js("document.querySelectorAll('.sidebar-webapp-status-dot').length"), 3);
        assert.equal(await js("document.querySelectorAll('.sidebar-website-favicon').length"), 1);
        await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        fs.writeFileSync(path.join(__dirname, `${platform}-${theme}-${collapsed ? "collapsed" : "expanded"}.png`), (await win.webContents.capturePage({ x: 0, y: 0, width: collapsed ? 440 : 240, height: 780 })).toPNG());
        if (collapsed) {
          await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
          await until("!document.querySelector('.worker-popover-content')");
        }
      }
    }
  }
  await js("window.setOptions({collapsed:false,running:false})");
  await until(`${queryIcon(keys[1])}.loaded && !document.querySelector('.sidebar-webapp-status-dot')`);
  // Updating a previously failed icon can recover without remounting the sidebar.
  await js(`window.replaceIcon(${JSON.stringify(keys[4])}, ${queryIcon(keys[0])}.src)`);
  await until(`${queryIcon(keys[4])}.loaded`);
  await js(`document.querySelector('a[href="/webs/${keys[2]}"]').click()`);
  await until(`window.navigations.includes('/webs/${keys[2]}')`);
  await js(`document.querySelector('a[href="/webs/${keys[1]}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:200}))`);
  await until("window.menuRequests.length===1");
  assert.equal(requests.length, 0, "Package icons must not trigger remote HTTP requests");
  assert.deepEqual(errors, []);
  const report = { ok: true, scenarios: 8, packageIcons: 3, defaultFallbacks: 2, recoveredFailedIcon: true, navigationAndContextMenu: true, requests };
  fs.writeFileSync(path.join(__dirname, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  app.exit(0);
}

fs.writeFileSync(path.join(root, "main.cjs"), `${runChecks.toString()}\nrunChecks().catch(error=>{console.error(error);require('electron').app.exit(1)});`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [path.join(root, "main.cjs")], { stdio: "inherit", env });
const timeout = setTimeout(() => child.kill(), 45000);
const code = await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
clearTimeout(timeout);
console.log(`Screenshots and report: ${root}`);
process.exitCode = code ?? 1;
