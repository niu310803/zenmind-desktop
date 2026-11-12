// Runs the real Chat IPC and Electron startDrag, rather than replacing the native bridge.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "esbuild";
const require = createRequire(import.meta.url);
const output = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-native-chat-drag-"));
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {useChatFileDrag} from './src/renderer/app-shell/navigation/useChatFileDrag';
function Fixture(){const drag=useChatFileDrag(true,message=>{window.errors.push(message||'failed')});return <button id="chat" {...drag.bind('native-chat',1)} style={{margin:40,width:220,height:60}}>Chat Markdown</button>}
window.errors=[];window.nativeDragStarts=[];document.addEventListener('dragstart',event=>window.nativeDragStarts.push(event.isTrusted),true);
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "tsx" }, outfile: path.join(output, "app.js"), bundle: true, platform: "browser", jsx: "automatic" });
fs.writeFileSync(path.join(output, "index.html"), '<!doctype html><div id="root"></div><script src="./app.js"></script>');
fs.writeFileSync(path.join(output, "preload.cjs"), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('electronAPI',{assistant:{prepareChatFileDrag:r=>ipcRenderer.invoke('assistant.prepareChatFileDrag',r),startChatFileDrag:id=>ipcRenderer.invoke('assistant.startChatFileDrag',id),cancelChatFileDrag:id=>{void ipcRenderer.invoke('assistant.cancelChatFileDrag',id)}}});`);
const main = `
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {registerAssistantIpcHandlers}=require(${JSON.stringify(path.join(process.cwd(), "dist-electron/main/modules/assistant/ipc.js"))});
const output=${JSON.stringify(output)};
app.setPath('userData',path.join(output,'profile'));
let win,files=[],completed=false;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{await app.whenReady();
win=new BrowserWindow({show:true,width:420,height:220,x:100,y:100,webPreferences:{preload:path.join(output,'preload.cjs'),contextIsolation:true}});
const native=win.webContents.startDrag.bind(win.webContents);
win.webContents.startDrag=item=>{files.push(item.file);native(item)};
registerAssistantIpcHandlers(ipcMain,{app,platform:process.platform,getMainWindow:()=>win,assistantBridge:{downloadChatExport:async()=>({ok:true,filename:'native-chat.md',bytes:Buffer.from('# Chat\\n你好 Finder\\n')})}});
await win.loadFile(path.join(output,'index.html'));win.webContents.debugger.attach('1.3');
const js=code=>win.webContents.executeJavaScript(code);
for(let n=0; n<100 && !await js('!!document.querySelector("#chat")');n++)await delay(20);
const mouse=(type,x,y,buttons)=>win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'&&!buttons?'none':'left',buttons,clickCount:type==='mouseMoved'?0:1});
await mouse('mouseMoved',80,70,0);
for(let n=0;n<150 && await js('document.querySelector("#chat").getAttribute("aria-busy")==="true"');n++)await delay(20);
await mouse('mousePressed',80,70,1);
await mouse('mouseMoved',130,70,1);
for(let n=0;n<100 && !files.length;n++)await delay(20);
assert.equal(files.length,1,'A real Chromium dragstart must reach Electron native startDrag');
assert.equal(fs.readFileSync(files[0],'utf8'),'# Chat\\n你好 Finder\\n');
assert.deepEqual(await js('window.errors'),[]);
assert.deepEqual(await js('window.nativeDragStarts'),[true],'Only a trusted Chromium dragstart should initiate the native session');
let pasteboard;
if(process.platform==='darwin'){
 pasteboard=execFileSync('/usr/bin/swift',['-module-cache-path','/tmp/zenmind-drag-swift-cache','-e','import AppKit; let p=NSPasteboard(name: .drag); print((p.readObjects(forClasses:[NSURL.self],options:nil) as? [URL] ?? []).map { $0.path }.joined(separator:"|"))'],{encoding:'utf8'}).trim();
 assert.ok(pasteboard.includes(files[0]),'macOS native dragging pasteboard must contain the prepared Markdown URL');
}
await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
await mouse('mouseReleased',130,70,0);
fs.writeFileSync(path.join(output,'passed'),'ok');completed=true;
console.log(JSON.stringify({ok:true,platform:process.platform,nativeFile:files[0],pasteboard,output},null,2));
win.destroy();app.quit();})().catch(error=>{console.error(error);if(win&&!win.isDestroyed())win.destroy();app.exit(1)});
setTimeout(()=>{if(!completed){console.error('Native drag QA timed out');app.exit(1)}},20000).unref();
`;
fs.writeFileSync(path.join(output, "main.cjs"), main);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [path.join(output, "main.cjs")], { env, stdio: "inherit" });
process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
if (!process.exitCode && !fs.existsSync(path.join(output, "passed"))) throw new Error("Electron exited before native drag assertions completed");
