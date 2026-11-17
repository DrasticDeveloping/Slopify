import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const settle = () => new Promise(resolve => setImmediate(resolve));
function boot(initial) {
  const elements = Object.fromEntries(['status', 'ring', 'retry'].map(id => [id, { hidden: false, textContent: '', addEventListener(type, listener) { this[type] = listener; } }]));
  const navigations = [];
  let next = initial, networkCalls = 0;
  const box = vm.createContext({
    document: { getElementById: id => elements[id] },
    window: { webkit: { messageHandlers: { slopifyServer: { postMessage: async () => next } } } },
    // A foreign listener can answer HTTP, but native startup hasn't authenticated it.
    fetch: async () => { networkCalls++; return { ok: true }; },
    location: { replace: url => navigations.push(url) }, setTimeout, Date,
  });
  const html = fs.readFileSync(new URL('../mobile/boot/index.html', import.meta.url), 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], box);
  return { elements, navigations, networkCalls: () => networkCalls, ready() { next = { ready: true }; elements.retry.click(); }, serverUp() { next = { ready: true }; } };
}

test('NT5: occupied port shows a recoverable error and never opens a foreign HTTP listener', async () => {
  const page = boot({ ready: false, error: 'Port 5198 is already in use.' });
  await settle();
  assert.deepEqual(page.navigations, []);
  assert.equal(page.networkCalls(), 0, 'startup must go through native readiness, not arbitrary HTTP');
  assert.match(page.elements.status.textContent, /Port 5198 is already in use/);
  assert.equal(page.elements.retry.hidden, false);
  page.ready();
  await settle();
  assert.deepEqual(page.navigations, ['http://127.0.0.1:5198/']);
});

test('NT5: verified native readiness opens the app', async () => {
  const page = boot({ ready: true });
  await settle();
  assert.deepEqual(page.navigations, ['http://127.0.0.1:5198/']);
});

test('NT5: after a port error, the app opens by itself once the server gets the port', async () => {
  const page = boot({ ready: false, error: 'Port 5198 is already in use.' });
  await settle();
  assert.deepEqual(page.navigations, []);
  page.serverUp();
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.deepEqual(page.navigations, ['http://127.0.0.1:5198/'], 'no Try again needed');
});
