import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendClient, auth, assistant, automation, artifact, desktop, connector, skill, kanban } from '../contracts/webapp/bridge.mjs';

test('the public SDK uses eight singular namespaces and reports reserved capabilities', async()=>{
 for(const group of [auth,assistant,automation,artifact,desktop,connector,skill,kanban])assert.equal(Object.isFrozen(group),true);
 assert.equal(desktop.native,undefined);assert.equal(desktop.assistant,undefined);
 await assert.rejects(automation.list(),{code:'not_implemented'});
 await assert.rejects(desktop.screen.capture(),{code:'not_implemented'});
});
test('Node backend SDK uses only the injected loopback scope without DOM access',async(t)=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});let calls=0;
 globalThis.fetch=async(url,options)=>{
  calls++;assert.equal(url,'http://127.0.0.1:17070/webapps/actions/call');
  assert.equal(options.headers.Authorization,'Bearer scoped');assert.equal(options.redirect,'error');
  assert.deepEqual(JSON.parse(options.body),{action:'connector.list',args:{}});
  return new Response(JSON.stringify({ok:true,result:{items:[]}}));
 };
 const client=createBackendClient({url:'http://127.0.0.1:17070/webapps',token:'scoped'});
 assert.deepEqual(await client.connector.list(),{items:[]});assert.equal(client.desktop,undefined);
 await assert.rejects(client.artifact.saveAs({}),{code:'not_implemented'});
 await assert.rejects(client.assistant.image({}),{code:'not_implemented'});assert.equal(calls,1);
 for(const url of ['https://example.test/webapps','http://127.0.0.1:17070','http://user:password@localhost/webapps','http://localhost/webapps?redirect=evil'])assert.throws(()=>createBackendClient({url,token:'scoped'}));
});
test('SDK subscriptions carry cursors, omit protocol internals and stop at terminal',async(t)=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});let calls=0;
 globalThis.fetch=async(_url,options)=>{
  const body=JSON.parse(options.body);assert.deepEqual(body,{action:'assistant.events',args:{runId:'run',cursor:0}});calls++;
  return new Response(JSON.stringify({ok:true,result:{events:[{cursor:1,type:'text.delta',text:'hello'}],cursor:1,terminal:true}}));
 };
 const events=[];for await(const event of assistant.subscribe({runId:'run'}))events.push(event);
 assert.deepEqual(events,[{cursor:1,type:'text.delta',text:'hello'}]);assert.equal(calls,1);
});
test('artifact reads expose bytes rather than filesystem paths',async(t)=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
 globalThis.fetch=async()=>new Response(JSON.stringify({ok:true,result:{dataBase64:Buffer.from('report').toString('base64')}}));
 const stream=await artifact.read({chatId:'chat',artifactId:'report'});
 assert.equal(await new Response(stream).text(),'report');
});

test('execute SDK validates JSON, preserves failure and keeps signal outside the body',async(t)=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});const controller=new AbortController();
 globalThis.fetch=async(_url,options)=>{
  assert.equal(JSON.parse(options.body).action,'assistant.execute');assert.equal(JSON.parse(options.body).args.signal,undefined);
  assert.ok(options.signal);return new Response(JSON.stringify({ok:true,result:{chatId:'chat',status:'failure',reason:'missing'}}));
 };
 const input={message:'extract',input:false,outputSchema:{type:'object'}};
 assert.equal((await assistant.execute(input,{signal:controller.signal})).status,'failure');
 const cycle={};cycle.self=cycle;
 for(const value of [cycle,NaN,new Date(),[,,],{toJSON(){return 'hidden'}}]) await assert.rejects(assistant.execute({...input,input:value}),{code:'invalid_args'});
 await assert.rejects(assistant.execute({...input,skillIds:[]}),{code:'invalid_args'});
 controller.abort();await assert.rejects(assistant.execute(input,{signal:controller.signal}),{code:'cancelled'});
});
test('execute SDK cancellation during response body decoding remains cancelled',async(t)=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});const controller=new AbortController();
 globalThis.fetch=async()=>({ok:true,json:async()=>{controller.abort();throw new DOMException('aborted','AbortError')}});
 await assert.rejects(assistant.execute({message:'test',outputSchema:{type:'object'}},{signal:controller.signal}),{code:'cancelled'});
});

test('execute treats an explicit undefined input as absent and accepts the same 64-level boundary as Main',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});let body;
 globalThis.fetch=async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({ok:true,result:{chatId:'chat',status:'success',output:{}}}))};
 const input={message:'depth',outputSchema:{type:'object'}};
 await assistant.execute({...input,input:undefined});assert.equal(Object.hasOwn(body.args,'input'),false);
 let value='leaf';for(let i=0;i<64;i++)value={nested:value};
 await assistant.execute({...input,input:value});await assert.rejects(assistant.execute({...input,input:{nested:value}}),{code:'invalid_args'});
});

test('Compose bootstrap renews into a short-lived token without replaying business actions', async t => {
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});let sessions=0,actions=0;
 globalThis.fetch=async(url,options)=>{
  if(url==='http://127.0.0.1:17070/webapps/session'){
   sessions++;assert.equal(options.headers.Authorization,'Bearer wbb_fixture');assert.equal(options.redirect,'error');
   return new Response(JSON.stringify({token:'wba_session',expiresAt:Date.now()+600000}));
  }
  actions++;assert.equal(options.headers.Authorization,'Bearer wba_session');
  return new Response(JSON.stringify({ok:true,result:{items:[]}}));
 };
 const client=createBackendClient({url:'http://127.0.0.1:17070/webapps',token:'wbb_fixture'});
 await Promise.all([client.connector.list(),client.connector.list()]);assert.equal(sessions,1);assert.equal(actions,2);
 globalThis.fetch=async()=>new Response(JSON.stringify({ok:false,error:{code:'app_grant_required'}}),{status:403});
 await assert.rejects(client.connector.list(),{code:'app_grant_required'});assert.equal(actions,2);
});

test('rejected Compose bootstrap never sends a business request', async t => {
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});let calls=0;
 globalThis.fetch=async url=>{calls++;assert.equal(url,'http://127.0.0.1:17070/webapps/session');return new Response(JSON.stringify({ok:false,error:{code:'app_grant_required'}}),{status:403})};
 const client=createBackendClient({url:'http://127.0.0.1:17070/webapps',token:'wbb_expired'});
 await assert.rejects(client.connector.list(),{code:'app_grant_required'});assert.equal(calls,1);
});

test('page UI helpers use only history identity and explicit Copilot commands', async t => {
 const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
 const calls = [];
 globalThis.fetch = async (url, options) => {
  assert.equal(url, '/__desktop/actions/call');
  calls.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ ok: true, result: { accepted: true } }));
 };
 assert.equal(Object.isFrozen(desktop.chat), true);
 assert.equal(Object.isFrozen(desktop.copilot), true);
 await desktop.chat.open({ chatId: 'chat / 历史' });
 await desktop.copilot.get(); await desktop.copilot.open(); await desktop.copilot.close();
 assert.deepEqual(calls, [
  { action: 'desktop.chat.open', args: { chatId: 'chat / 历史' } },
  { action: 'desktop.copilot.get', args: {} },
  { action: 'desktop.copilot.open', args: {} },
  { action: 'desktop.copilot.close', args: {} }
 ]);
});

test('file SDK routes upload separately and exposes resource bytes in page and backend',async(t)=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
 const sdk=await import('../contracts/webapp/bridge.mjs');const seen=[];
 globalThis.fetch=async(url,init)=>{
  const body=JSON.parse(init.body);seen.push({url,body});
  return new Response(JSON.stringify({ok:true,result:body.action==='assistant.upload'?{chatId:'owned',upload:{id:'u'}}:{dataBase64:btoa('hello')}}));
 };
 await sdk.assistant.upload({file:new Blob(['hello'],{type:'text/plain'}),name:'hello.txt'});
 assert.equal(seen.at(-1).url,'/__desktop/assistant/uploads');assert.equal(seen.at(-1).body.args.dataBase64,btoa('hello'));
 const backend=sdk.createBackendClient({url:'http://127.0.0.1:1234/webapps',token:'backend'});
 await backend.assistant.upload({file:new Blob(['hello']),chatId:'owned'});
 assert.equal(seen.at(-1).url,'http://127.0.0.1:1234/webapps/uploads');
 assert.equal(await new Response(await backend.assistant.resource.read({chatId:'owned',file:'hello.txt'})).text(),'hello');
 await assert.rejects(sdk.assistant.upload({file:new Blob([new Uint8Array(64*1024*1024+1)])}),{code:'invalid_args'});
 for(const action of ['steer','send','submit','interrupt']){await sdk.assistant[action]({runId:'r'});assert.equal(seen.at(-1).body.action,'assistant.'+action)}
});

test('agent listing and explicit request selection are shared by page and managed backend SDKs',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});const sdk=await import('../contracts/webapp/bridge.mjs');const calls=[];
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init.body);calls.push(body);return new Response(JSON.stringify({ok:true,result:body.action==='assistant.execute'?{chatId:'c',status:'success',output:{}}:{items:[{agentKey:'chosen',name:'Chosen'}],defaultAgentKey:'chosen'}}))};
 for(const client of [sdk,sdk.createBackendClient({url:'http://127.0.0.1:1234/webapps',token:'backend'})]){
  assert.equal((await client.assistant.agents.list()).defaultAgentKey,'chosen');assert.equal(calls.at(-1).action,'assistant.agents.list');
  await client.assistant.chat({message:'hello',agentKey:'chosen'});assert.equal(calls.at(-1).args.agentKey,'chosen');
  if(client===sdk){await client.assistant.execute({message:'extract',outputSchema:{type:'object'},agentKey:'chosen'});assert.equal(calls.at(-1).args.agentKey,'chosen');}
 }
});

test('canonical agent surface uses explicit names and preserves query and observation semantics',async t=>{
 const {agent}=await import('../contracts/webapp/bridge.mjs');const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});const calls=[];
 globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});return new Response(JSON.stringify({ok:true,result:body.action==='agent.events'?{events:[{cursor:1,type:'run.finished'}],cursor:1,terminal:true}:body.action==='agent.resource.read'?{dataBase64:btoa('bytes')}:{chatId:'canonical',runId:'r',accepted:true}}));};
 assert.ok(Object.isFrozen(agent));for(const old of ['chat','stop','subscribe','image','agents'])assert.equal(agent[old],undefined);
 await agent.list();await agent.query({message:'hello',background:true});await agent.upload({file:new Blob(['file']),name:'file.txt'});const events=[];for await(const event of agent.observe({runId:'r'}))events.push(event);await agent.interrupt({runId:'r'});
 assert.deepEqual(calls.map(c=>c.body.action),['agent.list','agent.query','agent.upload','agent.events','agent.interrupt']);assert.equal(calls[2].url,'/__desktop/assistant/uploads');assert.equal(events.length,1);
 const backend=createBackendClient({url:'http://127.0.0.1:17070/webapps',token:'scoped'});await backend.agent.list();assert.equal(calls.at(-1).body.action,'agent.list');
});

test('canonical agent.execute posts canonical action and keeps cancellation',async t=>{
 const {agent}=await import('../contracts/webapp/bridge.mjs');const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
 globalThis.fetch=async(_url,options)=>{assert.equal(JSON.parse(options.body).action,'agent.execute');return new Response(JSON.stringify({ok:true,result:{chatId:'c',status:'success',output:{}}}));};
 await agent.execute({message:'task',outputSchema:{type:'object'}});const controller=new AbortController();controller.abort();await assert.rejects(agent.execute({message:'task',outputSchema:{type:'object'}},{signal:controller.signal}),{code:'cancelled'});
});

test('page execute SDK forwards Chat, references and per-call Agent for both namespaces',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});const {agent}=await import('../contracts/webapp/bridge.mjs');const calls=[];
 globalThis.fetch=async(_url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify({ok:true,result:{chatId:'owned',status:'success',output:{}}}))};
 const input={message:'read attachment',outputSchema:{type:'object'},chatId:'owned',references:[{type:'file',id:'u',name:'invoice.pdf',url:'@chat/invoice.pdf',mimeType:'application/pdf',sizeBytes:128,meta:{page:1}}]};
 for(const client of [assistant,agent]) for(const agentKey of ['invoice-agent','summary-agent']) {
  await client.execute({...input,agentKey});assert.deepEqual(calls.at(-1).args,{...input,agentKey});
 }
 const count=calls.length;
 for(const extra of [{chatId:''},{chatId:12},{references:null},{references:[null]},{references:[{url:12}]},{references:[{sizeBytes:'128'}]},{references:[{sandboxPath:'removed'}]},{agentKey:''}]) await assert.rejects(assistant.execute({...input,...extra}),{code:'invalid_args'});
 assert.equal(calls.length,count);
});
