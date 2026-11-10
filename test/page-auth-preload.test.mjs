import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
const require=createRequire(import.meta.url);

test('page auth transport is available only in network top frames and never exposes credentials', async t => {
 const previousFrame=Object.getOwnPropertyDescriptor(process,'isMainFrame'),previousLocation=globalThis.location;
 t.after(()=>{if(previousFrame)Object.defineProperty(process,'isMainFrame',previousFrame);else delete process.isMainFrame;globalThis.location=previousLocation;});
 const exposed=[],calls=[];const old=Module._load;
 Module._load=function(name,parent,...args){if(name==='../shared/brand'&&parent?.filename.endsWith('/preload/page-auth.js'))return {BRAND_ID:'zenmind'};if(name==='electron'&&parent?.filename.endsWith('/preload/page-auth.js'))return {contextBridge:{exposeInMainWorld:(name,value)=>exposed.push({name,value})},ipcRenderer:{invoke:async(...args)=>{calls.push(args);return {ok:true}}}};return old.call(this,name,parent,...args);};
 let install;try{delete require.cache[require.resolve('../dist-electron/preload/page-auth.js')];install=require('../dist-electron/preload/page-auth.js').installPageAuth;}finally{Module._load=old;}
 Object.defineProperty(process,'isMainFrame',{configurable:true,value:true});
 for(const protocol of ['file:','zenmind-local-file:','blob:','data:']){globalThis.location={protocol};install();}
 Object.defineProperty(process,'isMainFrame',{configurable:true,value:false});globalThis.location={protocol:'https:'};install();assert.equal(exposed.length,0);
 Object.defineProperty(process,'isMainFrame',{configurable:true,value:true});
 for(const protocol of ['https:','http:']){globalThis.location={protocol};install();}
 assert.equal(exposed.length,2);assert.equal(exposed[0].name,'__ZENMIND_AUTH__');assert.deepEqual(Object.keys(exposed[0].value),['createSession']);assert.equal(Object.isFrozen(exposed[0].value),true);
 assert.deepEqual(await exposed[0].value.createSession({exchangePath:'/api/session'}),{ok:true});assert.deepEqual(calls,[['webapp.auth.createSession',{exchangePath:'/api/session'}]]);
 const {pageAuthGlobal}=require('../dist-electron/shared/webapp-auth.js');
 assert.equal(pageAuthGlobal('cutej'),'__CUTEJ_AUTH__');assert.equal(pageAuthGlobal('zenmind'),'__ZENMIND_AUTH__');assert.throws(()=>pageAuthGlobal('unknown'));
 Module._load=function(name,parent,...args){if(name==='../shared/brand'&&parent?.filename.endsWith('/preload/page-auth.js'))return {BRAND_ID:'cutej'};if(name==='electron'&&parent?.filename.endsWith('/preload/page-auth.js'))return {contextBridge:{exposeInMainWorld:(name,value)=>exposed.push({name,value})},ipcRenderer:{invoke:async()=>({ok:true})}};return old.call(this,name,parent,...args);};
 try{delete require.cache[require.resolve('../dist-electron/preload/page-auth.js')];require('../dist-electron/preload/page-auth.js').installPageAuth();}finally{Module._load=old;}
 assert.equal(exposed.at(-1).name,'__CUTEJ_AUTH__');
});
