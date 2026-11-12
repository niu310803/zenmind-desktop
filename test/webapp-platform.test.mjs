import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseWebappManifest } = require('../dist-electron/shared/webapp-manifest.js');
const { webappPlatformLayout } = require('../dist-electron/main/modules/webs/webapps/platform-layout.js');
const { preserveWebappInstallForRecovery, activateWebappInstall, commitWebappInstall, rollbackWebappInstall, recoverWebappInstallTransactions } = require('../dist-electron/main/modules/webs/webapps/install-transaction.js');
const { getDesktopWebappStateRoot, getDesktopWebappInstallStagingRoot } = require('../dist-electron/main/infrastructure/filesystem/user-paths.js');
const { validateWebappPackageDirectory } = require('../dist-electron/main/modules/webs/webapps/package-validation.js');
const { readInstalledWebappItems, readWebappItems, getWebappDir } = require('../dist-electron/main/modules/webs/webapps/store.js');
const { getWebappAllowedActions } = require('../dist-electron/main/modules/webs/webapps/capability-policy.js');
const { platformLaunchOptions, validateReady, WebappPlatformInstances } = require('../dist-electron/main/modules/webs/webapps/platform-instances.js');
const { registerService, clearServices } = require('../dist-electron/main/modules/services/service-registry.js');
const id = 'webapp-0123456789abcdef';
const manifest = (overrides = {}) => parseWebappManifest({ schemaVersion: 2, id, key:'platform-demo',label:'Platform demo',version:'1.0.0',target:'any',hosting:'platform',minPlatformVersion:'0.5.0',frontend:{root:'frontend',index:'index.html'}, ...overrides });
function fixture(t) {
 const home = fs.mkdtempSync(path.join(os.tmpdir(),'webapp-platform-'));
 t.after(() => fs.rmSync(home,{recursive:true,force:true}));
 const app = { getPath: name => name === 'home' ? home : path.join(home,name), getAppPath: () => process.cwd() };
 const layout = webappPlatformLayout(app,id);
 const incoming = () => { const root = fs.mkdtempSync(path.join(getDesktopWebappInstallStagingRoot(app),'package-')); fs.mkdirSync(path.join(root,'frontend')); fs.writeFileSync(path.join(root,'webapp.json'),JSON.stringify(manifest())); fs.writeFileSync(path.join(root,'frontend','index.html'),'new'); return root; };
 fs.mkdirSync(getDesktopWebappInstallStagingRoot(app),{recursive:true});
 fs.mkdirSync(layout.runtime,{recursive:true});
 return {app,layout,incoming,home};
}
test('Platform installs replace package entries and preserve every runtime data partition', async t => {
 const {app,layout,incoming} = fixture(t);
 for (const name of ['chats','memory','pan','.state','webapp-data','registries','owner','root']) { fs.mkdirSync(path.join(layout.runtime,name)); fs.writeFileSync(path.join(layout.runtime,name,'keep'),'data'); }
 let tx = await activateWebappInstall({app,id,installPath:layout.runtime,stagingPath:incoming(),hosting:'platform'});
 await commitWebappInstall(app,tx);
 assert.equal(getWebappDir(app,id),layout.runtime);
 assert.equal(readInstalledWebappItems(app)[0].hosting,'platform');
 assert.equal(readWebappItems(app,process.platform,{readInstalledRecords:() => []})[0].installPath,layout.runtime);
 fs.mkdirSync(path.join(layout.runtime,'backend')); fs.writeFileSync(path.join(layout.runtime,'backend','old.mjs'),'old');
 tx = await activateWebappInstall({app,id,installPath:layout.runtime,stagingPath:incoming(),hosting:'platform'});
 assert.equal(fs.existsSync(path.join(layout.runtime,'backend')),false);
 await rollbackWebappInstall(app,tx);
 assert.equal(fs.readFileSync(path.join(layout.runtime,'backend','old.mjs'),'utf8'),'old');
 for (const name of ['chats','memory','pan','.state','webapp-data','registries','owner','root']) assert.equal(fs.readFileSync(path.join(layout.runtime,name,'keep'),'utf8'),'data');
});
test('interrupted activation rolls back rather than committing an unverified package', async t => {
 const {app,layout,incoming} = fixture(t);
 fs.mkdirSync(path.join(layout.runtime,'frontend')); fs.writeFileSync(path.join(layout.runtime,'frontend','index.html'),'old');
 fs.writeFileSync(path.join(layout.runtime,'webapp.json'),JSON.stringify(manifest()));
 const tx = await activateWebappInstall({app,id,installPath:layout.runtime,stagingPath:incoming(),hosting:'platform'});
 preserveWebappInstallForRecovery(app,tx);
 assert.deepEqual(await recoverWebappInstallTransactions(app),[id]);
 assert.equal(fs.readFileSync(path.join(layout.runtime,'frontend','index.html'),'utf8'),'old');
 assert.equal(fs.existsSync(tx.backupPath),false);
});
test('journal recovery rejects escapes and preserves the invalid journal', async t => {
 const {app,layout,incoming} = fixture(t);
 const tx = await activateWebappInstall({app,id,installPath:layout.runtime,stagingPath:incoming(),hosting:'platform'});
 const file = path.join(getDesktopWebappStateRoot(app,id),'platform-install.json');
 fs.writeFileSync(file,JSON.stringify({...tx,backupPath:path.dirname(layout.runtime)}));
 preserveWebappInstallForRecovery(app,tx);
 const { readPlatformInstallTransaction } = require('../dist-electron/main/modules/webs/webapps/platform-install.js');
 assert.throws(() => readPlatformInstallTransaction(app,id),/Invalid Platform install journal/);
 assert.deepEqual(await recoverWebappInstallTransactions(app),[]);
 assert.equal(fs.existsSync(file),true);
});
test('package validation rejects runtime data and missing packaged Agents or skills', t => {
 const {incoming} = fixture(t); const root = incoming();
 fs.mkdirSync(path.join(root,'chats')); assert.throws(() => validateWebappPackageDirectory(root,manifest()),/runtime data/);
 fs.rmSync(path.join(root,'chats'),{recursive:true});
 const m = manifest({copilot:{agentKey:'reviewer',references:[{type:'skill',id:'clause-check'}]}});
 assert.throws(() => validateWebappPackageDirectory(root,m),/agents\/reviewer/);
 fs.mkdirSync(path.join(root,'agents','reviewer'),{recursive:true}); fs.writeFileSync(path.join(root,'agents','reviewer','agent.yml'),'key: reviewer');
 assert.throws(() => validateWebappPackageDirectory(root,m),/clause-check/);
 fs.mkdirSync(path.join(root,'skills-center','clause-check'),{recursive:true}); fs.writeFileSync(path.join(root,'skills-center','clause-check','SKILL.md'),'# Skill');
 validateWebappPackageDirectory(root,m);
 for (const scope of ['localPageGateway','backendActionToken']) assert.deepEqual(getWebappAllowedActions(m,scope),[]);
});
test('ready files bind the exact child PID and separate private origins', () => {
 const valid = {pid:42,apiUrl:'http://127.0.0.1:1234',appUrl:'http://127.0.0.1:1235',platformVersion:'0.6.0'};
 assert.deepEqual(validateReady(valid,42),valid);
 for (const override of [{pid:43},{appUrl:valid.apiUrl},{apiUrl:'http://example.com:1234'},{appUrl:'http://127.0.0.1:1235/?ticket=secret'},{apiUrl:'http://user:pass@127.0.0.1:1234'}]) assert.throws(() => validateReady({...valid,...override},42));
});
test('macOS and Windows use explicit node entries and process ownership flags', t => {
 const {app} = fixture(t); clearServices();
 registerService({kind:'builtin',id:'agent-platform',name:'Platform',version:'0.6.0',backend:{entry:'backend/agent-platform'},frontend:{mode:'none'},scripts:{start:'start.sh',stop:'stop.sh'}}, {defaultKind:'builtin'});
 t.after(clearServices);
 for (const platform of ['darwin','win32']) {
  const options = platformLaunchOptions(app,manifest(),platform);
  assert.equal(path.basename(options.node), platform === 'win32' ? 'node.exe' : 'node');
  assert.equal(options.detached,platform === 'darwin'); assert.equal(options.windowsHide,platform === 'win32');
  assert.ok(options.args.includes('--webapp-host=single')); assert.ok(options.args.includes('--runtime-mode=standalone')); assert.ok(options.args.includes(`--parent-pid=${process.pid}`));
  assert.equal(options.env.AP_RUNTIME_DIR,options.layout.runtime);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE,undefined);
 }
 assert.throws(() => platformLaunchOptions(app,manifest(),'linux'),/macOS or Windows/);
});

test('idle recycling requires both API tasks and application page traffic to be idle', () => {
 const { shouldRecyclePlatform } = require('../dist-electron/main/modules/webs/webapps/platform-instances.js');
 const now = 10_000_000, old = now - 30*60_000;
 const activity = { idle:true,activeRuns:0,awaitingRuns:0,activeRequests:0,lastRequestAt:old };
 assert.equal(shouldRecyclePlatform(activity,undefined,now),true);
 for (const override of [{idle:false},{activeRuns:1},{awaitingRuns:1},{activeRequests:1},{lastRequestAt:now},{lastRequestAt:'0'},{lastRequestAt:NaN}]) assert.equal(shouldRecyclePlatform({...activity,...override},undefined,now),false);
 assert.equal(shouldRecyclePlatform(activity,{lastRequestAt:now,activeRequests:new Map()},now),false);
 assert.equal(shouldRecyclePlatform(activity,{lastRequestAt:old,activeRequests:new Map([[1,42]])},now),false);
 assert.equal(shouldRecyclePlatform(null,undefined,now),false);
});
test('stop cancels a queued startup before any process can be spawned', async t => {
 const { app } = fixture(t); const instances = new WebappPlatformInstances(() => {}), item = {...manifest(),entryKey:`webapp:${id}`,kind:'webapp'};
 const starting = instances.start(app,item), stopping = instances.stop(app,item);
 assert.equal((await starting).ok,false);
 assert.equal((await stopping).ok,true);
 assert.equal(instances.status(id),null);
});
test('ticket POST Origin is bound to exactly one guest and one exchange request', async () => {
 const { postPlatformTicket } = require('../dist-electron/main/modules/webs/webapps/platform-navigation.js');
 let beforeHeaders;
 const session = { webRequest:{ onBeforeSendHeaders:(_filter,fn)=>{beforeHeaders=fn;} } };
 const action = 'http://127.0.0.1:1235/__desktop/session/exchange';
 const guest = {id:42,session,loadURL:async (url,options) => {
  assert.equal(url,action); assert.equal(options.postData[0].bytes.toString(),'ticket=one-time');
  const request = (webContentsId,url) => { let headers; beforeHeaders({webContentsId,url,method:'POST',requestHeaders:{Origin:'null'}},result=>{headers=result.requestHeaders;}); return headers.Origin; };
  assert.equal(request(43,action),'null'); assert.equal(request(42,'http://127.0.0.1:1235/other'),'null');
  assert.equal(request(42,action),'http://127.0.0.1:1234'); assert.equal(request(42,action),'null');
 }};
 await postPlatformTicket(guest,action,'http://127.0.0.1:1234','one-time');
});
test('private app traffic includes business requests and retains upgraded streams until guest disposal', async () => {
 const { EventEmitter } = await import('node:events');
 const { observePlatformPageTraffic } = require('../dist-electron/main/modules/webs/webapps/platform-navigation.js');
 const handlers = {};
 const session = {webRequest:{onBeforeRequest:(_filter,fn)=>{handlers.start=fn;},onCompleted:fn=>{handlers.done=fn;},onErrorOccurred:fn=>{handlers.error=fn;}}};
 const guest = Object.assign(new EventEmitter(),{id:42,session});
 const traffic = observePlatformPageTraffic(guest,'http://127.0.0.1:1235');
 observePlatformPageTraffic(guest,'http://127.0.0.1:1235'); assert.equal(guest.listenerCount('destroyed'),1);
 handlers.start({id:1,webContentsId:42,url:'http://127.0.0.1:1235/api/work'},()=>{}); assert.equal(traffic.activeRequests.size,1);
 handlers.done({id:1,statusCode:200}); assert.equal(traffic.activeRequests.size,0);
 handlers.start({id:2,webContentsId:42,url:'ws://127.0.0.1:1235/api/events'},()=>{}); handlers.done({id:2,statusCode:101}); assert.equal(traffic.activeRequests.size,1);
 guest.emit('destroyed'); assert.equal(traffic.activeRequests.size,0);
});
test('minimum Platform versions use SemVer prerelease precedence', () => {
 const { platformVersionSatisfies } = require('../dist-electron/main/modules/webs/webapps/platform-instances.js');
 for (const [actual,minimum,expected] of [['v0.5.46','0.5.46',true],['0.5.46','0.6.0',false],['0.6.0-alpha.2','0.6.0-alpha.1',true],['0.6.0-alpha.2','0.6.0',false],['0.6.0-beta','0.6.0-alpha.9',true],['0.6.0','0.6.0-rc.1',true],['0.6.0-alpha','0.6.0-alpha.1',false],['invalid','0.5.0',false]]) assert.equal(platformVersionSatisfies(actual,minimum),expected);
});
test('a deferred install can recover after process cleanup without remaining owned by the failed installer', async t => {
 const { app,layout,incoming } = fixture(t);
 const { preserveWebappInstallForRecovery } = require('../dist-electron/main/modules/webs/webapps/install-transaction.js');
 const { hasActivePlatformInstall } = require('../dist-electron/main/modules/webs/webapps/platform-install.js');
 const tx = await activateWebappInstall({app,id,installPath:layout.runtime,stagingPath:incoming(),hosting:'platform'});
 assert.equal(hasActivePlatformInstall(app,id),true);
 preserveWebappInstallForRecovery(app,tx); assert.equal(hasActivePlatformInstall(app,id),false);
 assert.deepEqual(await recoverWebappInstallTransactions(app),[id]);
 assert.equal(fs.existsSync(path.join(layout.runtime,'webapp.json')),false);
});

test('Platform recovery observes admission and cannot modify an active installation', async t => {
 const {app,layout,incoming} = fixture(t);
 const { hasPendingWebappInstallTransaction } = require('../dist-electron/main/modules/webs/webapps/install-transaction.js');
 const tx = await activateWebappInstall({app,id,installPath:layout.runtime,stagingPath:incoming(),hosting:'platform'});
 assert.equal(hasPendingWebappInstallTransaction(app,id),true);
 assert.deepEqual(await recoverWebappInstallTransactions(app),[]);
 assert.equal(fs.readFileSync(path.join(layout.runtime,'frontend','index.html'),'utf8'),'new');
 preserveWebappInstallForRecovery(app,tx);
 assert.deepEqual(await recoverWebappInstallTransactions(app,{beforeRecovery:async transaction => {
  assert.equal(transaction.schemaVersion,2);
  return false;
 }}),[]);
 assert.equal(hasPendingWebappInstallTransaction(app,id),true);
 assert.deepEqual(await recoverWebappInstallTransactions(app,{beforeRecovery:async () => true}),[id]);
 assert.equal(hasPendingWebappInstallTransaction(app,id),false);
});

test('an invalid Platform journal does not prevent an unrelated Desktop transaction from recovering', async t => {
 const {app,layout,incoming} = fixture(t);
 const { getDesktopWebappsDataRoot } = require('../dist-electron/main/infrastructure/filesystem/user-paths.js');
 const tx = await activateWebappInstall({app,id,installPath:layout.runtime,stagingPath:incoming(),hosting:'platform'});
 preserveWebappInstallForRecovery(app,tx);
 const journal = path.join(getDesktopWebappStateRoot(app,id),'platform-install.json');
 fs.writeFileSync(journal,JSON.stringify({...tx,backupPath:path.dirname(layout.runtime)}));
 const otherId = 'webapp-unrelated';
 const otherPath = path.join(getDesktopWebappsDataRoot(app),otherId);
 fs.mkdirSync(path.dirname(otherPath),{recursive:true});
 await activateWebappInstall({app,id:otherId,installPath:otherPath,stagingPath:incoming()});
 assert.deepEqual(await recoverWebappInstallTransactions(app),[otherId]);
 assert.equal(fs.existsSync(journal),true);
 assert.equal(fs.existsSync(path.join(otherPath,'webapp.json')),true);
});
