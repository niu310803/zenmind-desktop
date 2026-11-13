// Exercise the actual WebClient overview row + hook in an isolated Electron webview.
// Native start is captured at the final OS boundary; no files enter a user folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const desktop = process.cwd(), webclient = path.resolve(desktop, '../agent-webclient');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-guest-drag-'));
await build({ stdin: { contents: `import {installArtifactDrag} from './src/preload/service-webview-artifact-drag';installArtifactDrag();`, resolveDir: desktop }, outfile: path.join(output, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await build({ stdin: { contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {OverviewArtifactRow} from './src/features/overview/components/OverviewArtifactRow';
import {useDesktopArtifactDrag} from './src/shared/ui/useDesktopArtifactDrag';
function Preview(){const drag=useDesktopArtifactDrag('chat',undefined,'@chat/artifacts/run/report.txt',true,()=>{});return <div id="file" {...drag.props} data-state={drag.status} style={{width:300,height:60}}>WorkPanel report.txt</div>}
const role=new URL(location.href).searchParams.get('role');
createRoot(document.getElementById('root')).render(role==='artifact'?<Preview/>:<OverviewArtifactRow id="file" chatId="chat" artifactId="artifact" source="@chat/artifacts/run/report.txt" style={{width:300,height:60}}>report.txt</OverviewArtifactRow>);
`, resolveDir: webclient, loader: 'tsx' }, tsconfig: path.join(webclient, 'tsconfig.json'), outfile: path.join(output, 'app.js'), bundle: true, platform: 'browser', define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'isolated-ui-host', setup(build) {
  build.onResolve({ filter: /^@\/shared\/(i18n|ui\/useAppMessage)$/ }, args => ({ path: args.path, namespace: 'qa-ui' }));
  build.onLoad({ filter: /.*/, namespace: 'qa-ui' }, () => ({ contents: 'export const useI18n=()=>({t:key=>key});export const useAppMessage=()=>({info:()=>{}});', loader: 'js' }));
} }] });
fs.writeFileSync(path.join(output, 'main.cjs'), `
const {app,BrowserWindow,webContents,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{pathToFileURL}=require('node:url');
const {registerArtifactDragIpc}=require(${JSON.stringify(path.join(desktop,'dist-electron/main/modules/artifacts/native-drag.js'))});
const {artifactDragSurfaceAllowed}=require(${JSON.stringify(path.join(desktop,'dist-electron/main/modules/artifacts/drag-surface-policy.js'))});
app.setPath('userData',path.join(__dirname,'profile'));app.on('window-all-closed',()=>{});
const pause=ms=>new Promise(r=>setTimeout(r,ms));const until=async(f)=>{for(let i=0;i<120;i++){if(await f())return;await pause(25)}throw Error('Timed out: '+f)};
(async()=>{await app.whenReady();
 const html='<html><body style="margin:0"><div id="root"></div><script src="/app.js"></script></body></html>';
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?fs.readFileSync(path.join(__dirname,'app.js')):html)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const win=new BrowserWindow({show:false,width:640,height:480,webPreferences:{webviewTag:true,contextIsolation:true,nodeIntegration:false}});
 await win.loadURL('data:text/html,<html><body style="margin:0"></body></html>');
 const bytes=Buffer.from('exported report'),artifact={artifactId:'artifact',url:'@chat/artifacts/run/report.txt',sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 let role='overview',guest,starts=[],preparations=[];
 const runtime=registerArtifactDragIpc(ipcMain,{platform:process.platform,tempRoot:path.join(__dirname,'exports'),
 authorize(event,input){if(!guest||event.sender!==guest||event.senderFrame!==guest.mainFrame)return null;
 const target={active:true,serviceId:'agent-webclient',ownerWebContentsId:win.webContents.id,ownerChatId:'chat',surfaceRole:role,surfaceLevel:role==='main-chat'?'root':'child',surfaceId:role==='main-chat'?'main-chat':'qa-child'};
 return artifactDragSurfaceAllowed(target,input,event.sender.getURL(),win.webContents.id)?JSON.stringify([role,event.senderFrame.routingId]):null},
 captureSourceGeneration:()=>()=>true,getChatInfo:async()=>({chatId:'chat',agentKey:'agent',rawJson:JSON.stringify({chatId:'chat',artifact:{items:[artifact]}})}),
 read:async identity=>{preparations.push(identity);return bytes},start(event,file){assert.deepEqual(fs.readFileSync(file),bytes);starts.push({role,sender:event.sender.id})}});
 for(role of ['main-chat','overview','artifact']){
  const route=role==='main-chat'?'/agent/agent?chatId=chat':role==='overview'?'/overview/chat?role=overview':'/resource-viewer/agent?chatId=chat&role=artifact&file='+encodeURIComponent(artifact.url);
  await win.webContents.executeJavaScript('document.body.innerHTML=""');
  await win.webContents.executeJavaScript('(()=>{const v=document.createElement("webview");v.style.cssText="width:640px;height:480px";v.preload='+JSON.stringify(pathToFileURL(path.join(__dirname,'preload.cjs')).href)+';v.src='+JSON.stringify(base+route)+';document.body.append(v)})()');
  await until(()=>win.webContents.executeJavaScript('!!document.querySelector("webview")?.getWebContentsId()').catch(()=>false));
  guest=webContents.fromId(await win.webContents.executeJavaScript('document.querySelector("webview").getWebContentsId()'));
  await until(()=>guest.executeJavaScript('!!document.querySelector("#file")').catch(()=>false));
  win.show();win.focus();guest.focus();await pause(80);
  guest.sendInputEvent({type:'mouseMove',x:25,y:25});
  await until(()=>guest.executeJavaScript('document.querySelector("#file").title.endsWith("ready")||document.querySelector("#file").dataset.state==="ready"'));
  const before=starts.length;guest.sendInputEvent({type:'mouseDown',x:25,y:25,button:'left',clickCount:1});await pause(30);
  guest.sendInputEvent({type:'mouseMove',x:110,y:30,button:'left',buttons:['left']});
  await until(()=>starts.length>before);
  guest.sendInputEvent({type:'mouseUp',x:110,y:30,button:'left',clickCount:1});
 }
 assert.equal(starts.length,3);assert.ok(preparations.length>=3);runtime.dispose();win.destroy();server.close();fs.writeFileSync(path.join(__dirname,'passed'),'ok');console.log(JSON.stringify({ok:true,checks:['actual Overview row','trusted dragstart through isolated preload','main-chat and WorkPanel Overview','path-only artifact preview','verified native file payload'],starts}));app.quit();
})().catch(error=>{console.error(error);app.exit(1)});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(output, 'main.cjs')], { env, stdio: 'inherit' });
process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
if (!process.exitCode && !fs.existsSync(path.join(output, 'passed'))) throw Error('Smoke exited before completion: ' + output);
console.log('Artifact guest QA:', output);
