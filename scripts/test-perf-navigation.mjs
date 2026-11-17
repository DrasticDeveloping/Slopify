import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {test} from 'node:test';
const source=fs.readFileSync(new URL('../src/lib/navigation-focus.ts',import.meta.url),'utf8');
function harness() {
 const events={};let modal=false,callback;
 class Element {
  isConnected=true;tabIndex=0;parent=null;calls=[];
  focus(options){document.activeElement=this;this.calls.push(options)}
  closest(){return null}
 }
 const document={body:new Element(),activeElement:null,addEventListener:(type,fn)=>{events[type]=fn},querySelector:()=>modal?{}:null};
 const heading=new Element(),origin=new Element(),root=new Element();root.querySelector=()=>heading;root.contains=el=>el===origin||el===heading;
 const box=vm.createContext({document,HTMLElement:Element,WeakRef,MutationObserver:class{constructor(fn){callback=fn}observe(){}disconnect(){}}});
 vm.runInContext(stripTypeScriptTypes(source.replace(/^export /gm,''))+'\nglobalThis.api={prepareNavigationFocus,applyNavigationFocus};',box);
 return {api:box.api,document,heading,origin,root,events,modal:v=>{modal=v;callback?.()},inert:v=>{root.closest=()=>v?{}:null;callback?.()}};
}
test('push focuses a non-editable heading without scrolling, Back restores the retained origin',()=>{const h=harness();h.document.activeElement=h.origin;h.api.prepareNavigationFocus('from','to');h.api.applyNavigationFocus(h.root);assert.equal(h.document.activeElement,h.heading);assert.equal(h.heading.calls[0].preventScroll,true);assert.equal(h.heading.tabIndex,-1);h.api.prepareNavigationFocus('to','from',true);h.api.applyNavigationFocus(h.root);assert.equal(h.document.activeElement,h.origin);assert.equal(h.origin.calls[0].preventScroll,true);});
test('touch navigation leaves focus alone; a removed origin falls back to the heading',()=>{const h=harness();h.document.activeElement=h.origin;h.events.pointerdown({pointerType:'touch'});h.api.prepareNavigationFocus('from','to');h.api.applyNavigationFocus(h.root);assert.equal(h.heading.calls.length,0);h.events.keydown({});h.origin.isConnected=false;h.api.prepareNavigationFocus('to','from',true);h.api.applyNavigationFocus(h.root);assert.equal(h.document.activeElement,h.heading);});
test('a closing dialog retains focus until it leaves the page',()=>{const h=harness();h.document.activeElement=h.origin;h.modal(true);h.api.prepareNavigationFocus('from','to');h.api.applyNavigationFocus(h.root);assert.equal(h.document.activeElement,h.origin);h.modal(false);assert.equal(h.document.activeElement,h.heading);});
test('a menu Go to… waits for the page behind it to stop being inert before focusing',()=>{const h=harness();h.document.activeElement=h.origin;h.inert(true);h.api.prepareNavigationFocus('from','to');h.api.applyNavigationFocus(h.root);assert.equal(h.document.activeElement,h.origin,'nothing focused while inert');h.inert(false);assert.equal(h.document.activeElement,h.heading,'heading focused once the page is usable');});
