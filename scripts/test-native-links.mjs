import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

function app({ desktop = false, native = false } = {}) {
  const routes = [], listeners = new Map(), messages = [];
  let desktopLink;
  const window = {
    addEventListener(name, handler) { listeners.set(name, handler); },
    setInterval() {},
    ...(native ? { webkit: { messageHandlers: { slopifyLinks: { postMessage(message) { messages.push(message); } } } } } : {}),
    ...(desktop ? { slopifyDesktop: {
      updates: { onChange() {}, get: async () => ({ status: 'idle' }) },
      settings: { get: async () => ({}) }, onCommand() {}, onLink(handler) { desktopLink = handler; }, nowPlaying() {},
    } } : {}),
  };
  const source = fs.readFileSync(new URL('../src/state/desktop.ts', import.meta.url), 'utf8');
  const js = stripTypeScriptTypes(source.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, ''));
  const box = vm.createContext({ window, navigate: r => routes.push(JSON.parse(JSON.stringify(r))), subscribeApp() {}, engine: {}, getState: () => ({ tracks: {} }), useSyncExternalStore() {} });
  vm.runInContext(`${js}\nglobalThis.start = startDesktopUpdates;`, box);
  box.start();
  return { window, routes, messages, start: box.start, desktopLink: value => desktopLink?.(value), nativeLink: value => listeners.get('slopifySharedLink')?.({ detail: value }) };
}

test('NT3: native readiness is acknowledged without a desktop bridge; cold and warm links navigate', () => {
  const native = app({ native: true });
  assert.deepEqual(native.messages, ['ready']);
  assert.equal(native.window.slopifyNativeLinksReady, true);
  native.nativeLink({ type: 'shared', id: 'abcdefghijklmnop' });
  native.nativeLink({ type: 'shared', id: '1234567890abcdef' });
  assert.deepEqual(native.routes, [{ name: 'shared', id: 'abcdefghijklmnop' }, { name: 'shared', id: '1234567890abcdef' }]);
  native.start();
  assert.deepEqual(native.messages, ['ready'], 'listener installs once');
});

test('NT3: native and desktop share validation and navigation; malformed links are ignored', () => {
  for (const platform of [{ native: true }, { desktop: true }]) {
    const client = app(platform);
    const send = platform.native ? client.nativeLink : client.desktopLink;
    for (const bad of [null, {}, { type: 'other', id: 'abcdefghijklmnop' }, { type: 'shared', id: '../etc/passwd' }, { type: 'shared', id: 1 }, { type: 'shared', id: 'abcdefghijklmnop?' }]) send(bad);
    assert.deepEqual(client.routes, []);
    send({ type: 'shared', id: 'abcdefghijklmnop' });
    assert.deepEqual(client.routes, [{ name: 'shared', id: 'abcdefghijklmnop' }]);
  }
});

test('NT3: ordinary browser startup remains unchanged', () => {
  const browser = app();
  browser.nativeLink({ type: 'shared', id: 'abcdefghijklmnop' });
  assert.deepEqual(browser.routes, []);
});
