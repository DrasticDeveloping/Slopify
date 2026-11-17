import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

function evaluate(file, bindings, exports) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.replace(/^import .*;$/gm, '').replace(/^export /gm, ''));
  const context = vm.createContext(bindings);
  vm.runInContext(`${code}\nglobalThis.api = {${exports}}`, context);
  return context.api;
}

test('JavaScript scrolling respects app and system Reduce Motion independently', () => {
  for (const app of ['reduce', 'full', undefined]) for (const system of [true, false]) {
    const api = evaluate('lib/motion.ts', {document: {documentElement: {dataset: {motion: app}}}, window: {matchMedia: () => ({matches: system})}}, 'scrollBehavior');
    assert.equal(api.scrollBehavior(), app === 'reduce' || system ? 'instant' : 'smooth');
  }
});

test('custom backgrounds stay readable, preserving already dark colours and constraining saved updates', () => {
  let saved;
  const api = evaluate('state/themes.ts', {
    getState: () => ({settings: {customThemes: [{id: 'custom-test', name: 'Theme', accent: '#8b5cf6', accent2: '#f472b6', background: '#08080c'}]}}),
    updateSettings: patch => {saved = patch;}, toast() {},
  }, 'readableBackground, luminance, updateTheme');
  for (const colour of ['#ffffff', '#cccccc', '#ff8800', '#00ff00', '#0088ff', '#f7e7ce', '#08080c', '#000000']) {
    const background = api.readableBackground(colour);
    assert.match(background, /^#[0-9a-f]{6}$/i);
    assert.ok(api.luminance(background) <= .03, background);
    if (api.luminance(colour) <= .03) assert.equal(background, colour);
    // Primary body text retains at least WCAG AA contrast on the chosen background.
    assert.ok((api.luminance('#f6f5f8') + .05) / (api.luminance(background) + .05) >= 4.5);
    assert.equal(api.readableBackground(background), background);
  }
  api.updateTheme('custom-test', {background: '#ffffff'});
  assert.ok(api.luminance(saved.customThemes[0].background) <= .03);
});

test('playlist import jumps pass the effective motion preference to both scroll APIs', () => {
  const source = readFileSync(new URL('../src/components/ExternalSearch.tsx', import.meta.url), 'utf8');
  const group = source.slice(source.indexOf('  const showGroup ='), source.indexOf('  // Each press goes on'));
  const next = source.slice(source.indexOf('  const showNextCheck ='), source.indexOf('  // How far down the page'));
  assert.ok(group && next);
  for (const behavior of ['instant', 'smooth']) {
    const calls = [];
    const target = {scrollIntoView: options => calls.push(options), querySelector: () => ({focus() {}})};
    const box = vm.createContext({
      scrollBehavior: () => behavior, requestAnimationFrame: fn => fn(),
      setOpenGroups: fn => fn({missing: false, owned: false}), groupRefs: {missing: {current: target}},
      stats: {toCheck: [3]}, lastChecked: {current: -1}, document: {getElementById: id => id === 'playlist-row-3' ? target : null},
    });
    vm.runInContext(`${stripTypeScriptTypes(group + next)}\nshowGroup('missing');showNextCheck();`, box);
    assert.deepEqual(calls.map(c => c.behavior), [behavior, behavior]);
    assert.deepEqual(calls.map(c => c.block), ['start', 'center']);
  }
});
