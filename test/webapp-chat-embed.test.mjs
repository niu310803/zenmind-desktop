import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {desktop,createBackendClient} from '../contracts/webapp/bridge.mjs';
const require=createRequire(import.meta.url);
const {parseWebappChatEmbed}=require('../dist-electron/shared/webapp-chat-embed.js');
const {createSurfaceIdentity,surfaceIdentityMatchesPolicy}=require('../dist-electron/shared/surface-identity.js');
const {resolveAgentWebclientWebviewSurfaceType}=require('../dist-electron/shared/webview-context-menu.js');
const input={chatId:'chat',viewId:'view-1',revision:1,bounds:{x:10,y:-20,width:600,height:480,viewportWidth:1000,viewportHeight:800}};
test('inline geometry accepts viewport coordinates and rejects URLs, extra fields and invalid revisions',()=>{
 assert.deepEqual(parseWebappChatEmbed(input),input);assert.ok(parseWebappChatEmbed({...input,bounds:null}));
 for(const value of [{...input,revision:0},{...input,url:'https://other.test'},{...input,bounds:{...input.bounds,width:Infinity}},{...input,bounds:{...input.bounds,height:-1}},{...input,viewId:'bad/id'}])assert.equal(parseWebappChatEmbed(value),null);
});
test('inline WebClient has its own read-only surface identity, not a Kanban identity',()=>{
 const identity=createSurfaceIdentity('webapp-chat','app-1',{ownerChatId:'chat'});
 assert.equal(identity.surfaceRole,'webapp-chat');assert.equal(identity.interaction,'read-only');assert.ok(surfaceIdentityMatchesPolicy(identity,'app-1'));assert.equal(resolveAgentWebclientWebviewSurfaceType('webapp-chat'),'agent-chat');
});
test('page embed sends only the explicit mount contract; backend has no UI namespace',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);const calls=[];
 globalThis.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify({ok:true,result:{chatId:'chat',status:'embedded'}}));};
 await desktop.chat.embed(input);assert.deepEqual(calls,[{action:'desktop.chat.embed',args:input}]);assert.equal(createBackendClient({url:'http://127.0.0.1:1234/webapps',token:'fixture'}).desktop,undefined);
});
