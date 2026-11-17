import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createImportApi } from '../server/api.mjs';

const secret = randomBytes(32).toString('hex');
const cookie = `slopify_session=${secret}`;
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), 'slopify-native-test-'));
const listen = async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const close = (server) => new Promise(r => { server.close(r); server.closeAllConnections?.(); });

async function request(port, target, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${target}`, options);
  return { status: response.status, body: await response.text() };
}

async function apiServer(embeddedSecret) {
  const dataDir = await temporary();
  const api = createImportApi({ dataDir, embeddedSecret });
  const server = http.createServer((req, res) => api(req, res, () => res.writeHead(404).end()).catch(() => res.writeHead(500).end()));
  const port = await listen(server);
  return { port, stop: async () => { await close(server); await fs.rm(dataDir, { recursive: true, force: true }); } };
}

test('NT4: embedded API requires the launch cookie for reads, writes and media', async () => {
  const server = await apiServer(secret);
  try {
    for (const [target, method] of [['/api/state', 'GET'], ['/api/state', 'PUT'], ['/api/health', 'GET'], ['/api/device-files/native-test', 'GET'], ['/api/songs/native-test/file', 'GET'], ['/api/cloud/v1/me', 'GET']]) {
      assert.equal((await request(server.port, target, { method })).status, 401, `${method} ${target} without credentials`);
      assert.equal((await request(server.port, target, { method, headers: { Cookie: 'slopify_session=wrong' } })).status, 401);
    }
    assert.equal((await request(server.port, '/api/state', { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await request(server.port, '/api/device-files/native-test', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'audio/mp4' }, body: 'test media' })).status, 200);
    assert.equal((await request(server.port, '/api/device-files/native-test', { headers: { Cookie: cookie } })).body, 'test media');
    const health = await request(server.port, '/api/health', { headers: { Cookie: cookie } });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).presence, true, 'embedded page opens its authenticated WebSocket');
    assert.equal((await request(server.port, '/api/device-files/native-test', { method: 'DELETE', headers: { Cookie: cookie, Origin: 'https://other.example' } })).status, 403);
  } finally { await server.stop(); }
});

test('NT4: desktop/browser API still works without a cookie', async () => {
  const server = await apiServer(undefined);
  try {
    assert.equal((await request(server.port, '/api/state')).status, 200);
    assert.equal((await request(server.port, '/api/health')).status, 200);
  } finally { await server.stop(); }
});

async function childServer(port, dataDir) {
  const child = spawn(process.execPath, ['server/main.mjs', '--host', '127.0.0.1', '--port', String(port), '--data', dataDir, '--keep-running'], {
    cwd: new URL('../', import.meta.url), env: { ...process.env, SLOPIFY_EMBEDDED: '1', SLOPIFY_EMBEDDED_SECRET: secret, SLOPIFY_EMBEDDED_STATUS: path.join(dataDir, 'startup.json') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  const until = async (predicate, label) => {
    for (let i = 0; i < 100; i++) {
      if (predicate(log)) return;
      if (child.exitCode !== null) throw new Error(`${label}: server exited ${child.exitCode}\n${log}`);
      await delay(50);
    }
    throw new Error(`${label}: timed out\n${log}`);
  };
  return { child, until, stop: async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } } };
}

const raw = (port, target, headers = '') => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1');
  let reply = '';
  socket.setTimeout(2000, () => socket.destroy());
  socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${headers}\r\n`));
  socket.on('data', b => { reply += b; socket.destroy(); });
  socket.on('error', reject); socket.on('close', () => resolve(reply));
});

test('NT6: malformed upgrade URL cannot terminate the embedded server; NT4: WebSocket authenticates', async () => {
  const probe = net.createServer(); const port = await listen(probe); await close(probe);
  const dataDir = await temporary(); const server = await childServer(port, dataDir);
  try {
    await server.until(log => log.includes('Slopify is running'), 'startup');
    await raw(port, 'http://[invalid/api/presence');
    await delay(100);
    assert.equal(server.child.exitCode, null, 'malformed absolute URL killed server');
    assert.equal((await request(port, '/api/state')).status, 401);
    assert.match(await raw(port, '/api/presence', `Origin: http://127.0.0.1:${port}\r\n`), /401|403/);
    assert.match(await raw(port, '/api/presence', `Origin: http://127.0.0.1:${port}\r\nCookie: ${cookie}\r\n`), /101 Switching Protocols/);
  } finally { await server.stop(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('NT5: occupied port reports a startup error, stays alive and retries after release', async () => {
  const blocker = net.createServer(s => s.destroy()); const port = await listen(blocker);
  const dataDir = await temporary(); const server = await childServer(port, dataDir);
  try {
    await server.until(log => log.includes('already in use'), 'collision');
    await delay(100);
    assert.equal(server.child.exitCode, null, 'port collision killed embedded process');
    const status = JSON.parse(await fs.readFile(path.join(dataDir, 'startup.json'), 'utf8'));
    assert.equal(status.state, 'error'); assert.match(status.message, /already in use/);
    await close(blocker);
    await server.until(log => log.includes('Slopify is running'), 'automatic retry');
    assert.equal((await request(port, '/api/health', { headers: { Cookie: cookie } })).status, 200);
  } finally { if (blocker.listening) await close(blocker); await server.stop(); await fs.rm(dataDir, { recursive: true, force: true }); }
});
