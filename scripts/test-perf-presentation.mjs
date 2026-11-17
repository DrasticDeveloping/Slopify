import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {test} from 'node:test';
const source=fs.readFileSync(process.env.PERF_BASE ? process.env.PERF_BASE+'/src/audio/engine.ts' : new URL('../src/audio/engine.ts',import.meta.url),'utf8');
const start=source.indexOf('class MediaVoice'),end=source.indexOf('export interface LoadOptions');
function harness() {
 let demand=false,plays=0,pauses=0;
 const picture={paused:true,currentTime:0,play(){plays++;this.paused=false;return Promise.resolve()},pause(){pauses++;this.paused=true}};
 const box=vm.createContext({document:{visibilityState:'visible'},hasVideoDemand:()=>demand});
 vm.runInContext(stripTypeScriptTypes(source.slice(start,end))+'\nglobalThis.sync = MediaVoice.prototype.syncPresentation;',box);
 const voice={picture,el:{currentTime:10},wanted:true,retired:false};
 return {box,picture,stats:()=>({plays,pauses}),demand:v=>demand=v,sync:()=>box.sync.call(voice)};
}
test('a phone listening without a visible surface does not play or seek the native muted picture',()=>{const h=harness();h.sync();assert.equal(h.stats().plays,0);assert.equal(h.picture.currentTime,0);h.picture.paused=false;h.sync();assert.equal(h.stats().pauses,1);});
test('watching resumes and aligns pictures; hiding the document stops them',()=>{const h=harness();h.demand(true);h.sync();assert.equal(h.stats().plays,1);assert.equal(h.picture.currentTime,10);h.box.document.visibilityState='hidden';h.sync();assert.equal(h.stats().pauses,1);});
