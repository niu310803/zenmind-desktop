import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "webclient-window-drag-"));
await build({ stdin: { resolveDir: root, contents: `import { installServiceWebviewWindowDrag } from './src/preload/service-webview-window-drag'; installServiceWebviewWindowDrag();` },
  bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: path.join(output, "preload.cjs") });
await build({ entryPoints: [path.join(root, "src/renderer/styles/app-shell.css")], bundle: true, outfile: path.join(output, "shell.css") });
await build({ stdin: { resolveDir: root, contents: `
import { createWebclientWindowDragHost } from './src/renderer/service-webview/windowDragHost';
const webview = document.querySelector('webview');
window.calls = []; window.enabled = true; window.platform = 'mac';
window.host = createWebclientWindowDragHost({ webview, trustedUrl: () => location.origin,
  isCurrentGuest: () => webview.isConnected, readHeight: () => window.enabled && window.platform === 'mac' ? 40 : 0,
  begin: async () => { window.calls.push('begin'); return {ok:true}; },
  end: async () => { window.calls.push('end'); }, maximize: async () => { window.calls.push('maximize'); },
  onEnabled: enabled => document.querySelector('.app-shell').style.setProperty('--webclient-header-right', enabled ? webview.getBoundingClientRect().right + 'px' : '100%') });
window.configure = (platform, enabled = true) => {
  window.platform = platform; window.enabled = enabled;
  document.querySelector('.app-shell').className = 'app-shell ' + (platform === 'mac' ? 'is-mac-platform' : 'is-windows-platform');
  window.host.refresh();
};
` }, bundle: true, platform: "browser", outfile: path.join(output, "host.js") });
const guestHtml = `<!doctype html><style>html,body{margin:0}nav{height:36px}.top-nav-inner{height:100%;display:flex;align-items:center;gap:20px}.nav-group{height:32px;display:flex;align-items:center}.nav-center{flex:1;justify-content:center}input{width:100px;height:24px}button{height:28px}main{height:300px}</style>
<nav><div class="top-nav-inner"><div class="nav-group nav-left"><input id="search"></div><div class="nav-group nav-center"><div class="current-worker-card"><strong id="name">小君</strong><span title="待命" id="status">待命</span><button id="usage">10 2.9M</button></div></div><div class="nav-group"><button id="action">更多</button></div></div></nav><main id="body">正文</main>
<script>window.clicks=[]; document.addEventListener('click',e=>window.clicks.push(e.target.id));window.instance=crypto.randomUUID();</script>`;
fs.writeFileSync(path.join(output, "host.html"), `<!doctype html><link rel="stylesheet" href="/shell.css"><style>html,body{margin:0;height:100%;width:100%}.app-shell{width:100%;height:100%}webview{position:absolute;left:160px;top:0;width:640px;height:400px}</style><div class="app-shell is-mac-platform"><webview src="/guest" preload="${new URL("file://" + path.join(output, "preload.cjs")).href}"></webview><div class="app-window-drag-layer"><div class="app-window-drag-region"></div></div></div><script src="/host.js"></script>`);
fs.writeFileSync(path.join(output, "checks.cjs"), `
const {app,BrowserWindow,webContents}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const output=${JSON.stringify(output)};
app.setPath('userData',path.join(output,'profile')); app.setPath('sessionData',path.join(output,'session'));
const guestHtml=${JSON.stringify(guestHtml)};
const server=http.createServer((req,res)=>{const name=req.url==='/'?'host.html':req.url.slice(1); if(name==='guest'){res.setHeader('Content-Type','text/html');res.end(guestHtml);return;} const file=path.join(output,name);res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));});
const pause=ms=>new Promise(r=>setTimeout(r,ms));let win;
const js=code=>win.webContents.executeJavaScript(code);
const until=async f=>{for(let i=0;i<100;i++){try{if(await f())return;}catch{}await pause(30);}throw Error('timed out');};
(async()=>{await app.whenReady();await new Promise(r=>server.listen(0,'127.0.0.1',r));
win=new BrowserWindow({width:800,height:400,useContentSize:true,show:false,webPreferences:{webviewTag:true,contextIsolation:true}});
await win.loadURL('http://127.0.0.1:'+server.address().port);win.show();
await until(()=>js('document.querySelector("webview").getAttribute("data-window-drag-ready")==="true"'));
let guest=webContents.fromId(await js('document.querySelector("webview").getWebContentsId()'));
const g=code=>guest.executeJavaScript(code);
await until(()=>g('!!window.instance')); const instance=await g('window.instance');
assert.equal(await js('document.elementFromPoint(400,24).tagName'),'WEBVIEW','host must not intercept header input');
assert.equal(await js('document.elementFromPoint(400,2).tagName'),'WEBVIEW','host strip must not intercept guest top');
await js('document.querySelector("webview").style.width="440px";host.refresh()');
assert.equal(await js('document.elementFromPoint(700,2).className'),'app-window-drag-region','preserve strip over adjacent WorkPanel');
assert.equal(await js('document.elementFromPoint(400,2).tagName'),'WEBVIEW','split Chat remains unobstructed');
await js('document.querySelector("webview").style.width="640px";host.refresh()');
const click=async(x,y,count=1)=>{guest.sendInputEvent({type:'mouseMove',x,y});guest.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:count});guest.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:count});await pause(50);};
for(const y of [2,24,35]){await js('calls.length=0');await click(160,y);assert.deepEqual(await js('calls'),['begin','end'],'36px header blank y='+y);}
for(const y of [36,39,40]){await js('calls.length=0');await click(160,y);assert.deepEqual(await js('calls'),[],'below 36px header y='+y);}
// Layout changes are read at press time; the same guest can shrink or grow.
await g('document.querySelector("nav").style.height="44px"');
await js('calls.length=0');await click(160,39);assert.deepEqual(await js('calls'),['begin','end'],'taller header retains 40px maximum');
await js('calls.length=0');await click(160,40);assert.deepEqual(await js('calls'),[],'40px maximum');
await g('document.querySelector("nav").style.height="36px"');
for(const id of ['search','name','status','usage','action']){const r=await g('(()=>{const r=document.getElementById('+JSON.stringify(id)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');await js('calls.length=0');await click(r.x,r.y);assert.deepEqual(await js('calls'),[],'content '+id);assert.equal((await g('window.clicks')).at(-1),id,'content click '+id);}
await js('calls.length=0');await click(160,24,1);await click(160,24,2);assert.deepEqual(await js('calls'),['begin','end','begin','end','maximize'],'double click');
for(const config of ['configure("windows")','configure("mac",false)']){await js(config+';calls.length=0');await click(160,24);assert.deepEqual(await js('calls'),[],config);}
await js('configure("mac");calls.length=0');guest.sendInputEvent({type:'mouseDown',x:160,y:24,button:'left',clickCount:1});await until(async()=> (await js('calls')).includes('begin'));
await js('configure("mac",false)');await until(async()=> (await js('calls')).at(-1)==='end');guest.sendInputEvent({type:'mouseUp',x:160,y:24,button:'left',clickCount:1});
assert.equal(await g('window.instance'),instance,'configuration keeps same guest');
await js('configure("mac");document.querySelector("webview").reload()');await until(()=>g('window.instance && window.instance!=='+JSON.stringify(instance)));await until(()=>js('document.querySelector("webview").hasAttribute("data-window-drag-ready")'));
await js('calls.length=0');await click(160,24);assert.deepEqual(await js('calls'),['begin','end'],'reload renegotiates');
console.log('PASS: real WebView 36px header boundary, dynamic header resizing with 40px maximum, overlay pass-through, content clicks, double click, platform/disabled lanes, cancellation and reload');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{win?.destroy();server.close();app.quit();});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [path.join(output, "checks.cjs")], { env, stdio: "inherit" });
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
console.log("QA artifacts: " + output);
process.exitCode = typeof code === "number" ? code : 1;
