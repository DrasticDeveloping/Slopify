import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
const sourceRoot = process.env.LIBRARY_TEST_SOURCE ? new URL(`file://${process.env.LIBRARY_TEST_SOURCE}/`) : new URL('../', import.meta.url);
const { DeviceFiles } = await import(new URL('server/device-files.mjs', sourceRoot));
const read = (p) => fs.readFileSync(new URL(`src/${p}`, sourceRoot), 'utf8');
function between(s, a, b) { const start=s.indexOf(a), end=s.indexOf(b,start+a.length); assert.ok(start>=0 && end>start,a); return s.slice(start,end); }
function evaluate(source, bindings, expose) {
 const box=vm.createContext({ console, URL, Blob, Response, AbortSignal, Uint8Array, ...bindings });
 vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*;\r?$/gm,'').replace(/^export /gm,''))+`\nglobalThis.api={${expose}}`,box); return box.api;
}
const settle=()=>new Promise(r=>setImmediate(r));
function storage() { const data=new Map(); return {data,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}; }
function clock() { let now=1000, serial=0; const timers=new Map(); return {Date:class extends Date {static now(){return now}},setTimeout(fn,delay){timers.set(++serial,{fn,at:now+delay});return serial},clearTimeout(id){timers.delete(id)},advance(ms){now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn()}},timers}; }
const song=(id)=>({id,title:id,artist:'Artist',album:'Album',durationSeconds:100,savedAs:'audio',sourceURL:'https://example.test/'+id,updatedAt:10,addedAt:1,extra:{},clip:null});
function cloudHarness({ls=storage(),songs=[],onAwait=()=>{},account={status:'signedIn',userId:'u'}}={}) {
 const local=new Map(songs.map(s=>[s.id,s])), calls=[]; let current=account;
 const api=evaluate(read('state/cloud-sync.ts'),{
  localStorage:ls,getAccount:()=>current,
  listSongs:async()=>{onAwait('list',()=>current={status:'signedIn',userId:'other'});return [...local.values()]},
  updateSong:async(id,patch)=>{calls.push(['PATCH',id]);onAwait('update',()=>current={status:'signedIn',userId:'other'});const s={...local.get(id),...patch,updatedAt:20};local.set(id,s);return s},
  cloudCall:async(url,opts)=>{calls.push([opts?.method||'GET',url]);onAwait('cloud',()=>current={status:'signedIn',userId:'other'});return opts?.method==='PUT'?{updatedAt:30}:{songs:[],until:30}},
  fetch:async(url,opts)=>{const id=decodeURIComponent(url.split('/').pop());calls.push([opts.method,id]);onAwait('fetch',()=>current={status:'signedIn',userId:'other'});if(opts.method==='DELETE')local.delete(id);else local.set(id,{...JSON.parse(opts.body),updatedAt:20});return {ok:true,json:async()=>({ok:true,song:local.get(id)})}},
 },'syncCloudSongs, '+(read('state/cloud-sync.ts').includes('export function markCloudSongDeleted')?'markCloudSongDeleted, cancelCloudSongDeletion':'') );
 return {api,ls,local,calls,switchAccount(){current={status:'signedIn',userId:'other'}}};
}
function actionsHarness({ls=storage(),time=clock(),cloud={},state,files=new Set(['srv_a']),deleted=[],failDrop=false}={}) {
 state??=JSON.parse(ls.getItem('test.app')||'null')??{tracks:{srv_a:{id:'srv_a',serverId:'a',title:'A',storage:'downloads',size:4}},trackIds:['srv_a'],playlists:[],order:[],index:-1,upNext:[],history:[],context:null,currentId:null};
 const notices=[];
 const source=between(read('state/actions.ts'),'const pendingRevokes =','/* ───────────────────────── imports');
 const api=evaluate(source,{
 localStorage:ls,Date:time.Date,window:time,clearTimeout:time.clearTimeout,
 getState:()=>state,setState:p=>{state={...state,...(typeof p==='function'?p(state):p)}},
 toast:(...v)=>notices.push(v),engine:{unload(){}},navigator:{},flushPersist(){ls.setItem('test.app',JSON.stringify(state))},
 URL:{revokeObjectURL(){}},dropFromDevice:async(id)=>{if(failDrop)throw new Error('offline');files.delete(id)},
 deleteSong:async(id)=>{deleted.push(id)},markCloudSongDeleted:cloud.markCloudSongDeleted??(()=>{}),cancelCloudSongDeletion:cloud.cancelCloudSongDeletion??(()=>{}),
 reinsert:(a,values)=>{const out=[...a];for(const {id,index}of values)if(!out.includes(id))out.splice(index,0,id);return out},
 },'deleteFromDevice,deleteFromLibrary,retryServerDeletes,cancelServerDelete,isServerDeletePending'+(source.includes('export function cancelDeviceRemoval')?',cancelDeviceRemoval,retryDeviceRemovals':''));
 return {api,ls,time,notices,files,deleted,get state(){return state}};
}

test('L1 interrupted account merge reloads twice without deleting another device playlist',async()=>{
 const ls=storage(), sync=read('state/sync.ts'); let saved={playlists:{},librarySync:{rev:0,data:null}}, state={playlists:{},server:{}}; let snapshot;
 async function session(){
 state={playlists:structuredClone(saved.playlists),server:{}};
 const source=between(sync,'function mergeMap<','/** A slip-in changed')+'\nfunction merge(base, mine, theirs) { return { version: 1, playlists: mergeMap(base?.playlists, mine.playlists, theirs.playlists) }; }\n'+between(sync,'function readBase(): Base','async function request(')+between(sync,'async function mergeWith(', '/* ───────────────────────── the account')+between(sync,sync.includes('const cloudBaseKey =')?'const cloudBaseKey =':'function cloudBase(','async function cloudState(')+between(sync,'async function syncWithAccount()', '\n/*\n * When the account is contacted:');
 const remote={conflict:false,rev:1,data:{version:1,playlists:{remote:{id:'remote',name:'Remote',trackIds:[]}}}};
 const api=evaluate(source,{
 localStorage:ls,CLOUD_BASE:'slopify.cloud-state.v1.',initialLibrarySync:()=>saved.librarySync,startTallies:()=>({}),connectLibrarySync:fn=>snapshot=fn,persistLater(){},stable:JSON.stringify,
 getState:()=>state,setState:p=>state={...state,...(typeof p==='function'?p(state):p)},getAccount:()=>({status:'signedIn',userId:'u'}),deletingAccount:null,
 retryPendingUnlink:async()=>{},computerLink:async()=>({userId:'u'}),linkComputer:async()=>true,pollAccount:async()=>({state:remote,songs:{songs:[],until:0}}),syncCloudSongs:async()=>false,syncServerLibrary:async()=>{},cloudState:async()=>remote,
 saveCloudState:async(_u,_r,data)=>({rev:2,conflict:false,data}),savingLater:fn=>fn(),adopt:fn=>fn(),catchUp(){},localData:s=>({version:1,playlists:s.playlists}),
 same:(a,b)=>JSON.stringify(a)===JSON.stringify(b),apply:data=>state.playlists=data.playlists,showTotals(){},toldAccountError:'',forgetBlip(){},CloudError:class extends Error{},toast(){},thisDevice:'test',
 },'syncWithAccount');
 await api.syncWithAccount();
 }
 await session(); // Drop memory before savingLater's timer fires.
 await session(); assert.ok(state.playlists.remote,'remote playlist must survive termination');
 saved={playlists:structuredClone(state.playlists),librarySync:structuredClone(snapshot())};
 await session(); assert.ok(state.playlists.remote,'remote playlist must survive a second reload');
});

test('L2 explicit offline mass deletion is sent, never recovered as library loss',async()=>{
 const h=cloudHarness({songs:[]});
 const agreed={cursor:10,songs:Object.fromEntries(Array.from({length:10},(_,i)=>['s'+i,{cloud:10,local:10}]))};h.ls.setItem('slopify.cloud-songs.v1.u',JSON.stringify(agreed));
 const tracks=Object.fromEntries(Array.from({length:8},(_,i)=>['srv_s'+i,{id:'srv_s'+i,serverId:'s'+i,title:'S',storage:'server'}]));
 const a=actionsHarness({ls:h.ls,cloud:h.api,state:{tracks,trackIds:Object.keys(tracks),playlists:[],order:[],index:-1,upNext:[],history:[],context:null}});
 a.api.deleteFromLibrary(Object.keys(tracks));a.time.advance(15000);await settle();
 const resumed=cloudHarness({ls:h.ls,songs:[song('s8'),song('s9')]});
 await resumed.api.syncCloudSongs('u',{songs:[{...song('s0'),updatedAt:20}],until:20});
 assert.equal(resumed.calls.filter(([method])=>method==='DELETE').length,8,'all eight explicit deletions must reach cloud');
 assert.equal(resumed.local.has('s0'),false,'incoming changes must respect explicit tombstones after a reload');
 assert.notEqual(JSON.parse(h.ls.getItem('slopify.cloud-songs.v1.u')).cursor,0,'do not trigger mass-loss recovery');
});

test('L3 remove then re-download keeps the replacement after the old deadline',async()=>{
 const h=actionsHarness();h.api.deleteFromDevice(['srv_a']);
 // Production downloadTracks must cancel at enqueue, before any network await.
 const server=read('state/server.ts'); const begin=between(server,'export function downloadTracks(', '\n/**\n * Keeps every music-server');
 const s={...h.state,server:{status:'connected',downloads:{}},settings:{downloadMode:'verified_file_cache'}};
 const api=evaluate(begin,{getState:()=>s,setState(){},transfers:new Map(),queue:[],toast(){},refreshToast(){},runQueue(){},cancelDeviceRemoval:h.api.cancelDeviceRemoval??(()=>{}),quietBatch:false},'downloadTracks');
 api.downloadTracks(['srv_a']);h.files.add('srv_a');h.state.tracks.srv_a.storage='downloads';h.time.advance(15000);await settle();
 assert.ok(h.files.has('srv_a'),'new download cannot be removed by old timer');
});

test('L4 pending library deletion survives termination and two reloads; Undo cancels',async()=>{
 const h=actionsHarness();h.api.deleteFromLibrary(['srv_a']);
 const reopened=actionsHarness({ls:h.ls,time:clock(),files:h.files,deleted:h.deleted});reopened.api.retryServerDeletes();reopened.time.advance(15000);await settle();
 assert.deepEqual(h.deleted,['a']);
 const twice=actionsHarness({ls:h.ls,time:clock(),deleted:h.deleted});twice.api.retryServerDeletes();twice.time.advance(15000);await settle();assert.deepEqual(h.deleted,['a']);
 const undo=actionsHarness();undo.api.deleteFromLibrary(['srv_a']);undo.notices[0][1].action.run();const after=actionsHarness({ls:undo.ls,state:undo.state,deleted:undo.deleted});after.api.retryServerDeletes();after.time.advance(15000);await settle();assert.deepEqual(undo.deleted,[]);
});

test('L5 pending device cleanup survives termination and is retried at startup',async()=>{
 const h=actionsHarness();h.api.deleteFromDevice(['srv_a']);
 const reopened=actionsHarness({ls:h.ls,files:h.files});
 const startup=between(read('state/actions.ts'),'export function wireEngine()','  const s = getState();')+'\n}';
 evaluate('let wired=false;\n'+startup,{retryDeviceRemovals:reopened.api.retryDeviceRemovals},'wireEngine').wireEngine();
 reopened.time.advance(15000);await settle();assert.equal(h.files.size,0);
 const twice=actionsHarness({ls:h.ls,files:h.files});twice.api.retryServerDeletes();twice.time.advance(15000);await settle();assert.equal(h.files.size,0);
});

test('L6 startup sweeps crashed writes, abandoned temp files and replaced invalid media without racing writes',async()=>{
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'slopify-library-'));
 try {
 const initial=new DeviceFiles(dir);await initial.put('a',[Buffer.from('old')],'audio/mp4');const root=path.join(dir,'device-files');const old=await initial.get('a');
 await fsp.writeFile(old.filePath,'corrupted');await initial.put('a',[Buffer.from('new')],'audio/mp4');
 const crash = spawnSync(process.execPath, ['--input-type=module','--eval',`import { DeviceFiles } from ${JSON.stringify(new URL('server/device-files.mjs',sourceRoot).href)}; const files=new DeviceFiles(${JSON.stringify(dir)}); await files.put('crashed',(async function*(){yield Buffer.from('partial upload');process.exit(0)})(),'audio/mp4');`]);
 assert.equal(crash.status,0,crash.stderr.toString());await fsp.writeFile(path.join(root,'abandoned.tmp'),'partial manifest');
 const next=new DeviceFiles(dir);const current=await next.get('a');assert.ok(current);const files=await fsp.readdir(root);assert.deepEqual(files.filter(n=>n.endsWith('.media')),[current.file]);assert.equal(files.some(n=>n.endsWith('.tmp')),false);
 let release;const wait=new Promise(r=>release=r);const writing=next.put('b',(async function*(){yield Buffer.from('first');await wait;yield Buffer.from('last')})(),'audio/mp4');await settle();await next.get('a');release();await writing;assert.equal((await next.get('b')).size,9);
 }finally{await fsp.rm(dir,{recursive:true,force:true})}
});

test('L7 verified native downloads retire their WebKit backup, including migrated copies',async()=>{
 const cacheData=new Map(),cache={put:async(k,v)=>cacheData.set(k,v),match:async k=>cacheData.get(k),delete:async k=>cacheData.delete(k)};const {webcrypto}=await import('node:crypto');
 const api=evaluate(read('state/device.ts'),{isNativeApp:true,location:{origin:'https://test.local'},window:{caches:true},caches:{open:async()=>cache},crypto:webcrypto,fetch:async(_u,opts)=> opts.method==='HEAD'?{ok:false,status:404}:{ok:true,json:async()=>({ok:true,size:opts.body.byteLength,sha256:Buffer.from(await webcrypto.subtle.digest('SHA-256',opts.body)).toString('hex')})}},'keepOnDevice,restoreDeviceFiles');
 await api.keepOnDevice('srv_a',new Blob(['bytes'],{type:'audio/mp4'}));assert.equal(cacheData.size,0,'a native copy must not be counted as one file while keeping two');
 cacheData.set('https://test.local/__device-songs/srv_b',new Response('migration'));await api.restoreDeviceFiles(['srv_b']);assert.equal(cacheData.size,0,'migrated backup should retire after native verification');
});

test('L8 library and stream song menus close and navigate to artist and album',()=>{
 for(const stream of [false,true]){
 let menu=true,route;const t={id:'t',title:'Song',artistId:'artist',albumId:'album',storage:'server',stream};
 const source=between(read('lib/menus.ts'),'/** Slip a song','export function openTrackMenu(');
 const api=evaluate(source,{getState:()=>({tracks:{t},artists:{artist:{id:'artist'}},albums:{album:{id:'album'}},playlists:[]}),isLiked:()=>false,isPlayable:()=>true,snoozeItem:()=>null,isSlipIn:()=>false,streamLink:()=>null,closeMenu:()=>menu=false,navigate:r=>route=r},'trackMenu');
 const items=api.trackMenu(['t']);for(const [label,name,id]of [['Go to artist','artist','artist'],['Go to album','album','album']]){menu=true;const item=items.find(i=>i.label===label);assert.ok(item,`${stream?'stream':'library'} ${label}`);item.run();assert.equal(menu,false);assert.equal(route.name,name);assert.equal(route.id,id)}
 }
});

test('L9 switching accounts during song list await prevents all subsequent mutations',async()=>{
 const h=cloudHarness({onAwait:(step,switchIt)=>{if(step==='list')switchIt()}});await h.api.syncCloudSongs('u',{songs:[song('a')],until:10});assert.deepEqual(h.calls,[]);assert.equal(h.ls.getItem('slopify.cloud-songs.v1.u'),null);
});
test('L9 switching accounts during first local write prevents the next write and agreement',async()=>{
 const h=cloudHarness({onAwait:(step,switchIt)=>{if(step==='fetch')switchIt()}});await h.api.syncCloudSongs('u',{songs:[song('a'),song('b')],until:10});assert.deepEqual(h.calls,[['PUT','a']]);assert.equal(h.ls.getItem('slopify.cloud-songs.v1.u'),null);
});

test('L2 Undo clears the cloud tombstone and unexplained mass loss still recovers',async()=>{
 const h=cloudHarness();const a=actionsHarness({ls:h.ls,cloud:h.api});a.api.deleteFromLibrary(['srv_a']);a.notices[0][1].action.run();
 assert.deepEqual(JSON.parse(h.ls.getItem('slopify.cloud-song-deletions.v1.u')),[]);
 const agreed={cursor:10,songs:Object.fromEntries(Array.from({length:8},(_,i)=>['s'+i,{cloud:10,local:10}]))};h.ls.setItem('slopify.cloud-songs.v1.u',JSON.stringify(agreed));
 await h.api.syncCloudSongs('u',{songs:[],until:10});assert.equal(JSON.parse(h.ls.getItem('slopify.cloud-songs.v1.u')).cursor,0);assert.equal(h.calls.length,0);
});

test('L4 restored removal waits only the remaining undo deadline',async()=>{
 const time=clock(),h=actionsHarness({time});h.api.deleteFromLibrary(['srv_a']);
 // Termination loses timer callbacks but keeps wall-clock time and the stored deadline.
 time.advance(5000);time.timers.clear();const reopened=actionsHarness({ls:h.ls,time,state:h.state,deleted:h.deleted});reopened.api.retryServerDeletes();
 time.advance(9999);await settle();assert.deepEqual(h.deleted,[]);time.advance(1);await settle();assert.deepEqual(h.deleted,['a']);
});

test('L5 failed cleanup remains durable until a later startup succeeds',async()=>{
 const h=actionsHarness();h.api.deleteFromDevice(['srv_a']);
 // Keep the durable intent and drop the original session before its timer runs.
 const failed=actionsHarness({ls:h.ls,files:h.files,failDrop:true});failed.api.retryServerDeletes();failed.time.advance(15000);await settle();assert.equal(h.files.size,1);
 assert.ok(JSON.parse(h.ls.getItem('slopify.pending-removals.v1')).device.srv_a);
 const restarted=actionsHarness({ls:h.ls,files:h.files});restarted.api.retryServerDeletes();restarted.time.advance(15000);await settle();assert.equal(h.files.size,0);
 assert.deepEqual(JSON.parse(h.ls.getItem('slopify.pending-removals.v1')).device,{});
});

test('L7 existing native copies retire only verified legacy backups',async()=>{
 const {webcrypto}=await import('node:crypto');const body=Buffer.from('native'),hash=Buffer.from(await webcrypto.subtle.digest('SHA-256',body)).toString('hex');
 for(const valid of [true,false]){
 const entries=new Map([['https://test.local/__device-songs/srv_a',new Response('backup')]]),cache={match:async k=>entries.get(k),delete:async k=>entries.delete(k)};
 const api=evaluate(read('state/device.ts'),{isNativeApp:true,location:{origin:'https://test.local'},window:{caches:true},caches:{open:async()=>cache},crypto:webcrypto,fetch:async(_u,opts)=> opts?.method==='HEAD'?new Response(null,{headers:{'X-Content-SHA256':hash}}):new Response(valid?body:Buffer.from('broken'))},'restoreDeviceFiles');
 const result=await api.restoreDeviceFiles(['srv_a']);assert.ok(result.kept.has('srv_a'));assert.equal(entries.size,valid?0:1,'unverified native bytes must preserve the backup');
 }
});

for(const step of ['cloud','update','delete','upload'])test(`L9 account identity is rechecked after ${step} await`,async()=>{
 const h=cloudHarness({songs:step==='update'||step==='delete'?[song('a'),song('b')]:step==='upload'?[song('a'),song('b')]:[],onAwait:(at,switchIt)=>{if(at===(step==='delete'?'fetch':step==='upload'?'cloud':step))switchIt()}});
 if(step==='update'||step==='delete')h.ls.setItem('slopify.cloud-songs.v1.u',JSON.stringify({cursor:1,songs:{a:{cloud:1,local:10},b:{cloud:1,local:10}}}));
 const fetched=step==='cloud'?undefined:{songs:step==='update'?[{...song('a'),title:'Changed',updatedAt:20},{...song('b'),title:'Changed',updatedAt:20}]:step==='delete'?[{id:'a',deleted:true,updatedAt:20},{id:'b',deleted:true,updatedAt:20}]:[],until:20};
 await h.api.syncCloudSongs('u',fetched);assert.equal(h.calls.length,1,'no second request may be issued for the old account');
 const saved=JSON.parse(h.ls.getItem('slopify.cloud-songs.v1.u')||'null');assert.equal(saved?.songs?.a?.cloud,step==='update'||step==='delete'?1:undefined,'stale result cannot advance agreement');
});

test('L9 playlist merge aborts before adopting an old account save result',async()=>{
 let current=true;const bases=[];let totals=0;
 const api=evaluate(between(read('state/sync.ts'),'async function mergeWith(','/* ───────────────────────── the account'),{savingLater:fn=>fn(),adopt:fn=>fn(),catchUp(){},getState:()=>({}),localData:()=>({version:1,playlists:{}}),merge:()=>({version:1,playlists:{}}),same:()=>false,apply(){},showTotals:()=>totals++},'mergeWith');
 await api.mergeWith({rev:1,data:{version:1,playlists:{}}},async()=>{current=false;return {rev:2,conflict:false,data:{}}},()=>({rev:0,data:null}),b=>bases.push(b),true,()=>current);assert.equal(bases.length,0);assert.equal(totals,0);
});

test('L9 importer does not adopt songs returned after the account changes',async()=>{
 let current=true,mutations=0;
 const api=evaluate(between(read('state/importer.ts'),'export async function syncServerLibrary(','/**\n * Songs saved from uploads'),{listSongs:async()=>{current=false;return [song('a')]},set:()=>mutations++,retryServerDeletes:()=>mutations++},'syncServerLibrary');
 await api.syncServerLibrary(()=>current);assert.equal(mutations,0);
});

test('L1 a save before the first account sync preserves the loaded account base',()=>{
 const source=read('state/sync.ts');let snapshot;
 const loaded={rev:4,data:{version:1},cloud:{userId:'u',base:{rev:8,data:{version:1,playlists:{keep:{id:'keep'}}}}}};
 const api=evaluate(between(source,'function readBase(): Base','async function request(')+between(source,source.includes('const cloudBaseKey =')?'const cloudBaseKey =':'function cloudBase(','async function cloudState('),{initialLibrarySync:()=>loaded,startTallies:()=>({}),connectLibrarySync:fn=>snapshot=fn,persistLater(){},CLOUD_BASE:'slopify.cloud-state.v1.',localStorage:storage()},'readBase');
 assert.ok(api.readBase());assert.equal(snapshot().cloud?.base.rev,8);
});

test('L5 a failed WebKit cleanup rejects so its durable intent can be retried',async()=>{
 let failed=true,removed=false;
 const api=evaluate(read('state/device.ts'),{isNativeApp:true,location:{origin:'https://test.local'},window:{caches:true},caches:{open:async()=>({delete:async()=>{if(failed)throw new Error('cache busy');removed=true}})},fetch:async()=>({ok:true})},'dropFromDevice');
 await assert.rejects(api.dropFromDevice('srv_a'),/cache busy/);assert.equal(removed,false);failed=false;await api.dropFromDevice('srv_a');assert.equal(removed,true);
});
