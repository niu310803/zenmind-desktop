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
import {DebugModeContext} from './src/renderer/debug/DebugModeContext';
import {STORAGE_NAMESPACE} from './src/shared/brand';
window.localStorage.setItem(STORAGE_NAMESPACE+':show-bots','false');
import {RendererI18nContext} from './src/renderer/i18n/i18n-context';
import {createTranslator} from './src/shared/i18n';
import './src/renderer/styles.css';
window.electronAPI={assistant:{archiveChat:async id=>{window.qa.archives.push(id);window.qa.clearMain(id);return {ok:true};},getProjectCreationOptions:async()=>({ok:false,message:'fixture'})},sidebarContextMenu:{popup:async request=>{window.qa.menus.push(request);const actionId=window.qa.menuAction;window.qa.menuAction=null;return {actionId};}}};
const epoch=1793000000000;
const chat=(id,agentKey,patch={})=>({chatId:id,chatName:id,agentKey,createdAt:epoch,updatedAt:epoch,lastRunId:'r',lastRunContent:'最新回复摘要',isRead:true,readRunId:'',hasActiveRun:false,hasPendingAwaiting:false,...patch});
const initialAgents=Array.from({length:18},(_,i)=>({agentKey:'agent-'+i,displayName:['普通助理','编程项目','知识库','协作团队','执行器','代理'][i%6]+' '+i,mode:i<5?'BOT':['GENERAL','CODER','KBASE','TEAM','EXECUTOR','PROXY'][i%6],workspaceDir:i===0?'':'/fixture/project-'+i,role:'',recentChats:[chat('recent-'+i,'agent-'+i)],projectChats:[chat('recent-'+i,'agent-'+i)],primaryChat:i===1?undefined:chat('primary-'+i,'agent-'+i,{hasActiveRun:i===2,hasPendingAwaiting:i===3,isRead:i!==4}),chatCount:1,unreadCount:0,unreadChatCount:0,hasPendingAwaiting:false,latestChatId:'recent-'+i,latestPreview:'preview'}));
window.confirm=()=>window.qa.confirm!==false;
window.qa={archives:[],routes:[],histories:[],orders:[],chatOrders:[],menus:[],agentOrders:[],set:null,state:null};
function Fixture(){
 const [agents,setAgents]=useState(initialAgents);window.qa.clearMain=id=>setAgents(items=>items.map(agent=>agent.primaryChat?.chatId===id?{...agent,primaryChat:undefined}:agent));window.qa.resetOrder=()=>setAgents(initialAgents);window.qa.removeBots=()=>setAgents(items=>items.filter(agent=>agent.mode!=='BOT'));window.qa.longText=()=>setAgents(items=>items.map(agent=>agent.agentKey==='agent-4'?{...agent,displayName:'机器人名称很长时应当渐隐而不是省略号'.repeat(4),primaryChat:{...agent.primaryChat,isRead:true,lastRunContent:'机器人回复内容很长时应当渐隐而不是省略号'.repeat(4)}}:agent));
 const [options,setOptions]=useState({debug:false,collapsed:false,windows:false,fullScreen:false,error:''});
 const [route,setRoute]=useState('/');
 window.qa.set=patch=>setOptions(old=>({...old,...patch}));window.qa.state=options;
 const navigate=target=>{window.qa.routes.push(target);setRoute(target);return true;};
 return <DebugModeContext.Provider value={options.debug}><div className={'app-shell '+(options.windows?'is-windows-platform':'is-mac-platform')} style={{display:'flex',height:'100vh',width:'100%',background:'var(--bg-base)','--app-sidebar-width':options.collapsed?'64px':'264px'}}>
 <div className='app-sidebar-shell' style={{width:options.collapsed?64:264,height:'100%',minHeight:0,flex:'none'}}><AppSidebar
 isCollapsed={options.collapsed} isMac={!options.windows} isWindows={options.windows}
 assistantLauncherVisible={!route.startsWith('/agent/') && route!=='/kanban'}
 currentPathname={route.split('?')[0]} currentRoute={route} primaryChatNavAgents={agents} primaryChatNavError={options.error}
 sidebarNavOrder={['kanban','schedules','new-chat','chats','group:assistants','group:webs']} onSidebarNavOrderChange={order=>window.qa.orders.push(order)}
 webItems={[]} assistantNavAgents={agents.filter(agent=>agent.agentKey!=='agent-0')} chatNavAgentOptions={agents} chatDefaultAgentKey='agent-5'
 assistantNavChatItems={[chat('ordinary','agent-5'),chat('ordinary-next','agent-5'),chat('worker','agent-0')]} assistantPinnedChatItems={[chat('pinned','agent-5'),chat('bot-pinned','agent-0')]}
 assistantNavAgentsLoaded assistantChatPinningSupported assistantChatOrderingSupported
 onUpdateAssistantChatOrder={async request=>{window.qa.chatOrders.push(request);return {ok:true,sortMode:'manual'};}}
 onOpenChatHistory={key=>window.qa.histories.push(key||'all')} onShareChat={()=>{}}
 onRequestNavigate={navigate} onRequestAgentChatNavigate={navigate}
 onToggleCollapsed={()=>setOptions(old=>({...old,collapsed:!old.collapsed}))}
 toolMenuOpen={false} onRequestToolMenuOpen={()=>{}} onAutoOpenToolMenu={()=>{}} onCloseToolMenu={()=>{}}
 /></div><main style={{flex:1,padding:30}}><input id='fixture-draft' defaultValue='keep draft'/><div id='fixture-guest' data-instance='stable'>Chat surface</div></main></div></DebugModeContext.Provider>;
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
async function verifyOrdinaryChatDrag() {
 const source='[data-sidebar-chat-id=ordinary]';
 const target='[data-sidebar-chat-id=ordinary-next]';
 await js('document.querySelector('+JSON.stringify(target)+').scrollIntoView({block:"center",behavior:"instant"})');
 const row=selector=>js('document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect().toJSON()');
 const startRect=await row(source), targetRect=await row(target);
 const from={x:Math.round(startRect.left+30),y:Math.round(startRect.top+startRect.height/2)};
 const to={x:from.x+60,y:Math.round(targetRect.top+targetRect.height/2)};
 const outside={x:Math.round(targetRect.right+70),y:to.y};
 const mouse=(type,point,held)=>win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{
  type,...point,button:type==='mouseMoved'&&!held?'none':'left',buttons:held?1:0,clickCount:type==='mouseMoved'?0:1,
 });
 const moveToTarget=async()=>{
  await mouse('mouseMoved',from,false);
  await mouse('mousePressed',from,true);
  // One move crosses the threshold and reaches the destination.
  await mouse('mouseMoved',to,true);
 };
 const start=async()=>{
  await moveToTarget();
  await until('document.querySelector("[data-sidebar-sortable-chat-id=ordinary-next]").classList.contains("has-drop-indicator-after")');
 };
 const routeCount=await js('window.qa.routes.length');
 const orderCount=await js('window.qa.chatOrders.length');
 await start();
 assert.ok(Math.abs((await row('.sidebar-chat-drag-overlay')).left-startRect.left)<1);
 await mouse('mouseReleased',to,false);
 await until('window.qa.chatOrders.length==='+String(orderCount+1)+' && !document.querySelector(".sidebar-chat-drag-overlay")');
 assert.deepEqual(await js('window.qa.chatOrders.at(-1)'),{operation:'move',chatId:'ordinary',afterChatId:'ordinary-next'});

 await start();
 await mouse('mouseMoved',outside,true);
 await until('!document.querySelector(".sidebar-sortable-chat.has-drop-indicator-after, .sidebar-sortable-chat.has-drop-indicator-before")');
 await mouse('mouseReleased',outside,false);
 await until('!document.querySelector(".sidebar-chat-drag-overlay,.sidebar-sortable-chat.is-dragging")');
 assert.equal(await js('window.qa.chatOrders.length'),orderCount+1);

 await moveToTarget();
 await mouse('mouseReleased',to,false);
 await until('window.qa.chatOrders.length==='+String(orderCount+2)+' && !document.querySelector(".sidebar-chat-drag-overlay")');
 assert.deepEqual(await js('window.qa.chatOrders.at(-1)'),{operation:'move',chatId:'ordinary',afterChatId:'ordinary-next'});
 assert.equal(await js('window.qa.routes.length'),routeCount);
}
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
// Bots are direct entries and cannot be hidden, including by old preferences.
assert.equal(await js('!!document.querySelector(".primary-chat-toggle")'),false);
assert.equal(await js('!!document.querySelector(".primary-chat-heading")'),false);
const routeCount=await js('window.qa.routes.length');
await js('window.qa.menuAction="agent.history"');
await click('.primary-chat-history');await delay(60);
assert.equal(await js('window.qa.histories.length'),0);
assert.equal(await js('window.qa.menus.at(-1).target.showHistory'),false);
await js('window.qa.set({debug:true})');await delay(40);
await js('window.qa.menuAction="agent.history"');
await click('.primary-chat-history');
await until('window.qa.histories.length===1');
assert.equal(await js('window.qa.histories[0]'),'agent-0');
assert.equal(await js('window.qa.menus.at(-1).target.bot'),true);
assert.equal(await js('window.qa.menus.at(-1).target.canClearPrimary'),true);
assert.equal(await js('window.qa.menus.at(-1).target.showHistory'),true);
await js('window.qa.set({debug:false})');await delay(40);
await js('window.qa.menuAction="agent.history"');await click('.primary-chat-history');await delay(60);
assert.equal(await js('window.qa.histories.length'),1);
assert.equal(await js('window.qa.menus.at(-1).target.showHistory'),false);
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
await js('window.qa.longText()');
await js('document.activeElement?.blur()');
await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:900,y:100});
await delay(80);
assert.equal(await js('document.querySelector("[data-primary-agent-key=agent-4] .primary-chat-status")===null'),true);
assert.equal(await js('(()=>{const item=document.querySelector("[data-primary-agent-key=agent-4]");const body=item.querySelector(".primary-chat-body");return Math.abs(item.getBoundingClientRect().right-body.getBoundingClientRect().right-8)<1&&getComputedStyle(body).paddingRight==="0px";})()'),true);
const botHoverPoint=await js('(()=>{const rect=document.querySelector("[data-primary-agent-key=agent-4]").getBoundingClientRect();return {x:rect.left+100,y:rect.top+rect.height/2};})()');
await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...botHoverPoint});
await until('getComputedStyle(document.querySelector("[data-primary-agent-key=agent-4] .primary-chat-body")).paddingRight==="24px"');
await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:900,y:100});
await until('getComputedStyle(document.querySelector("[data-primary-agent-key=agent-4] .primary-chat-body")).paddingRight==="0px"');

for(const windows of [false,true]) {
 for(const collapsed of [false,true]) {
  await js('window.qa.set('+JSON.stringify({windows,collapsed})+')');
  await until('document.querySelectorAll(".primary-chat-item").length===5');
  await delay(100);
  assert.equal(await js('!!document.querySelector(".sidebar-chrome")'),!windows);
  if(!collapsed) {
   await until('document.querySelectorAll("[data-primary-agent-key=agent-4] .sidebar-chat-title[data-overflow=true]").length===2');
   assert.equal(await js('Array.from(document.querySelectorAll("[data-primary-agent-key=agent-4] .sidebar-chat-title")).every(element=>getComputedStyle(element).maskImage.includes("linear-gradient")&&getComputedStyle(element).textOverflow==="clip")'),true);
   await js('document.querySelector("[data-primary-agent-key=agent-0]").focus()');
   assert.equal(await js('(()=>{const row=document.querySelector(".primary-chat-row").getBoundingClientRect();const menu=document.querySelector(".primary-chat-history").getBoundingClientRect();return menu.width===24&&menu.height===24&&Math.abs(menu.top+menu.height/2-row.top-row.height/2)<1;})()'),true);
   assert.equal(await js('document.querySelector(".primary-chat-history .sidebar-action-icon")!==null'),true);
  }
  for(const theme of ['light','dark']) {
   await js('document.documentElement.dataset.theme='+JSON.stringify(theme));await delay(50);
   fs.writeFileSync(path.join(output,(windows?'windows':'mac')+'-'+(collapsed?'collapsed':'expanded')+'-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
  }
 }
}
await js('window.qa.removeBots()');
await until('!document.querySelector(".primary-chat-navigation")');
assert.equal(await js('!!document.querySelector("[data-sidebar-group-id=chats]")'),true);
await js('window.qa.set({windows:true,collapsed:false})');
await until('!!document.querySelector("[data-sidebar-chat-id=ordinary-next]")');
await delay(250);
await verifyOrdinaryChatDrag();
assert.deepEqual(await js('window.qa.orders'),[]);
assert.deepEqual(errors,[]);
fs.writeFileSync(path.join(output,'passed'),'ok');
console.log(JSON.stringify({ok:true,checks:['BOT-only directory','ordinary groups retained','Windows layout ordinary chat single-move drag and outside release','main pointer and new-chat intent','always visible direct entries with no heading or toggle','empty bots leave no placeholder','old hidden preference ignored','Debug-only history with live toggle','centered shared pinned more button','long bot name and preview share Chats overflow fade','idle bot text uses full row width and only yields space on hover','native settings/guarded clear menu','macOS/Windows expanded/collapsed','light/dark'],output},null,2));
win.destroy();server.close();app.quit();})().catch(error=>{console.error(error);if(win)win.destroy();server.close();app.exit(1);});
`;
fs.writeFileSync(path.join(output,"checks.cjs"), checker);
const env={...process.env,PRIMARY_NAVIGATION_QA_DIR:output};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require("electron"),[path.join(output,"checks.cjs")],{env,stdio:"inherit"});
process.exitCode=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>resolve(code??1));});

if(process.exitCode===0 && !fs.existsSync(path.join(output,"passed"))) throw new Error(`Electron exited before completing QA: ${output}`);
