// Production logic, with providers, library persistence and downloads faked at their boundaries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const root = process.env.SLOPIFY_TEST_ROOT ? pathToFileURL(`${resolve(process.env.SLOPIFY_TEST_ROOT)}/`) : new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
function part(source, from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, from);
  return source.slice(a, b);
}
function evaluate(source, bindings, exposed) {
  const box = vm.createContext({ AbortController, AbortSignal, DOMException, URL, setTimeout, clearTimeout, ...bindings });
  vm.runInContext(`${stripTypeScriptTypes(source.replace(/^export /gm, ''))}\nglobalThis.api = {${exposed}}`, box);
  return box.api;
}
const importer = read('src/state/importer.ts');
const external = read('src/components/ExternalSearch.tsx');
const downloadable = (c) => typeof c?.sourceURL === 'string' && c.sourceURL.length > 0;
const candidate = (upload, song = 'song') => ({ sourceURL: `https://youtube.test/${upload}`, sourceProvider: 'youtube', videoID: upload, title: song, importMetadata: { provider: 'spotify', trackID: song, title: song, artist: 'Artist' } });
const resolution = (candidates) => ({ kind: 'spotify_playlist', mediaKind: 'audio', playlist: { title: 'Imported' }, track: {}, candidates });
function lookupHarness() {
  let resolveSearch;
  const api = evaluate(part(external, 'const lookups =', '/** The lookup for a pasted link:'), {
    spotifySongLinks: () => [], window: { setTimeout, clearTimeout }, IDLE_TIMEOUT: 1000,
    searchDiscovery: (_q, signal) => new Promise((resolve, reject) => { resolveSearch = resolve; signal.addEventListener('abort', () => reject(signal.reason)); }),
  }, 'startLookup, lookups');
  const follow = evaluate(part(external, 'function followLookup(', '/**\n * Searches the music platforms'), {}, 'followLookup').followLookup;
  return { ...api, follow, finish: (r) => resolveSearch(r) };
}
function importerHarness({ follow, onDownload } = {}) {
  let library = { tracks: {}, artists: {}, playlists: [], settings: {} };
  let state = { selected: [], source: 'playlist', busy: null };
  const sources = new Map();
  let nextPlaylist = 0;
  const api = evaluate([
    part(importer, 'function sourceSongKey(', '/**\n * A found song'),
    part(importer, 'function transferKey(', '/**\n * Once a playlist\'s songs are saved'),
  ].join('\n'), {
    getState: () => library, state, pendingFollow: follow, pendingSaveOptions: null, batchProgress: null,
    set: (patch) => Object.assign(state, patch),
    setState: (patch) => Object.assign(library, typeof patch === 'function' ? patch(library) : patch),
    playlistOwnedTrack: () => undefined, isDownloadable: downloadable, canStream: downloadable,
    streamSources: sources, streamTrackId: (key) => `stream_${key}`, resultStreamKey: (c, kind) => `${kind}:${c.videoID}`, resultPlatform: () => 'youtube',
    registerStreams: (songs) => songs.forEach((song) => { const id = `stream_${song.key}`; library.tracks[id] = { id, stream: true }; sources.set(id, song); }),
    begin: () => { state.busy = 'import'; return new AbortController(); }, end: () => { state.busy = null; },
    showTransfer() {}, shownInline: () => true, finishTransfer() {}, showSaveSummary() {}, toast() {}, navigate() {}, fail: (error) => { throw error; },
    createPlaylist: (name, trackIds) => { const id = `p${++nextPlaylist}`; library.playlists.push({ id, name, trackIds }); return id; },
    addToPlaylist: (id, ids) => { const p = library.playlists.find((p) => p.id === id); p.trackIds = [...new Set([...p.trackIds, ...ids])]; },
    moveInPlaylist() {},
    startDownload: async (c) => { await onDownload?.(c); return { ok: true, result: { kind: 'created', track: { id: c.videoID } } }; },
    addServerTrack: (t) => { library.tracks[t.id] = t; return t.id; },
  }, 'confirmPlaylist, setFollow: (f) => pendingFollow = f, setOptions: (o) => pendingSaveOptions = o');
  return { ...api, state, get library() { return library; }, save: async (r, options = { playlistName: 'Imported', includeOwned: true, download: false }) => { state.selected = r.candidates.map((_, i) => i); api.setOptions(options); await api.confirmPlaylist(r); } };
}
test('SR1: weak title matches are unchecked until audio confirms them', () => {
  const { unsure } = evaluate(part(external, 'const unsure =', 'const describe ='), {}, 'unsure');
  assert.equal(unsure({ match: { title: .5 } }), true);
  assert.equal(unsure({ match: { title: .5, listened: { verdict: 'same' } } }), false);
  assert.equal(unsure({ verificationPending: true }), true);
});
test('SR1: queued rows use the latest replacement and skip rejected uploads', async () => {
  const rows = [candidate('a'), candidate('old', 'two'), candidate('reject', 'three')];
  const r = resolution(rows);
  let latest = resolution([...rows]);
  const saved = [];
  const h = importerHarness({ follow: { latest: () => latest, next: async () => null }, onDownload: async (c) => {
    saved.push(c.videoID);
    if (c.videoID === 'a') latest = resolution([rows[0], candidate('new', 'two'), { sourceURL: '', unmatched: 'not_found' }]);
  } });
  await h.save(r, { playlistName: 'Imported', includeOwned: true, download: true });
  assert.deepEqual(saved, ['a', 'new']);
});
test('SR1: pending verification stays out of Select all', () => {
  const r = resolution([{ ...candidate('weak'), verificationPending:true }]);
  const { selected } = evaluate(part(external, 'const selected = playlist', '\n  // Whether a song found later'), {
    playlist:true, r, downloadable:(r) => r.candidates.map((_, i) => i), ownedAt:() => undefined, tickedNow:() => true,
  }, 'selected');
  assert.equal(selected.length, 0);
});
test('SR1: provider publishes queued verification before a weak match and clears it after rejection', async () => {
  const file = new URL('server/providers/local-import-platform.cjs', root);
  const box = vm.createContext({ require:createRequire(file), module:{exports:{}}, console, Buffer, process, setTimeout, clearTimeout, setInterval, clearInterval, URL, AbortController });
  vm.runInContext(`${fs.readFileSync(file,'utf8')}\nmodule.exports.matchPlaylistRows=matchPlaylistRows;`, box);
  const published = [];
  let listened = 0;
  const weak = { ...candidate('weak'), match:{title:.5,artist:1} };
  const result = await box.module.exports.matchPlaylistRows([{track:weak.importMetadata}], {
    signal:new AbortController().signal, onStage:(p) => { if(p.row) published.push(structuredClone(p.row.candidate)); },
    preview:() => ({}), search:async()=>[weak], listen:async()=>{listened++; return {verdict:'different'};}, pace:{gapMs:0},
  });
  assert.equal(listened, 1);
  assert.equal(published[0].verificationPending, true);
  assert.equal(result[0].verificationPending, false);
  assert.equal(result[0].unmatched, 'not_found');
});
test('SR2: a new search cannot replace the running save selection callback', async () => {
  let slot;
  const hooks = {
    useRef: (initial) => slot ??= { current: initial },
    useMemo: (fn, deps) => { if (!slot || deps.some((d, i) => d !== slot.deps[i])) slot = { deps, value: fn() }; return slot.value; },
  };
  // Run the actual hook declaration twice, as React does on a query change.
  const code = part(external, 'const wanted =', '\n  wanted.current =');
  const make = (query, lookup) => evaluate(code, { ...hooks, query, kind: 'audio', lookup }, 'wanted').wanted;
  const one = { resolution: { candidates: [] }, done: true, controller: new AbortController(), listeners: new Set() };
  const old = make('playlist', one); old.current = () => true;
  const running = lookupHarness().follow(one, old, new Set());
  one.resolution.candidates.push(candidate('next'));
  const replacement = make('different query', null); replacement.current = () => false;
  assert.equal((await running.next(new AbortController().signal))?.length, 1);
});
test('SR3: replacing a lookup wakes an importer waiting for matches', async () => {
  const h = lookupHarness();
  const one = h.startLookup('https://open.spotify.com/playlist/first', 'audio', 0);
  one.resolution = { ...resolution([]), matching: { completed: 0, total: 1 } };
  const importer = importerHarness({follow:h.follow(one, { current: () => false }, new Set())});
  const running = importer.save(one.resolution);
  assert.equal(importer.state.busy, 'import');
  const two = h.startLookup('https://open.spotify.com/playlist/second', 'audio', 0);
  try {
    const result = await Promise.race([running.then(() => 'settled'), new Promise((r) => setTimeout(() => r('hung'), 40))]);
    assert.equal(result, 'settled');
    assert.equal(one.listeners.size, 0);
    assert.equal(importer.state.busy, null);
  } finally { h.finish(resolution([])); two.controller.abort(); }
});
test('SR4: streaming re-import reconciles source songs across upload changes', async () => {
  const h = importerHarness();
  await h.save(resolution([candidate('original')]));
  await h.save(resolution([candidate('different')]));
  assert.equal(h.library.playlists.length, 1);
  assert.equal(h.library.playlists[0].trackIds.length, 1);
});
test('SR5: mix hide uses the original multi-artist discovery key', () => {
  let hidden;
  const song = { key: 'artist and guest|song' };
  const { mixItems } = evaluate(part(read('src/lib/menus.ts'), 'function mixItems(', '/** `why`:'), {
    getState: () => ({}), trackKey: () => 'artist|song', streamSong: () => song,
    hideFromMix: (_id, key) => { hidden = key; },
  }, 'mixItems');
  mixItems({ id: 'stream', stream: true }, { name: 'mix', id: 'daily' })[0].run();
  assert.equal(hidden, song.key);
});
test('SR6: collections of Spotify track links force audio', () => {
  const { isAudioOnlySource } = evaluate(part(importer, 'export function spotifySongLinks(', 'export const isPlaylist'), {}, 'isAudioOnlySource');
  assert.equal(isAudioOnlySource('https://open.spotify.com/track/1234567890123456789012 https://open.spotify.com/track/abcdefghijklmnopqrstuv'), true);
  assert.equal(isAudioOnlySource('spotify:track:1234567890123456789012 spotify:track:abcdefghijklmnopqrstuv'), true);
  assert.equal(isAudioOnlySource('open.spotify.com/track/1234567890123456789012 open.spotify.com/track/abcdefghijklmnopqrstuv'), true);
  assert.equal(isAudioOnlySource('https://youtube.com/watch?v=12345678901'), false);
});
