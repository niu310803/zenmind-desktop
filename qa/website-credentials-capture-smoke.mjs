// Verifies login recognition against real pages in a real Chromium: the observer script runs in
// an isolated world of every frame of pages served for https://login.test (and an identity
// provider at https://sso.test, in an iframe or after a hand-over), and the capture controller
// decides whether to offer saving. Iframes are reached through the web guest preload's relay.
// Run after `npm run build:main:prepared`:
//   node qa/website-credentials-capture-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const repo = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'website-credentials-capture-'));
const modulePath = name => JSON.stringify(path.join(repo, 'dist-electron/main/modules/credentials', name));

fs.writeFileSync(path.join(temp, 'main.cjs'), `
const {app,BrowserWindow,ipcMain,protocol,session}=require('electron');const path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile')); app.on('window-all-closed',()=>{});
const {createWebsiteCredentialStore}=require(${modulePath('store.js')});
const {createLoginCapture}=require(${modulePath('capture/controller.js')});
const {createAgentCredentialAccess}=require(${modulePath('fill/agent-access.js')});
const {createLoginFrameRelay}=require(${modulePath('frames.js')});
const relay=createLoginFrameRelay(ipcMain);
// The sandboxed web guest preload, running in iframes too, as Desktop attaches it to Website and WorkPanel pages.
const guestPreferences={contextIsolation:true,nodeIntegration:false,sandbox:true,nodeIntegrationInSubFrames:true,preload:${JSON.stringify(path.join(repo, 'dist-electron/preload/webapp-auth.js'))}};
const queue=require(${modulePath('../web-surfaces/cdp/command-queue.js')});
const page=body=>new Response('<!doctype html><meta charset="utf-8"><body>'+body,{headers:{'content-type':'text/html'}});
const pages={
  // Classic form: a full-page POST that lands on a page without a password field.
  '/classic':'<form method="post" action="/home"><input name="email" type="email"><input name="pw" type="password"><button>Sign in</button></form>',
  '/home':'<h1>Welcome</h1>',
  // Rejected login: the server answers with the same form again.
  '/rejected':'<form method="post" action="/rejected"><input name="user"><input name="pw" type="password"><button>Sign in</button></form>',
  // Single-page app: no <form>, a script swaps the view after "signing in".
  '/spa':'<div id="view"><input id="account" autocomplete="username"><input id="secret" type="password"><div role="button" id="go">Log in</div></div><script>go.onclick=()=>{setTimeout(()=>{view.innerHTML="<h1>Dashboard</h1>"},50)}</script>',
  // Two-step: identifier first, password on the next page.
  '/step1':'<form action="/step2"><input name="identifier" type="email"><button>Next</button></form>',
  '/step2':'<form method="post" action="/home"><input name="pw" type="password"><button>Sign in</button></form>',
  // Sign-up: the new password is typed twice; a hidden decoy password field must be ignored.
  '/signup':'<form method="post" action="/home"><input name="email" type="email"><input name="pw1" type="password"><input name="pw2" type="password"><input name="trap" type="password" style="display:none" value="decoy"><button>Create</button></form>',
  // A "show password" eye button switches the field to plain text without submitting anything.
  '/reveal':'<form method="post" action="/home"><input name="email" type="email"><input name="pw" type="password"><button type="button" id="eye">Show</button><button id="submit">Sign in</button></form><script>eye.onclick=()=>{const pw=document.querySelector("[name=pw]");pw.type=pw.type==="password"?"text":"password"}</script>',
  // A framework-style page: it only trusts values it received through input events.
  '/controlled':'<div id="view"><input id="account" autocomplete="username"><input id="secret" type="password"><button id="go">Log in</button></div><script>const state={u:"",p:""};account.addEventListener("input",e=>state.u=e.target.value);secret.addEventListener("input",e=>state.p=e.target.value);go.onclick=()=>{view.innerHTML="<h1 id=who>"+state.u+"/"+state.p.length+"</h1>"}</script>',
  // After "logging in" the page hides the password field, or turns it into plain text, but keeps the element and its value.
  '/hide':'<div id="view"><input id="account" autocomplete="username"><input id="secret" type="password"><button id="go">Log in</button></div><h1 id="done" hidden>Welcome</h1><script>window.keep=secret;go.onclick=()=>{setTimeout(()=>{secret.style.display="none";account.style.display="none";go.style.display="none";done.hidden=false},50)}</script>',
  '/totext':'<div id="view"><input id="account" autocomplete="username"><input id="secret" type="password"><button id="go">Log in</button></div><script>window.keep=secret;go.onclick=()=>{setTimeout(()=>{secret.type="text"},50)}</script>',
  // Sign-up and reset with a single password field: never filled.
  '/signup-single':'<form method="post" action="/home"><input name="email" type="email"><input name="pw" type="password" autocomplete="new-password"><button>Create account</button></form>',
  '/reset':'<form method="post" action="/reset-password"><input name="email" type="email"><input name="pw" type="password"><button>Reset password</button></form>',
  // The page swaps one login form for another after a first fill was left for the user.
  '/swap':'<div id="a"><input id="ua" autocomplete="username"><input id="pa" type="password"><button id="ga">Log in</button></div><div id="b" style="display:none"><input id="ub" autocomplete="username"><input id="pb" type="password"><button id="gb">Log in</button></div><script>window.keepA=pa;function swap(){a.style.display="none";b.style.display=""}</script>',
  // A form-less login page that also offers sign-up: the plain "Log in" button makes it a login.
  '/login-or-signup':'<div id="view"><input id="account" autocomplete="username"><input id="secret" type="password"><button id="go">Log in</button><button>Create account</button></div><script>go.onclick=()=>{view.innerHTML="<h1>Hi</h1>"}</script>',
  // Sign-up without a <form>: the only button creates an account.
  '/signup-noform':'<div><input id="email" type="email"><input id="pw" type="password"><button id="go">Create account</button></div>',
  // Not a login: a search box must never produce anything.
  '/search':'<form action="/home"><input name="q" type="text"><button>Search</button></form>',
  // A styled <div> drawn as the login button, labelled in Chinese.
  '/div-button':'<div id="view"><input id="account" autocomplete="username"><input id="secret" type="password"><div id="go" style="cursor:pointer;display:inline-block;padding:4px 12px">登 录</div></div><script>go.onclick=()=>{setTimeout(()=>{view.innerHTML="<h1>Dashboard</h1>"},50)}</script>',
  // A link inside the form that leaves for another page: not a login attempt.
  '/forgot':'<form method="post" action="/home"><input name="email" type="email"><input name="pw" type="password"><a id="forgot" href="/home">Forgot password?</a><button>Sign in</button></form>',
  // A slider check over the form after "log in"; the user takes longer than a few seconds.
  '/captcha':'<div id="view"><input id="account" autocomplete="username"><input id="secret" type="password"><button id="go">登录</button><div id="check" hidden>slide to verify</div></div><script>go.onclick=()=>{check.hidden=false};window.pass=()=>{view.innerHTML="<h1>Welcome</h1>"}</script>',
  // A refused login: the page empties the password and shows an error; the user then leaves.
  '/refused':'<div id="view"><input id="account" autocomplete="username"><input id="secret" type="password"><button id="go">Log in</button><p id="err" hidden>Wrong password</p><a id="away" href="/home">Home</a></div><script>go.onclick=()=>{setTimeout(()=>{secret.value="";err.hidden=false},50)}</script>',
  // The page empties the password on "log in" and reaches its home page by itself a few seconds later.
  '/clear-then-home':'<div id="view"><input id="account" autocomplete="username"><input id="secret" type="password"><button id="go">Log in</button></div><script>go.onclick=()=>{setTimeout(()=>{secret.value=""},50);setTimeout(()=>{location.href="/home"},3000)}</script>',
  // Two unrelated iframes: one asks for an email, the other only for a password.
  '/two-frames':'<iframe src="https://accounts.test/id-frame" style="width:400px;height:120px;border:0"></iframe><iframe src="https://sso.test/pw-frame" style="width:400px;height:120px;border:0"></iframe>',
  '/id-frame':'<form onsubmit="event.preventDefault()"><input name="email" type="email"><button>Next</button></form>',
  '/pw-frame':'<form onsubmit="event.preventDefault()"><input name="pw" type="password"><button>Sign in</button></form>',
  // A web component without autocomplete hints, after an ordinary search box.
  '/shadow-plain':'<input name="q" placeholder="Search"><login-box></login-box><script>customElements.define("login-box",class extends HTMLElement{constructor(){super();const root=this.attachShadow({mode:"open"});root.innerHTML="<input id=u><input id=p type=password><button id=go>Sign in</button>";root.getElementById("go").onclick=()=>{window.seen=root.getElementById("u").value;setTimeout(()=>{root.innerHTML="<h1>Welcome</h1>"},50)}}})</script>',
  // A transparent login iframe (a background sign-in) placed before the identity provider in the page but created after it.
  '/frame-host-hidden':'<h1>App</h1><iframe id="idp" src="https://sso.test/frame-login" style="width:420px;height:240px;border:0"></iframe><script>const hidden=document.createElement("iframe");hidden.src="https://ads.test/frame-login";hidden.style="width:420px;height:240px;border:0;opacity:0";document.body.insertBefore(hidden,idp)</script>',
  // A web component whose inputs live in an open shadow root.
  '/shadow':'<login-box></login-box><script>customElements.define("login-box",class extends HTMLElement{constructor(){super();const root=this.attachShadow({mode:"open"});root.innerHTML="<input id=u autocomplete=username><input id=p type=password><button id=go>Sign in</button>";root.getElementById("go").onclick=()=>{setTimeout(()=>{root.innerHTML="<h1>Welcome</h1>"},50)}}})</script>',
  // An identity provider's login form embedded from another site (served as https://sso.test).
  '/frame-host':'<h1>App</h1><iframe id="idp" src="https://sso.test/frame-login" style="width:420px;height:240px;border:0"></iframe>',
  '/frame-login':'<form method="post" action="/frame-done"><input name="user"><input name="pw" type="password"><button>Sign in</button></form>',
  '/frame-done':'<p>Signed in</p>',
  // Identifier first: the app asks for the email, then hands over to its identity provider for the password.
  '/hrd':'<form action="https://sso.test/password"><input name="identifier" type="email"><button>Next</button></form>',
  '/password':'<form method="post" action="https://login.test/home"><input name="pw" type="password"><button>Sign in</button></form>',
};
const timer=setTimeout(()=>{console.error('Capture smoke timed out');app.exit(1)},240000);
(async()=>{await app.whenReady();
const posts=[];
session.defaultSession.protocol.handle('https',request=>{const {pathname}=new URL(request.url);if(request.method==='POST')request.text().then(body=>posts.push(body),()=>{});return pages[pathname]?page(pages[pathname]):new Response('missing',{status:404})});
const store=createWebsiteCredentialStore({vaultDirectory:path.join(__dirname,'vault'),policyFile:path.join(__dirname,'policy.json'),hardenDirectory(){},
  protector:{available:()=>true,protect:key=>Buffer.from(key),unprotect:blob=>Buffer.from(blob)}});
store.setCaptureEnabled(true);
const shown=[];const capture=createLoginCapture({store,relay,presentOffer:offer=>{shown.push(offer);return true},withdrawOffer(){}});
const win=new BrowserWindow({show:false,width:900,height:700,webPreferences:guestPreferences});
capture.attach(win.webContents);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
// Types like a user: the page's own main world sets the values, then a real click is dispatched.
const fill=(selector,value)=>js('(()=>{const input=document.querySelector('+JSON.stringify(selector)+');input.focus();input.value='+JSON.stringify(value)+';input.dispatchEvent(new Event("input",{bubbles:true}))})()');
// A click that navigates may never resolve its executeJavaScript promise, so it is not awaited to completion.
const click=selector=>Promise.race([js('document.querySelector('+JSON.stringify(selector)+').click()').catch(()=>{}),wait(400)]);
const open=async route=>{await win.loadURL('https://login.test'+route);await wait(150)};
// An iframe of the page: the page's main world cannot reach into it, so the test types there through Main.
const frameOf=async(origin,selector='[name=pw]')=>{for(let i=0;i<50;i++){const frame=win.webContents.mainFrame.frames.find(item=>item.origin===origin);if(frame&&await frame.executeJavaScript('Boolean(document.querySelector('+JSON.stringify(selector)+'))').catch(()=>false)){await wait(150);return frame}await wait(100)}throw new Error(origin+' iframe did not load')};
const idp=()=>frameOf('https://sso.test');
// A click the user makes, not one a script dispatches.
const realClick=async selector=>{const at=await js('(()=>{const box=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)}})()');
  for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,x:at.x,y:at.y,button:'left',clickCount:1});await wait(500)};
const frameFill=(frame,selector,value)=>frame.executeJavaScript('(()=>{const input=document.querySelector('+JSON.stringify(selector)+');input.focus();input.value='+JSON.stringify(value)+';input.dispatchEvent(new Event("input",{bubbles:true}))})()',true);
// The controller judges the outcome 2.5s after submission, re-probing a few times if the form is still there.
const outcome=async(expected,label)=>{const before=shown.length;for(let i=0;i<90&&shown.length===before;i++)await wait(100);
  if(expected===null){assert.equal(shown.length,before,label+': unexpected offer '+JSON.stringify(shown[shown.length-1]));console.log('  ok  '+label+' -> no offer');return}
  assert.equal(shown.length,before+1,label+': no offer');const {offerId,...offer}=shown[shown.length-1];assert.deepEqual(offer,expected,label);console.log('  ok  '+label+' -> '+offer.kind+' '+offer.username)};
const origin='https://login.test';

// SMOKE_ONLY=fill skips login recognition and seeds the accounts it would have saved.
if(process.env.SMOKE_ONLY==='fill'){store.add({origin,username:'alice@example.com',password:'hunter2!'});store.add({origin,username:'dave@example.com',password:'brand-new'})}else{
await open('/classic');await fill('[name=email]','alice@example.com');await fill('[name=pw]','hunter2!');await click('button');
await outcome({origin,username:'alice@example.com',kind:'save',verified:true},'classic form POST with navigation');
assert.equal(win.webContents.getURL(),origin+'/home');
// The page's own scripts cannot see the observer or its captured values.
assert.equal(await js('typeof globalThis.__desktopLoginObserver'),'undefined');
assert.equal(capture.resolveOffer(shown[shown.length-1].offerId,'save'),true);
assert.equal(store.resolveForOrigin(origin,{agentOnly:false}).password,'hunter2!');

await open('/classic');await fill('[name=email]','alice@example.com');await fill('[name=pw]','hunter2!');await click('button');
await outcome(null,'same login again');

await open('/rejected');await fill('[name=user]','mallory');await fill('[name=pw]','wrong');await click('button');
await outcome(null,'rejected login (form shown again)');

await open('/spa');await fill('#account','bob');await fill('#secret','spa-secret');await click('#go');
await outcome({origin,username:'bob',kind:'save',verified:true},'single-page app without a form');

await open('/step1');await fill('[name=identifier]','carol@example.com');await click('button');await wait(300);
assert.equal(new URL(win.webContents.getURL()).pathname,'/step2');
await fill('[name=pw]','two-step-secret');await click('button');
await outcome({origin,username:'carol@example.com',kind:'save',verified:true},'two-step login');

await open('/signup');await fill('[name=email]','dave@example.com');await fill('[name=pw1]','brand-new');await fill('[name=pw2]','brand-new');await click('button');
await outcome({origin,username:'dave@example.com',kind:'save',verified:true},'sign-up with a hidden decoy field');
capture.resolveOffer(shown[shown.length-1].offerId,'save');assert.equal(store.resolveForOrigin(origin,{agentOnly:false,id:store.state().credentials.find(item=>item.maskedUsername.startsWith('da')).id}).password,'brand-new');

await open('/classic');await fill('[name=email]','alice@example.com');await fill('[name=pw]','rotated');await js('document.querySelector("[name=pw]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));document.querySelector("form").requestSubmit()');
await outcome({origin,username:'alice@example.com',kind:'update',verified:true},'changed password submitted with Enter');

await open('/reveal');await fill('[name=email]','erin@example.com');await fill('[name=pw]','revealed-secret');await click('#eye');
assert.equal(await js('document.querySelector("[name=pw]").type'),'text');
await outcome(null,'show-password button without submitting');
await click('#submit');
await outcome({origin,username:'erin@example.com',kind:'save',verified:true},'submitting while the password is shown as text');

await open('/search');await fill('[name=q]','alice@example.com');await click('button');
await outcome(null,'search form');

await open('/div-button');await fill('#account','mia');await fill('#secret','div-secret');await click('#go');
await outcome({origin,username:'mia',kind:'save',verified:true},'styled <div> as the login button');

await open('/forgot');await fill('[name=email]','kate@example.com');await fill('[name=pw]','typed-then-forgot');await click('#forgot');
await outcome(null,'link that leaves the login form');

await open('/captcha');await fill('#account','judy');await fill('#secret','slow-check');await click('#go');
await outcome(null,'slider check still open after nine seconds');
await js('pass()');
await outcome({origin,username:'judy',kind:'save',verified:true},'login completed after a slow check');

await open('/refused');await fill('#account','mallory');await fill('#secret','wrong-again');await click('#go');await wait(2500);
await open('/home');
await outcome(null,'refused login, then leaving through the address bar');
await open('/refused');await fill('#account','mallory');await fill('#secret','wrong-again');await click('#go');await wait(2500);
await realClick('#away');assert.equal(win.webContents.getURL(),origin+'/home','the user followed the link');
await outcome(null,'refused login, then following a link on the page');

await open('/clear-then-home');await fill('#account','quinn');await fill('#secret','cleared-on-submit');await click('#go');
await outcome({origin,username:'quinn',kind:'save',verified:false},'field emptied on submit, page moved on by itself');

await open('/two-frames');{const accounts=await frameOf('https://accounts.test','[name=email]');const vault=await idp();
  await frameFill(accounts,'[name=email]','rita@example.com');await accounts.executeJavaScript('document.querySelector("button").click()',true);await wait(300);
  await frameFill(vault,'[name=pw]','another-form');await vault.executeJavaScript('document.querySelector("button").click()',true)}
await outcome(null,'an email in one iframe is not paired with a password in another');

await open('/shadow-plain');await fill('[name=q]','hello');
await js('(()=>{const root=document.querySelector("login-box").shadowRoot;for(const [id,value] of [["u","paul"],["p","shadow-plain"]]){const input=root.getElementById(id);input.focus();input.value=value;input.dispatchEvent(new Event("input",{bubbles:true}))}})()');
await js('document.querySelector("login-box").shadowRoot.getElementById("go").click()');
await outcome({origin,username:'paul',kind:'save',verified:true},'account field in a shadow root without hints, after a search box');

await open('/shadow');
await js('(()=>{const root=document.querySelector("login-box").shadowRoot;for(const [id,value] of [["u","leo"],["p","shadow-secret"]]){const input=root.getElementById(id);input.focus();input.value=value;input.dispatchEvent(new Event("input",{bubbles:true}))}})()');
await js('document.querySelector("login-box").shadowRoot.getElementById("go").click()');
await outcome({origin,username:'leo',kind:'save',verified:true},'login form inside an open shadow root');

await open('/frame-host');{const frame=await idp();await frameFill(frame,'[name=user]','ivan');await frameFill(frame,'[name=pw]','frame-secret');
  await Promise.race([frame.executeJavaScript('document.querySelector("button").click()',true).catch(()=>{}),wait(400)])}
await outcome({origin:'https://sso.test',username:'ivan',kind:'save',verified:true},'login form in a cross-origin iframe');
capture.resolveOffer(shown[shown.length-1].offerId,'save');

await open('/hrd');await fill('[name=identifier]','olga@example.com');await click('button');await wait(500);
assert.equal(new URL(win.webContents.getURL()).origin,'https://sso.test');
await fill('[name=pw]','idp-secret');await click('button');
await outcome({origin:'https://sso.test',username:'olga@example.com',kind:'save',verified:true},'identifier on the app, password at its identity provider');
await open('/hrd');await fill('[name=identifier]','olga@example.com');await click('button');await wait(500);
await win.loadURL('https://other.test/password');await wait(150);
await fill('[name=pw]','unrelated');await click('button');
await outcome(null,'identifier not carried over a typed address');

// A login tab that closes before its outcome could be seen: the user decides, told it is unverified.
{const tab=new BrowserWindow({show:false,width:900,height:700,webPreferences:guestPreferences});capture.attach(tab.webContents);
  await tab.loadURL(origin+'/captcha');await wait(150);
  for(const [selector,value] of [['#account','nora'],['#secret','closed-tab']])await tab.webContents.executeJavaScript('(()=>{const input=document.querySelector('+JSON.stringify(selector)+');input.focus();input.value='+JSON.stringify(value)+';input.dispatchEvent(new Event("input",{bubbles:true}))})()',true);
  await tab.webContents.executeJavaScript('document.querySelector("#go").click()',true);await wait(1500);tab.destroy()}
await outcome({origin,username:'nora',kind:'save',verified:false},'login tab closed before its outcome');

}
// --- Agent fill: Desktop writes a saved login into the real page; only a status comes back. ---
store.add({origin,username:'bob',password:'spa-secret'});store.add({origin,username:'carol@example.com',password:'two-step-secret'});
if(!store.listForOrigin('https://sso.test',{agentOnly:true}).some(item=>item.maskedUsername.startsWith('i')))store.add({origin:'https://sso.test',username:'ivan',password:'frame-secret'});
const access=createAgentCredentialAccess(store,relay);
const target={contents:win.webContents,holdAutomation:execute=>{const release=queue.holdPageAutomation(win.webContents.id);return queue.withCdpCommandQueue(win.webContents.id,()=>execute(release)).catch(error=>{release();throw error})}};
const accountId=prefix=>access.list(origin).find(item=>item.username.startsWith(prefix)).accountId;
const filled=(result,expected,label)=>{assert.deepEqual(result,expected,label);assert.ok(!JSON.stringify(result).includes('hunter2'));console.log('  ok  fill: '+label+' -> '+result.status)};
const offersBefore=shown.length;

await open('/classic');posts.length=0;
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true}),{status:'submitted',loginFormVisible:false},'classic form, submitted');
assert.equal(win.webContents.getURL(),origin+'/home');
await wait(200);assert.equal(posts[0],'email=alice%40example.com&pw=hunter2%21');
assert.equal(queue.isPageAutomationHeld(win.webContents.id),false);

await open('/controlled');
filled(await access.fill(target,{origin,accountId:accountId('b'),submit:true}),{status:'submitted',loginFormVisible:false},'framework page that listens for input events');
assert.equal(await js('document.querySelector("#who").textContent'),'bob/10');

await open('/classic');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:false,sleep:()=>wait(10)}),{status:'filled'},'filled without submitting');
assert.equal(await js('document.querySelector("[name=pw]").value'),'hunter2!');
assert.equal(queue.isPageAutomationHeld(win.webContents.id),true);
for(let i=0;i<100&&queue.isPageAutomationHeld(win.webContents.id);i++)await wait(100);
assert.equal(queue.isPageAutomationHeld(win.webContents.id),false,'automation stays paused');
assert.equal(await js('document.querySelector("[name=pw]").value'),'','an unsubmitted password is erased before automation resumes');
console.log('  ok  fill: unsubmitted password erased when the pause ends');

await open('/rejected');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true,sleep:()=>wait(60)}),{status:'submitted',loginFormVisible:true},'rejected login keeps the form');
assert.equal(await js('document.querySelector("[name=pw]").value'),'');

await open('/step1');
filled(await access.fill(target,{origin,accountId:accountId('c'),submit:true}),{status:'username_only',submitted:true},'two-step, first page');
await wait(400);assert.equal(new URL(win.webContents.getURL()).pathname,'/step2');posts.length=0;
filled(await access.fill(target,{origin,accountId:accountId('c'),submit:true}),{status:'submitted',loginFormVisible:false},'two-step, password page');
await wait(200);assert.equal(posts[0],'pw=two-step-secret');

await open('/hide');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true}),{status:'submitted',loginFormVisible:false},'field hidden after login');
assert.equal(await js('window.keep.value'),'','a hidden field is erased before automation resumes');
await open('/totext');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true,sleep:()=>wait(60)}),{status:'submitted',loginFormVisible:false},'field switched to plain text');
assert.equal(await js('window.keep.type+":"+window.keep.value'),'text:','a plain-text field is erased before automation resumes');
for(const route of ['/signup-single','/reset']){await open(route);posts.length=0;
  filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true}),{status:'no_login_form',reason:'signup_or_reset'},route+' refused');
  assert.equal(await js('document.querySelector("[name=pw]").value+document.querySelector("[name=email]").value'),'');await wait(200);assert.equal(posts.length,0)}
await open('/signup-noform');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true}),{status:'no_login_form',reason:'signup_or_reset'},'sign-up without a form refused');
assert.equal(await js('pw.value+email.value'),'');
await open('/login-or-signup');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true}),{status:'submitted',loginFormVisible:false},'form-less login page that also offers sign-up');
await open('/swap');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:false,sleep:()=>wait(20)}),{status:'filled'},'first fill left for the user');
await js('swap()');
const overlap=await access.fill(target,{origin,accountId:accountId('al'),submit:true}).then(result=>({result}),error=>({code:error.code}));
assert.deepEqual(overlap,{code:'credential_fill_in_progress'},'a second fill on the same page must wait for the first: '+JSON.stringify(overlap));
for(let i=0;i<150&&queue.isPageAutomationHeld(win.webContents.id);i++)await wait(100);
assert.equal(queue.isPageAutomationHeld(win.webContents.id),false);
assert.equal(await js('window.keepA.value'),'','the first form is erased before automation resumes');
console.log('  ok  fill: overlapping fill refused, first form erased');
await open('/signup');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true}),{status:'no_login_form',reason:'several_password_fields'},'sign-up form refused');
await open('/search');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true}),{status:'no_login_form',reason:'no_password_field'},'search box refused');
assert.equal(await js('document.querySelector("[name=q]").value'),'');
await open('/classic');
assert.deepEqual(await access.locateLogin(win.webContents),{origin,frame:null},'a page with its own login form');
await open('/shadow-plain');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true}),{status:'submitted',loginFormVisible:false},'account field in a shadow root without hints');
assert.equal(await js('window.seen'),'alice@example.com','the account went into the shadow root field, not the search box');
assert.equal(await js('document.querySelector("[name=q]").value'),'');
await open('/frame-host-hidden');await idp();await frameOf('https://ads.test');
{const located=await access.locateLogin(win.webContents);
  assert.equal(located.origin,'https://sso.test','a transparent login iframe is not where the user logs in');assert.equal(located.embeddedIn,origin)}
await open('/frame-host');await idp();posts.length=0;
{const located=await access.locateLogin(win.webContents);
  assert.equal(located.origin,'https://sso.test');assert.equal(located.embeddedIn,origin);
  const ivan=access.list('https://sso.test').find(item=>item.username.startsWith('i')).accountId;
  filled(await access.fill({...target,frame:located.frame},{origin:located.origin,embeddedIn:located.embeddedIn,accountId:ivan,submit:true}),{status:'submitted',loginFormVisible:false},'login form in a cross-origin iframe');
  await wait(200);assert.equal(posts[posts.length-1],'user=ivan&pw=frame-secret');
  assert.equal(queue.isPageAutomationHeld(win.webContents.id),false)}
await wait(4500);assert.equal(shown.length,offersBefore,'filling a saved login must not prompt to save it again');

clearTimeout(timer);console.log('Login capture smoke passed.');win.destroy();app.exit(0);
})().catch(e=>{console.error(e);app.exit(1)});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [path.join(temp, 'main.cjs')], { env, stdio: 'inherit', timeout: 260000 });
if (result.status !== 0) process.exit(result.status ?? 1);
