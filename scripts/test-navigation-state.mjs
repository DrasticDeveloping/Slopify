import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
const root = process.env.NAV_SOURCE_ROOT || new URL('..', import.meta.url).pathname;
const read = name => fs.readFileSync(path.join(root, 'src', name), 'utf8');
function between(source, from, to) { const start=source.indexOf(from), end=source.indexOf(to,start); assert.ok(start>=0 && end>start); return source.slice(start,end); }
function run(source, bindings, expose) { const box=vm.createContext(bindings); vm.runInContext(stripTypeScriptTypes(source.replace(/^export /gm,''))+`\nglobalThis.api={${expose}}`,box);return box.api; }

test('N2: leaving a playlist Search for the inert back page restores progress and finish toast',()=>{
  const toasts=[];let seq=0;let cleanup;let previous;
  const importer=between(read('state/importer.ts'),'let transferToast = 0;','/** Mirrors Resonance');
  const state={source:'https://example.test/playlist',busy:'import',stage:'downloading',progress:{completed:1,total:2},transferName:'Test save',batch:null};
  const api=run(importer,{state,getState:()=>({toasts}),toast:(message,opts)=>{toasts.push({id:++seq,message,...opts});return seq;},dismissToast:id=>{const at=toasts.findIndex(t=>t.id===id);if(at>=0)toasts.splice(at,1)},updateToast:(id,patch)=>Object.assign(toasts.find(t=>t.id===id),patch),stageLabel:s=>s,cancelImport:()=>{}},'showTransferInline, finishTransfer');
  const effect=between(read('components/ExternalSearch.tsx'),'  const inline =','  // The not-found');
  const render=peek=>run(effect,{playlist:true,query:state.source,peek,showTransferInline:api.showTransferInline,useEffect:(fn,deps)=>{if(!previous || deps.some((d,i)=>d!==previous[i])) {cleanup?.();cleanup=fn();previous=deps;} }},'inline');
  render(false);assert.equal(toasts.length,0,'visible playlist owns its progress');
  render(true);assert.equal(toasts.length,1,'hidden playlist must stop suppressing the toast');
  api.finishTransfer('Saved playlist',{}, {quietInline:true});assert.equal(toasts[0].message,'Saved playlist');
  render(false);
});

test('history entries retain view state independently across tabs, Back and Forward',()=>{
  let state={route:{name:'home'},back:[],forward:[],selection:[]};let sequence=0;
  const source=between(read('state/actions.ts'),'let readScroll:','/* ───────────────────────── toasts');
  const api=run(source,{getState:()=>state,setState:patch=>{state={...state,...patch}},sameRoute:(a,b)=>JSON.stringify(a)===JSON.stringify(b),newPageEntry:()=>({id:++sequence,state:new Map()}),closeFloatingPanel:()=>({}),document:{querySelector:()=>null},prepareNavigationFocus:()=>{}},'navigate, selectMobileTab, goBack, goForward, currentPageEntry, backPageEntry, trackScroll, takeScrollRestore');
  api.trackScroll(()=>250);
  api.navigate({name:'playlist',id:'p'});const playlist=api.currentPageEntry();playlist.state.set('filter','saved');
  api.selectMobileTab({name:'library'});const library=api.currentPageEntry();library.state.set('filter','other');
  api.selectMobileTab({name:'home'});assert.equal(api.currentPageEntry(),playlist);assert.equal(api.takeScrollRestore(),250);assert.equal(playlist.state.get('filter'),'saved');
  api.navigate({name:'artist',id:'a'});assert.equal(api.backPageEntry(),playlist);api.goBack();assert.equal(api.currentPageEntry(),playlist);api.goForward();assert.notEqual(api.currentPageEntry(),playlist);
  api.selectMobileTab({name:'library'});assert.equal(api.currentPageEntry(),library);
  api.navigate({name:'search',q:'one'});const search=api.currentPageEntry();api.navigate({name:'search',q:'two'});assert.equal(api.currentPageEntry(),search,'typing keeps the search box entry');
});

function edgeHarness() {
  const listeners=new Map(),timers=new Map(),classes=new Set();let seq=0,revision=0,backs=0;
  const style=()=>({removeProperty(key){delete this[key]},setProperty(key,value){this[key]=value}});
  const parts={page:{style:style()},under:{style:style(),dataset:{}},shade:{style:style()}};
  const area={classList:{contains:c=>classes.has(c),add:(...cs)=>cs.forEach(c=>classes.add(c)),remove:(...cs)=>cs.forEach(c=>classes.delete(c))},style:style(),getBoundingClientRect:()=>({left:0,width:402}),querySelector:q=>q.includes('not(')?parts.page:q.includes('main-scroll.back-page')?parts.under:parts.shade,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:()=>{}};
  const api=run(read('lib/mobile.ts').slice(read('lib/mobile.ts').indexOf('export function useEdgeBack')),{useRef:value=>({current:value}),useEffect:fn=>fn(),phone:()=>true,window:{innerWidth:402,setTimeout:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq},matchMedia:()=>({matches:false})},clearTimeout:id=>timers.delete(id),document:{documentElement:{dataset:{}}},getComputedStyle:()=>({translate:'50px'}),nativeFeedback:()=>{}},'useEdgeBack');
  api.useEdgeBack({current:area},()=>true,()=>backs++,()=>revision);
  const fire=(type,x,at,y=300)=>listeners.get(type)({touches:type==='touchend'?[]:[{clientX:x,clientY:y}],target:{closest:()=>null},timeStamp:at,cancelable:true,preventDefault:()=>{}});
  return {fire,parts,timers,classes,change:()=>revision++,backs:()=>backs};
}

test('N1: a fling cannot pop another navigation entry during its finishing timer',()=>{
  const h=edgeHarness();h.fire('touchstart',5,0);h.fire('touchmove',205,20);h.fire('touchend',205,30);h.change();[...h.timers.values()][0].fn();assert.equal(h.backs(),0);
});
test('N6: an interrupted spring resumes from its painted translation',()=>{
  const h=edgeHarness();h.fire('touchstart',5,0);h.fire('touchmove',105,20);h.fire('touchend',105,500);h.fire('touchstart',5,510);h.fire('touchmove',25,530);assert.equal(h.parts.page.style.translate,'70px 0');
});


test('N6: a vertical rejection after spring takeover still settles and resets',()=>{
  const h=edgeHarness();h.fire('touchstart',5,0);h.fire('touchmove',105,20);h.fire('touchend',105,500);h.fire('touchstart',5,510);h.fire('touchmove',5,530,350);assert.ok(h.classes.has('back-settling'));assert.ok([...h.timers.values()].some(t=>t.ms===360));
});

test('fixed relevance previews ignore a restored full-list sort',()=>{
  const source=read('components/TrackList.tsx');const body=source.slice(source.indexOf('export function TrackList'));
  const setup=between(body,'  const tracks =','  const [dropAt');
  const saved={key:'title',dir:1};
  const render=sortable=>run(setup,{useStore:fn=>fn({tracks:{},albums:{},artists:{},selection:[],playlists:[],server:{downloads:{},status:'offline'},clips:{},settings:{snoozed:{}},currentId:null,isPlaying:false}),useState:()=>[saved],usePageState:()=>[saved],useMemo:fn=>fn(),likedIds:()=>new Set(),context:{route:{name:'search',q:'Test'}},sortable},'sort').sort;
  assert.equal(render(false),null);assert.equal(render(true),saved);
});

test('a swipe after changing tabs during spring-back moves the new page',()=>{
  const h=edgeHarness();h.fire('touchstart',5,0);h.fire('touchmove',105,20);h.fire('touchend',105,500);h.change();h.parts.page={style:{removeProperty(){}}};h.fire('touchstart',5,510);h.fire('touchmove',25,530);assert.equal(h.parts.page.style.translate,'20px 0');
});
