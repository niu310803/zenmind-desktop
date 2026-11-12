const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const {WebSocketServer}=require('ws');
// Run with Electron: qa/webapp-chat-timeline-smoke.cjs PATH_TO_WEBCLIENT_DIST
const dist=path.resolve(process.argv[2] || '../agent-webclient/dist');
const out=fs.mkdtempSync(require('node:os').tmpdir()+'/webapp-timeline-');app.setPath('userData',out+'/profile');
let server,wss,windows=[],streams=[],requests=[],errors=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const EPOCH=Date.now()-15000;
const ev=(type,seq,payload={},runId='live-run')=>({type,seq,timestamp:EPOCH+seq*1000,chatId:'chat-1',runId,...payload});
const events=[
 ev('request.query',1,{message:'历史请求：检查项目结构'},'old-run'),
 ev('content.start',2,{contentId:'history'},'old-run'),
 ev('content.delta',3,{contentId:'history',delta:'历史结果也应保留'},'old-run'),
 ev('run.complete',4,{},'old-run'),
 ev('request.query',1,{message:'检查项目，展示完整运行过程',requestId:'req-1'}),
 ev('run.start',2,{agentKey:'owner'}),
 ev('reasoning.start',3,{reasoningId:'reason'}),
 ev('reasoning.delta',4,{reasoningId:'reason',delta:'先确认目录结构，再检查配置和工具输出。'}),
 ev('tool.call',5,{toolId:'tool-1',toolName:'bash',toolLabel:'检查项目',arguments:{command:'ls -la'}}),
 ev('content.start',6,{contentId:'answer'}),
 ev('content.delta',7,{contentId:'answer',delta:'## 检查进度\n\n已经读取项目，正在继续运行。\n\n- 配置检查\n- 工具输出'})];
const snapshot=()=>({chatId:'chat-1',agentKey:'owner',firstAgentKey:'owner',firstAgentName:'测试 Agent',display:{defaultDetail:'detailed',effectiveDetail:'detailed'},activeRun:{runId:'live-run',agentKey:'owner',lastSeq:7},events});
const agent={key:'owner',name:'测试 Agent',mode:'GENERAL',interactionConfig:{defaultDetail:'detailed',model:false,accessLevel:false,connectors:false,showPlanningMode:false,showEditingMode:false,showTerminal:false,attachment:{localFiles:false,chatRecords:false,skills:false,kbases:false}}};
const response=(type)=>type==='/api/chat'?snapshot():type==='/api/agent'?agent:type==='/api/agents'?[agent]:type==='/api/chats'?[]:{};
const json=(res,data)=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({code:0,msg:'ok',data}));
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r('http://127.0.0.1:'+s.address().port)));
async function until(fn,label){for(let i=0;i<300;i++){if(await fn())return;await pause(50)}throw new Error('Timeout: '+label)}
async function js(w,s){return w.webContents.executeJavaScript(s,true)}
function clean(code){windows.forEach(w=>w.destroy());wss?.clients.forEach(s=>s.terminate());wss?.close();server?.close();app.exit(code)}
const watchdog=setTimeout(()=>{console.error('watchdog');clean(1)},60000);
app.whenReady().then(async()=>{
 server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname==='/runtime-config.js')return res.writeHead(200,{'Content-Type':'text/javascript'}).end('globalThis.__AGENT_WEBCLIENT_RUNTIME_CONFIG__={BACKEND_MODE:"platform",DESKTOP_APP:"false"}');
  if(url.pathname.startsWith('/api/')){requests.push(req.method+' '+url.pathname);return json(res,response(url.pathname));}
  let relative=decodeURIComponent(url.pathname).slice(1);
  if(!path.extname(relative))relative='index.html';
  const f=path.resolve(dist,relative);if(!f.startsWith(dist+'/'))return res.writeHead(404).end();
  try {res.writeHead(200,{'Content-Type':f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':f.endsWith('.html')?'text/html':f.endsWith('.svg')?'image/svg+xml':'application/octet-stream'});res.end(await fs.promises.readFile(f));}catch{res.writeHead(404).end();}
 });const origin=await listen(server);
 wss=new WebSocketServer({server});wss.on('connection',s=>{
  s.send(JSON.stringify({frame:'push',type:'connected',data:{protocolVersion:2,sessionId:'fixture',serverTime:Date.now(),liveness:{heartbeatIntervalMs:15000,silenceTimeoutMs:45000}}}));
  s.on('message',raw=>{const msg=JSON.parse(raw);requests.push('WS '+msg.type);
   if(msg.type==='/api/attach')streams.push({s,id:msg.id});
   else s.send(JSON.stringify({frame:'response',id:msg.id,type:msg.type,code:0,data:response(msg.type)}));
  });
 });
 async function open(route){const w=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});windows.push(w);w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});await w.loadURL(origin+route);return w;}
 const inline=await open('/chat-preview/chat-1?presentation=timeline&lang=zh-CN&theme=light');
 await until(()=>js(inline,'document.querySelector(".conversation-stage-virtuoso[data-detail-level=detailed]")!==null'),'official timeline in inline route');
 await until(()=>js(inline,'document.body.innerText.includes("检查进度")'),'content');
 assert.equal(await js(inline,'document.querySelectorAll("textarea,[contenteditable=true]").length'),0);
 await until(()=>streams.length>0,'live attach');
 for(const {s,id} of streams)s.send(JSON.stringify({frame:'stream',id,event:ev('content.delta',8,{contentId:'answer',delta:'\n\n实时更新已到达。'})}));
 await until(()=>js(inline,'document.body.innerText.includes("实时更新已到达")'),'live delta');
 for(const {s,id} of streams)s.send(JSON.stringify({frame:'stream',id,event:ev('tool.output',9,{toolId:'tool-1',toolName:'bash',chunkIndex:0,stream:'stdout',delta:'live-tool-progress\n'})}));
 await until(()=>js(inline,'document.querySelector(".xterm")!==null'),'actual tool output terminal');
 await pause(500);
 fs.writeFileSync(out+'/inline.png',(await inline.webContents.capturePage()).toPNG());
 // Read history as well as the active Run.
 await js(inline,'document.getElementById("messages").scrollTop=0');
 await until(()=>js(inline,'document.body.innerText.includes("历史结果也应保留")'),'complete history');
 fs.writeFileSync(out+'/history.png',(await inline.webContents.capturePage()).toPNG());
 const official=await open('/agent/owner?chatId=chat-1&lang=zh-CN&theme=light');
 await until(()=>js(official,'document.querySelector(".conversation-stage-virtuoso[data-detail-level=detailed]")!==null'),'normal chat page');
 await until(()=>js(official,'document.body.innerText.includes("检查进度")'),'normal content');
 await until(()=>streams.length>=2,'normal live attach');
 for(const {s,id} of streams) {
  s.send(JSON.stringify({frame:'stream',id,event:ev('content.delta',8,{contentId:'answer',delta:'\n\n实时更新已到达。'})}));
  s.send(JSON.stringify({frame:'stream',id,event:ev('tool.output',9,{toolId:'tool-1',toolName:'bash',chunkIndex:0,stream:'stdout',delta:'live-tool-progress\n'})}));
 }
 await until(()=>js(official,'document.querySelector(".xterm")!==null'),'normal tool output terminal');
 await pause(800);
 const inspect=`(()=>{const e=document.querySelector('.timeline-row[data-kind="content"] .timeline-markdown')||document.querySelector('.timeline-row[data-kind="content"]');const s=getComputedStyle(e);const v=document.querySelector('.conversation-stage-virtuoso');return {fontSize:s.fontSize,lineHeight:s.lineHeight,color:s.color,detail:v.dataset.detailLevel,rowClasses:document.querySelector('.timeline-row[data-kind="content"]').className,readingWidth:v.firstElementChild.getBoundingClientRect().width}})()`;
 const inlineStyle=await js(inline,inspect),officialStyle=await js(official,inspect);
 assert.deepEqual(inlineStyle,officialStyle);
 fs.writeFileSync(out+'/official.png',(await official.webContents.capturePage()).toPNG());
 assert.ok(!requests.some(r=>/\/(query|interrupt|submit|steer)\b/.test(r)));
 const result={ok:true,inlineStyle,officialStyle,requests,errors,evidence:out};fs.writeFileSync(out+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));clearTimeout(watchdog);clean(0);
}).catch(async e=>{console.error(e);for(let i=0;i<windows.length;i++){console.error(await js(windows[i],'document.body.innerText').catch(()=>''));fs.writeFileSync(out+'/failure-'+i+'.png',(await windows[i].webContents.capturePage()).toPNG());}console.error({requests,errors});clearTimeout(watchdog);clean(1)});
