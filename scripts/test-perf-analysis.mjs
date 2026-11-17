import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {test} from 'node:test';
const source=fs.readFileSync(process.env.PERF_BASE ? process.env.PERF_BASE + '/src/audio/analysis.ts' : new URL('../src/audio/analysis.ts',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));
function harness({holdFetch=false,holdDecode=false,duration=10,length=800,channels=1}={}) {
 let fetches=0,aborted=0,decodes=0,active=0,maxActive=0,videoLoads=0;
 const releases=[];
 class Media extends EventTarget {
  duration=duration;videoWidth=128;videoHeight=72;currentTime=0;
  set src(v){this._src=v;queueMicrotask(()=>{this.onloadedmetadata?.();this.dispatchEvent(new Event('loadedmetadata'))})}
  removeAttribute(){this._src=''} load(){videoLoads++}pause(){}
 }
 const box=vm.createContext({DOMException,AbortController,Float32Array,Map,Promise,setTimeout,clearTimeout,window:{setTimeout},document:{createElement:()=>new Media()},Audio:Media,
 fetch:async(url,{signal}={})=>{fetches++;if(holdFetch)return new Promise((yes,no)=>{signal?.addEventListener('abort',()=>{aborted++;no(new DOMException('Aborted','AbortError'))},{once:true})});return {ok:true,headers:{get:()=>null},arrayBuffer:async()=>new ArrayBuffer(16)};},
 OfflineAudioContext:class{async decodeAudioData(){decodes++;active++;maxActive=Math.max(active,maxActive);if(holdDecode)await new Promise(r=>releases.push(r));active--;return {numberOfChannels:channels,length,duration:length/8000,getChannelData:()=>new Float32Array(Math.min(length,10000))};}}
 });
 vm.runInContext(stripTypeScriptTypes(source.replace(/^export /gm,''))+'\nglobalThis.api={waveDetail,wavePeaks,videoFrames,remember};',box);
 return {api:box.api,releases,stats:()=>({fetches,aborted,decodes,maxActive,videoLoads}),box};
}
test('closing aborts an in-flight file fetch',async()=>{const h=harness({holdFetch:true}),c=new AbortController();const p=h.api.waveDetail('slow',c.signal).catch(e=>e);await tick();c.abort();await tick();assert.equal(h.stats().aborted,1);assert.equal((await p).name,'AbortError');});
test('obsolete decoding stops before waveform work and decodes are serial',async()=>{const h=harness({holdDecode:true}),a=new AbortController();const p=h.api.waveDetail('one',a.signal).catch(e=>e.name),q=h.api.waveDetail('two');await tick();a.abort();await tick();const max=h.stats().maxActive;h.releases.shift()?.();await tick();await tick();h.releases.shift()?.();await q;assert.equal(max,1);assert.equal(await p,'AbortError');});
test('decoded PCM is bounded even with small compressed input',async()=>{const h=harness({length:20_000_000});await assert.rejects(h.api.waveDetail('oversize'),/too large|too long/);});
test('long duration is rejected before decoding',async()=>{const h=harness({duration:7200});await assert.rejects(h.api.waveDetail('long'),/too large|too long/);assert.equal(h.stats().decodes,0);});
test('completed analysis uses a bounded LRU and recent entries are reused',async()=>{const h=harness();await h.api.waveDetail('recent');await h.api.waveDetail('recent');assert.equal(h.stats().decodes,1);for(let i=0;i<40;i++)await h.api.waveDetail('file'+i);await h.api.waveDetail('recent');assert.equal(h.stats().decodes,42);});
test('aborting frame extraction releases its video immediately',async()=>{const h=harness(),c=new AbortController();const p=h.api.videoFrames('video',8,c.signal).catch(e=>e);await tick();c.abort();await tick();assert.ok(h.stats().videoLoads>0);assert.equal((await p).name,'AbortError');});

test('the byte budget evicts large results before the entry cap',async()=>{
 const h=harness();let loads=0;
 const read=key=>h.api.remember(key,undefined,async()=>{loads++;return new Float32Array(1_500_000)},v=>v.byteLength);
 await read('one');await read('two');await read('two');assert.equal(loads,2);await read('one');assert.equal(loads,3);
});
