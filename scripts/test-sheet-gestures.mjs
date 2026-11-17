// Production gesture handlers with only React and DOM/platform boundaries replaced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
function harness({ translate = '0px 0px' } = {}) {
  let now = 0;
  const listeners = new Map();
  const timers = new Map();
  const effects = [];
  let timerId = 0;
  class Element {
    dataset = {}; offsetHeight = 400; clientHeight = 400; scrollHeight = 400;
    clientWidth = 400; scrollWidth = 400; scrollTop = 0; parentElement = null;
    properties = new Map();
    style = {setProperty:(k,v)=>this.properties.set(k,v),removeProperty:k=>this.properties.delete(k)};
    events = new Map();
    matches(){return false;} closest(){return null;}
    addEventListener(name,fn){if(!this.events.has(name))this.events.set(name,new Set());this.events.get(name).add(fn);}
    removeEventListener(name,fn){this.events.get(name)?.delete(fn);}
  }
  const el = new Element();
  const document = {addEventListener:(n,f)=>{if(!listeners.has(n))listeners.set(n,new Set());listeners.get(n).add(f);},removeEventListener:(n,f)=>listeners.get(n)?.delete(f)};
  const later=(fn)=>{timers.set(++timerId,fn);return timerId;};
  const box=vm.createContext({Element,HTMLElement:Element,document,performance:{now:()=>now},getComputedStyle:()=>({translate,overflowY:'visible',overflowX:'visible'}),nativeFeedback(){},useRef:v=>({current:v}),useLayoutEffect:fn=>effects.push(fn),useEffect:fn=>effects.push(fn),requestAnimationFrame:later,cancelAnimationFrame:id=>timers.delete(id),clearTimeout:id=>timers.delete(id),window:{matchMedia:()=>({matches:true}),setTimeout:later,requestAnimationFrame:later,cancelAnimationFrame:id=>timers.delete(id)}});
  const source=fs.readFileSync(new URL('../src/lib/mobile.ts',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'').replace(/^export /gm,'');
  vm.runInContext(stripTypeScriptTypes(source)+'\nglobalThis.api={useSheetDrag,swallowNextClick,useLongPress};',box);
  box.api.useSheetDrag({current:el},()=>{});for(const effect of effects)effect();
  const event=(type,y=0)=>({type,target:el,touches:type==='touchend'?[]:[{identifier:1,clientX:100,clientY:y}],changedTouches:[{identifier:1}],cancelable:true,timeStamp:now,detail:1,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}});
  const emit=(type,y)=>{now+=20;const e=event(type,y);for(const f of el.events.get(type)||[])f(e);return e;};
  const doc=(type)=>{const e=event(type);for(const f of [...(listeners.get(type)||[])])f(e);return e;};
  return {el,api:box.api,emit,doc,advance:ms=>now+=ms,runTimers:()=>{for(const [id,fn] of [...timers]){timers.delete(id);fn();}}};
}
test('a new tap survives a cancelled sheet drag',()=>{const h=harness();h.emit('touchstart',100);h.emit('touchmove',103);h.emit('touchmove',128);h.advance(120);h.emit('touchend',128);assert.equal(h.emit('click').prevented,true);h.emit('touchstart',100);h.emit('touchend',100);assert.notEqual(h.emit('click').prevented,true);});
test('a no-scroll handle can reverse from up to down',()=>{const h=harness();h.emit('touchstart',100);h.emit('touchmove',94);h.emit('touchmove',108);h.emit('touchmove',145);assert.equal(h.el.dataset.sheet,'dragging');assert.ok(parseFloat(h.el.properties.get('--sheet-drag-y'))>20);});
test('re-grabbing keeps the interpolated spring position',()=>{const h=harness({translate:'0px 37px'});h.emit('touchstart',100);h.emit('touchmove',103);assert.ok(Math.abs(parseFloat(h.el.properties.get('--sheet-drag-y'))-40)<1);});
test('long press drops its compatibility click',()=>{const h=harness();h.api.swallowNextClick();assert.equal(h.doc('click').prevented,true);assert.notEqual(h.doc('click').prevented,true);});
test('long press without a compatibility click preserves the next touch tap',()=>{const h=harness();h.api.swallowNextClick();h.doc('touchstart');assert.notEqual(h.doc('click').prevented,true);});
test('long press preserves the next keyboard activation',()=>{const h=harness();h.api.swallowNextClick();h.doc('keydown');assert.notEqual(h.doc('click').prevented,true);});
test('after a long press, the next deliberate click on the card still works',()=>{
  const h=harness();let opened=0;
  const press=h.api.useLongPress(()=>{opened++;});
  const touch=(extra={})=>({touches:[{clientX:10,clientY:10}],target:{closest:()=>null},currentTarget:h.el,...extra});
  press.onTouchStart(touch());h.runTimers();assert.equal(opened,1,'the hold opens the menu');
  press.onTouchEnd();
  // The release's own click is dropped at the document; later, an assistive/programmatic click on the card arrives.
  const click={preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};
  press.onClickCapture(click);
  assert.notEqual(click.prevented,true,'a later click is not taken for the hold');
});
