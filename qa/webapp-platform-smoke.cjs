// Build Main first. Pass a freshly built Platform binary; uses only a temporary profile.
const { app, BrowserWindow, WebContentsView } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const sourceBinary = process.argv[2];
if (!sourceBinary || !path.isAbsolute(sourceBinary)) throw new Error('Pass an absolute Platform binary path.');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webapp-platform-smoke-')));
app.setPath('userData', path.join(temp, 'profile'));
const appStub = { getPath: name => path.join(temp, name), getAppPath: () => app.getAppPath() };
const { registerService } = require('../dist-electron/main/modules/services/service-registry.js');
const { getServiceLayout } = require('../dist-electron/main/modules/services/manager/layout.js');
const { getDesktopRoot } = require('../dist-electron/main/infrastructure/filesystem/user-paths.js');
const { WebappPlatformInstances, platformWebappPartition } = require('../dist-electron/main/modules/webs/webapps/platform-instances.js');
const { webappPlatformLayout } = require('../dist-electron/main/modules/webs/webapps/platform-layout.js');
const { embeddedNodeExecutable, embeddedNodeLaunchers } = require('../dist-electron/main/modules/services/manager/embedded-node-runtime.js');
const { parseWebappManifest } = require('../dist-electron/shared/webapp-manifest.js');
const { configureMainWindowWebContents } = require('../dist-electron/main/modules/shell/main-window-web-contents.js');
const id = 'webapp-0123456789abcdef';
const instances = new WebappPlatformInstances(() => {});
let item, win, view;
const deadline = setTimeout(() => { console.error('Platform smoke timed out:', temp); app.exit(1); }, 150000);
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function waitFor(fn) { for (let i=0;i<200;i++) { if (await fn()) return; await pause(50); } throw new Error('Guest readiness timed out.'); }
app.whenReady().then(async () => {
 const service = registerService({kind:'builtin',id:'agent-platform',name:'Platform',version:'0.5.46',backend:{entry:process.platform === 'win32' ? 'backend/agent-platform.exe' : 'backend/agent-platform'},frontend:{mode:'none'},scripts:{start:'start.sh',stop:'stop.sh'}},{defaultKind:'builtin'});
 const serviceLayout = getServiceLayout(appStub,service);
 const binary = path.join(serviceLayout.programDir,service.backend.entry);
 fs.mkdirSync(path.dirname(binary),{recursive:true}); fs.copyFileSync(sourceBinary,binary); fs.chmodSync(binary,0o755);
 const bin = path.join(getDesktopRoot(appStub),'bin'); fs.mkdirSync(bin,{recursive:true});
 if (process.platform === 'darwin') {
  const executable = await embeddedNodeExecutable(process.argv[3] || process.execPath,process.platform);
  const launchers = embeddedNodeLaunchers(process.platform,executable,bin);
  fs.writeFileSync(path.join(bin,'node'),launchers.node,{mode:0o755});
 } else throw new Error('Use the packaged native node.exe to extend this smoke to Windows.');
 const layout = webappPlatformLayout(appStub,id); fs.mkdirSync(path.join(layout.runtime,'frontend'),{recursive:true}); fs.mkdirSync(path.join(layout.runtime,'backend'));
 item = { ...parseWebappManifest({schemaVersion:2,id,key:'platform-smoke',label:'Platform smoke',version:'1.0.0',target:'any',hosting:'platform',minPlatformVersion:'0.5.46',frontend:{root:'frontend',index:'index.html',routeConfig:{backendPrefixes:['/api']}},backend:{command:{type:'node',entry:'backend/server.mjs'},health:{type:'http',path:'/api/health'}}}),kind:'webapp',entryKey:`webapp:${id}`,createdAt:0,updatedAt:0,openMode:'workspace'};
 fs.writeFileSync(path.join(layout.runtime,'webapp.json'),JSON.stringify(item,(_key,value) => value));
 // Remove the Desktop projection fields: the package remains the shared Manifest.
 const manifest = {...item}; for (const key of ['kind','entryKey','createdAt','updatedAt','openMode']) delete manifest[key]; fs.writeFileSync(path.join(layout.runtime,'webapp.json'),JSON.stringify(manifest));
 fs.writeFileSync(path.join(layout.runtime,'frontend','index.html'),'<html><head><title>platform-smoke</title></head><body>Independent Platform</body></html>');
 fs.writeFileSync(path.join(layout.runtime,'backend','server.mjs'),`import http from 'node:http';import fs from 'node:fs';import {spawnSync} from 'node:child_process';http.createServer((req,res)=>{let read='',write='',child='';try{fs.readFileSync(process.env.WEBAPP_DIR+'/.state/webapp-owner/owner.json');read='ALLOWED'}catch(e){read=e.code}try{fs.writeFileSync(process.env.WEBAPP_DIR+'/frontend/forbidden','x');write='ALLOWED'}catch(e){write=e.code}try{spawnSync(process.execPath,['--version']);child='ALLOWED'}catch(e){child=e.code}fs.writeFileSync(process.env.WEBAPP_DATA_DIR+'/probe','ok');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({read,write,child,node:process.versions.node,root:!!process.env.WEBAPP_DIR,config:!!process.env.WEBAPP_USER_CONFIG_FILE}));}).listen(Number(process.env.PORT),process.env.HOST);`);
 const result = await instances.start(appStub,item);
 if (!result.ok) throw new Error(`${result.message}\n${fs.readFileSync(path.join(layout.logs,'error.log'),'utf8')}`);
 win = new BrowserWindow({show:false,webPreferences:{webviewTag:true,contextIsolation:true,nodeIntegration:false,sandbox:true}});
 view = new WebContentsView({webPreferences:{partition:platformWebappPartition(id),sandbox:true,contextIsolation:true,nodeIntegration:false}}); win.contentView.addChildView(view);

 await instances.openGuest(appStub,id,view.webContents);
 assert.equal(view.webContents.getTitle(),'platform-smoke',await view.webContents.executeJavaScript('document.body.innerText'));
 const probe = await view.webContents.executeJavaScript('fetch("/api/health").then(r=>r.json())');
 assert.equal(probe.read,'ERR_ACCESS_DENIED'); assert.equal(probe.write,'ERR_ACCESS_DENIED'); assert.equal(probe.child,'ERR_ACCESS_DENIED'); assert.match(probe.node,/^24\./); assert.equal(probe.root,true); assert.equal(probe.config,true);
 assert.equal(await view.webContents.executeJavaScript('document.cookie'),'');
 let attached;
 configureMainWindowWebContents(win,{platform:process.platform,getMainWindow:()=>win,servicePreloadPath:path.join(__dirname,'../dist-electron/preload/service-webview.js'),servicePreloadUrl:'file:///unused',isSafeServiceUrl:()=>true,isDevToolsShortcut:()=>false,shouldDownloadUrl:()=>false,resolveOpenDisposition:()=> 'external',collectLoadDiagnostics:async()=>({}),report:()=>{},openExternal:async()=>{},schedule:setImmediate,platformWebappPartitionForUrl:url=>instances.partitionForUrl(url),configurePlatformWebappGuest:guest=>{attached=guest;return instances.configureGuest(appStub,guest);}});
 await win.loadURL('data:text/html,'+encodeURIComponent(`<html><body><webview src="${result.state.webUrl}" style="width:300px;height:200px"></webview></body></html>`));
 await waitFor(()=>attached?.getTitle()==='platform-smoke');
 assert.equal(attached.getLastWebPreferences().preload,undefined); assert.equal(attached.getLastWebPreferences().sandbox,true);
 assert.equal(await attached.executeJavaScript('typeof window.electronAPI'),'undefined');
 const credentials = JSON.parse(fs.readFileSync(path.join(layout.runtime,'.state/webapp-owner/owner.json'),'utf8'));
 const status = await fetch(result.state.backendUrl+'/api/webapp/status',{headers:{Authorization:`Bearer ${credentials.token}`}}).then(r=>r.json());
 assert.equal(status.data.activeRuns,0);
 const stopped = await instances.stop(appStub,item); assert.equal(stopped.ok,true);
 console.log(JSON.stringify({ok:true,node:probe.node,topLevelPost:true,httpOnly:true,noDesktopPreload:true,processStopped:true}));
 clearTimeout(deadline); win.destroy(); fs.rmSync(temp,{recursive:true,force:true}); app.exit(0);
}).catch(async error => { console.error(error.stack || String(error)); console.error('Preserved smoke files:',temp); if(item)await instances.stop(appStub,item); clearTimeout(deadline); win?.destroy(); app.exit(1); });
