// Actual AppSidebar + Electron Chromium; native services are deterministic fixtures.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "esbuild";
const require = createRequire(import.meta.url);
const repo = process.cwd();
const output = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-primary-navigation-"));
const { APP_BRAND } = require("../dist-electron/shared/brand.js");
const source = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {AppSidebar} from './src/renderer/app-shell/navigation/AppSidebar';
import {PrimaryChatNavigationDebugSetting} from './src/renderer/pages/settings/PrimaryChatNavigationDebugSetting';
import {RendererI18nContext} from './src/renderer/i18n/i18n-context';
import {createTranslator} from './src/shared/i18n';
import './src/renderer/styles.css';
window.electronAPI={assistant:{archiveChat:async id=>{window.qa.archives.push(id);window.qa.clearMain(id);return {ok:true};},getProjectCreationOptions:async()=>({ok:false,message:'fixture'})},sidebarContextMenu:{popup:async request=>{window.qa.menus.push(request);const actionId=window.qa.menuAction;window.qa.menuAction=null;return {actionId};}}};
const epoch=1793000000000;
const chat=(id,agentKey,patch={})=>({chatId:id,chatName:id,agentKey,createdAt:epoch,updatedAt:epoch,lastRunId:'r',lastRunContent:'最新回复摘要',isRead:true,readRunId:'',hasActiveRun:false,hasPendingAwaiting:false,...patch});
const initialAgents=Array.from({length:18},(_,i)=>({agentKey:'agent-'+i,displayName:['普通助理','编程项目','知识库','协作团队','执行器','代理'][i%6]+' '+i,mode:i<5?'BOT':['GENERAL','CODER','KBASE','TEAM','EXECUTOR','PROXY'][i%6],workspaceDir:i===0?'':'/fixture/project-'+i,role:'',recentChats:[chat('recent-'+i,'agent-'+i)],projectChats:[chat('recent-'+i,'agent-'+i)],primaryChat:i===1?undefined:chat('primary-'+i,'agent-'+i,{hasActiveRun:i===2,hasPendingAwaiting:i===3,isRead:i!==4}),chatCount:1,unreadCount:0,unreadChatCount:0,hasPendingAwaiting:false,latestChatId:'recent-'+i,latestPreview:'preview'}));
window.confirm=()=>window.qa.confirm!==false;
window.qa={archives:[],routes:[],histories:[],orders:[],menus:[],agentOrders:[],set:null,state:null};
function Fixture(){
 const [agents,setAgents]=useState(initialAgents);window.qa.clearMain=id=>setAgents(items=>items.map(agent=>agent.primaryChat?.chatId===id?{...agent,primaryChat:undefined}:agent));window.qa.resetOrder=()=>setAgents(initialAgents);
 const [options,setOptions]=useState({primary:true,collapsed:false,windows:false,fullScreen:false,error:''});
 const [route,setRoute]=useState('/');
 window.qa.set=patch=>setOptions(old=>({...old,...patch}));window.qa.state=options;
 const navigate=target=>{window.qa.routes.push(target);setRoute(target);return true;};
 return <div className={'app-shell '+(options.windows?'is-windows-platform':'is-mac-platform')} style={{display:'flex',height:'100vh',width:'100%',background:'var(--bg-base)','--app-sidebar-width':options.collapsed?'64px':'264px'}}>
 <div className='app-sidebar-shell' style={{width:options.collapsed?64:264,height:'100%',minHeight:0,flex:'none'}}><AppSidebar
 isCollapsed={options.collapsed} isMac={!options.windows} isWindows={options.windows}
 assistantLauncherVisible={!route.startsWith('/agent/') && route!=='/kanban'}
 currentPathname={route.split('?')[0]} currentRoute={route} primaryChatNavigation={options.primary} primaryChatNavAgents={agents} primaryChatNavError={options.error} onPrimaryChatNavigationChange={primary=>setOptions(old=>({...old,primary}))}
 sidebarNavOrder={['kanban','schedules','new-chat','chats','group:assistants','group:webs']} onSidebarNavOrderChange={order=>window.qa.orders.push(order)}
 webItems={[]} assistantNavAgents={agents.filter(agent=>agent.agentKey!=='agent-0')} chatNavAgentOptions={agents} chatDefaultAgentKey='agent-5'
 assistantNavChatItems={[chat('ordinary','agent-5'),chat('worker','agent-0')]} assistantPinnedChatItems={[chat('pinned','agent-5'),chat('bot-pinned','agent-0')]}
 assistantNavAgentsLoaded assistantChatPinningSupported assistantChatOrderingSupported
 onOpenChatHistory={key=>window.qa.histories.push(key||'all')} onShareChat={()=>{}}
 onRequestNavigate={navigate} onRequestAgentChatNavigate={navigate}
 onToggleCollapsed={()=>setOptions(old=>({...old,collapsed:!old.collapsed}))}
 toolMenuOpen={false} onRequestToolMenuOpen={()=>{}} onAutoOpenToolMenu={()=>{}} onCloseToolMenu={()=>{}}
 /></div><main style={{flex:1,padding:30}}><PrimaryChatNavigationDebugSetting enabled={options.primary} onChange={primary=>setOptions(old=>({...old,primary}))}/><input id='fixture-draft' defaultValue='keep draft'/><div id='fixture-guest' data-instance='stable'>Chat surface</div></main></div>;
}
createRoot(document.getElementById('root')).render(<RendererI18nContext.Provider value={{locale:'zh-CN',source:'user',t:createTranslator('zh-CN'),setLocale:async()=>{}}}><MemoryRouter><Fixture/></MemoryRouter></RendererI18nContext.Provider>);
`;
await build({ stdin: { contents: source, resolveDir: repo, loader: "tsx" }, outfile: path.join(output,"app.js"), bundle:true, platform:"browser", jsx:"automatic", loader:{".svg":"file",".png":"file",".woff2":"file"}, define:{"process.env.NODE_ENV":'"development"', __DESKTOP_APP_BRAND__:JSON.stringify(APP_BRAND)} });
fs.writeFileSync(path.join(output,"index.html"), '<!doctype html><html lang="zh-CN" data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>');
const checker = `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const output=process.env.PRIMARY_NAVIGATION_QA_DIR;
app.setPath('userData',path.join(output,'profile'));
const errors=[];
const server=http.createServer((request,response)=>{const name=path.basename(new URL(request.url,'http://localhost').pathname)||'index.html';const file=path.join(output,name);response.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html');if(!fs.existsSync(file)){response.writeHead(404);response.end();return;}response.end(fs.readFileSync(file));});
let win;const js=code=>win.webContents.executeJavaScript(code);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(code,attempts=150){for(let n=0;n<attempts;n++){try{if(await js(code))return;}catch{}await delay(20);}throw Error('Timed out: '+code);}
const click=selector=>js('document.querySelector('+JSON.stringify(selector)+').click()');
(async()=>{await app.whenReady();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
win=new BrowserWindow({show:false,width:1280,height:800,useContentSize:true,webPreferences:{contextIsolation:true,nodeIntegration:false}});
win.webContents.on('render-process-gone',(_event,details)=>console.error('Renderer exited:',details));
win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
await win.loadURL('http://127.0.0.1:'+server.address().port);
win.webContents.debugger.attach('1.3');
await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
await until('!!document.querySelector(".sidebar-new-chat-button")');
await until('document.querySelectorAll(".primary-chat-item").length===5');
assert.equal(await js('!!document.querySelector("[data-sidebar-group-id=chats]")'),true);
assert.equal(await js('!!document.querySelector("[data-sidebar-group-id=assistants]")'),true);
assert.equal(await js('document.querySelectorAll("[data-primary-agent-key=agent-5]").length'),0);
await click('[data-primary-agent-key="agent-0"]');
await until('window.qa.routes.length===1');
assert.equal(await js('window.qa.routes.at(-1)'),'/agent/agent-0?chatId=primary-0');
await click('[data-primary-agent-key="agent-1"]');
assert.ok((await js('window.qa.routes.at(-1)')).includes('primaryNewChat=true'));
// Hide only Bots: ordinary groups and the guest remain mounted.
await js('document.querySelector("#fixture-draft").value="untouched draft"');
const routeCount=await js('window.qa.routes.length');
await click('.primary-chat-toggle');
await until('document.querySelectorAll(".primary-chat-item").length===0');
assert.equal(await js('window.qa.routes.length'),routeCount);
assert.equal(await js('document.querySelector("#fixture-draft").value'),'untouched draft');
assert.equal(await js('document.querySelector("#fixture-guest").dataset.instance'),'stable');
assert.equal(await js('!!document.querySelector("[data-sidebar-group-id=chats]")'),true);
await click('.primary-chat-toggle');
await until('document.querySelectorAll(".primary-chat-item").length===5');
await js('window.qa.menuAction="agent.history"');
await click('.primary-chat-history');
await until('window.qa.histories.length===1');
assert.equal(await js('window.qa.histories[0]'),'agent-0');
assert.equal(await js('window.qa.menus.at(-1).target.bot'),true);
assert.equal(await js('window.qa.menus.at(-1).target.canClearPrimary'),true);
for(const key of ['agent-1','agent-2','agent-3']) {
 await js('document.querySelector("[data-primary-agent-key="+'+JSON.stringify(key)+'+"]").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:80,clientY:180}))');
 await delay(40);
 assert.equal(await js('window.qa.menus.at(-1).target.canClearPrimary'),false);
}
await js('window.qa.menuAction="agent.edit";document.querySelector("[data-primary-agent-key=agent-0]").dispatchEvent(new KeyboardEvent("keydown",{key:"F10",shiftKey:true,bubbles:true,cancelable:true}))');
await until('window.qa.routes.length>'+routeCount);
assert.ok((await js('window.qa.routes.at(-1)')).includes('agent-0'));
// Confirmation cancellation and stale/busy guards must never archive.
await js('window.qa.confirm=false;window.qa.menuAction="agent.clear-primary"');
await click('.primary-chat-history');await delay(60);
assert.deepEqual(await js('window.qa.archives'),[]);
await js('window.qa.confirm=true;window.qa.menuAction="agent.clear-primary";document.querySelector("[data-primary-agent-key=agent-2]").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))');
await delay(60);assert.deepEqual(await js('window.qa.archives'),[]);
await click('[data-primary-agent-key="agent-0"]');
await js('window.qa.menuAction="agent.clear-primary"');
await click('.primary-chat-history');
await until('window.qa.archives.length===1');
assert.deepEqual(await js('window.qa.archives'),['primary-0']);
assert.equal(await js('window.qa.routes.at(-1)'),'/agent/agent-0');
await until('document.querySelector("[data-primary-agent-key=agent-0]").textContent.includes("下一条消息")');
for(const windows of [false,true]) {
 for(const collapsed of [false,true]) {
  await js('window.qa.set('+JSON.stringify({windows,collapsed})+')');
  await until('document.querySelectorAll(".primary-chat-item").length===5');
  await delay(100);
  assert.equal(await js('!!document.querySelector(".sidebar-chrome")'),!windows);
  for(const theme of ['light','dark']) {
   await js('document.documentElement.dataset.theme='+JSON.stringify(theme));await delay(50);
   fs.writeFileSync(path.join(output,(windows?'windows':'mac')+'-'+(collapsed?'collapsed':'expanded')+'-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
  }
 }
}
assert.deepEqual(await js('window.qa.orders'),[]);
assert.deepEqual(errors,[]);
fs.writeFileSync(path.join(output,'passed'),'ok');
console.log(JSON.stringify({ok:true,checks:['BOT-only directory','ordinary groups retained','main pointer and new-chat intent','toggle keeps guest and draft','native history/settings/guarded clear menu','macOS/Windows expanded/collapsed','light/dark'],output},null,2));
win.destroy();server.close();app.quit();})().catch(error=>{console.error(error);if(win)win.destroy();server.close();app.exit(1);});
`;
fs.writeFileSync(path.join(output,"checks.cjs"), checker);
const env={...process.env,PRIMARY_NAVIGATION_QA_DIR:output};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require("electron"),[path.join(output,"checks.cjs")],{env,stdio:"inherit"});
process.exitCode=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>resolve(code??1));});

if(process.exitCode===0 && !fs.existsSync(path.join(output,"passed"))) throw new Error(`Electron exited before completing QA: ${output}`);
