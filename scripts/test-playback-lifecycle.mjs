// Run with Node 24+: node --test scripts/test-playback-lifecycle.mjs
// Evaluate production TypeScript with only platform/import boundaries faked.
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const read = (file) => fs.readFileSync(process.env.SLOPIFY_TEST_SOURCE_ROOT ? `${process.env.SLOPIFY_TEST_SOURCE_ROOT}/src/${file}` : new URL(`../src/${file}`, import.meta.url), "utf8");
function evaluate(source, bindings, expose) {
  const box = vm.createContext({ DOMException, queueMicrotask, ...bindings });
  const js = stripTypeScriptTypes(source.replace(/^import .*;\r?$/gm, "").replace(/^export /gm, ""));
  vm.runInContext(`${js}\nglobalThis.api = { ${expose} };`, box);
  return box;
}
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Production source boundaries exist: ${start}`);
  return source.slice(from, to);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function engineHarness({ native = true, activate = () => Promise.resolve(), resume, plays = [] } = {}) {
  const elements = [];
  const contexts = [];
  const timers = new Map();
  const events = [];
  let nextTimer = 0;
  let shownVideo = null;
  const parkedVideos = new Set();
  const document = { visibilityState: "visible", createElement: () => new Video() };
  const later = (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; };
  class Media {
    static HAVE_NOTHING = 0;
    static HAVE_FUTURE_DATA = 3;
    readyState = 0;
    duration = 100;
    currentTime = 0;
    paused = true;
    ended = false;
    playCalls = 0;
    pauseCalls = 0;
    listeners = new Map();
    constructor() { elements.push(this); }
    play() {
      events.push("media.play");
      this.playCalls++;
      this.paused = false;
      return plays.length ? plays.shift()() : Promise.resolve();
    }
    pause() { this.pauseCalls++; this.paused = true; }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    emit(name) { this[`on${name}`]?.(); this.listeners.get(name)?.(); }
    removeAttribute() {}
    load() {}
  }
  class Video extends Media {}
  const parameter = () => ({ value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, setValueCurveAtTime() {} });
  const node = () => ({ gain: parameter(), pan: parameter(), frequency: parameter(), Q: parameter(), threshold: parameter(), ratio: parameter(), knee: parameter(), connect(next) { return next; }, disconnect() {} });
  class Context {
    state = "suspended";
    currentTime = 0;
    destination = node();
    resumeCalls = 0;
    sources = 0;
    constructor() { contexts.push(this); }
    createGain = node;
    createDynamicsCompressor = node;
    createAnalyser = node;
    createBiquadFilter = node;
    createStereoPanner = node;
    createMediaElementSource() { this.sources++; return node(); }
    listeners = new Map();
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    emit(name) { this.listeners.get(name)?.(); }
    resume() {
      events.push("ctx.resume");
      this.resumeCalls++;
      if (resume) return resume(this);
      this.state = "running";
      return Promise.resolve();
    }
    suspend() { this.state = "suspended"; return Promise.resolve(); }
  }
  const source = read("audio/engine.ts").replace(/^if \(import\.meta.*$/gm, "");
  const box = evaluate(source, {
    Audio: Media, HTMLMediaElement: Media, HTMLVideoElement: Video, AudioContext: Context,
    hasVideoDemand: () => true, document, navigator: { audioSession: { type: "auto" } },
    isNativeApp: native, activateNativeAudio: () => { events.push("native.activate"); return activate(); },
    fadeLevel: (n) => Math.max(0, Math.min(1, n)), parkMedia(el) { parkedVideos.add(el); }, setCurrentVideo(el) { shownVideo = el; }, releaseVideo(el) { if (shownVideo === el) shownVideo = null; },
    performance: { now: () => 0 }, setTimeout: later, clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id), window: { setTimeout: later, setInterval: later },
  }, "AudioEngine");
  const engine = new box.api.AudioEngine();
  const blocked = [], started = [], waiting = [];
  engine.onBlocked = (id) => blocked.push(id);
  engine.onStarted = (id) => started.push(id);
  engine.onWaiting = (id) => waiting.push(id);
  const load = (id = "a", options = {}) => engine.load({ id, fileUrl: `/${id}.m4a` }, { end: 100, autoplay: true, ...options });
  return { engine, load, elements, contexts, events, timers, blocked, started, waiting, parkedVideos, document, get shownVideo() { return shownVideo; } };
}

test("native ordinary handoffs retain one media element/source and never retire the new song", async () => {
  const h = engineHarness();
  h.load();
  await settle();
  assert.equal(h.parkedVideos.has(h.elements[0]), true, "native audio owner remains in the document");
  h.engine.load({ id: "b", fileUrl: "/b.mp4", video: true }, { start: 10, end: 80, autoplay: true });
  await settle();
  assert.equal(h.shownVideo, h.elements[1]);
  assert.equal(h.shownVideo.muted, true);
  h.load("c", { start: 20 });
  h.engine.seek(42);
  h.elements[0].readyState = 1;
  h.elements[0].onloadedmetadata();
  await settle();
  assert.equal(h.elements.length, 2, "one persistent audio owner plus its optional muted picture");
  assert.equal(h.contexts[0].sources, 1);
  assert.equal(h.elements[0].src, "/c.m4a");
  assert.equal(h.elements[0].currentTime, 42);
  assert.equal(h.shownVideo, null);
  assert.equal(h.engine.retiring.size, 0);
  for (const { fn, delay } of [...h.timers.values()]) if (delay <= 1000) fn();
  assert.equal(h.elements[0].pauseCalls, 0);
  assert.equal(h.elements[0].paused, false);
});

test("background video suspension never pauses its persistent listening audio", async () => {
  const h = engineHarness();
  h.engine.load({ id: "a", fileUrl: "/a.mp4", video: true }, { end: 100, autoplay: true });
  await settle();
  const audio = h.elements[0], picture = h.shownVideo;
  assert.notEqual(audio, picture);
  assert.equal(picture.muted, true);
  h.document.visibilityState = "hidden";
  h.engine.check();
  assert.equal(picture.paused, true);
  assert.equal(audio.paused, false);
  audio.currentTime = 35;
  const plays = audio.playCalls;
  h.document.visibilityState = "visible";
  h.engine.resumeAfterInterruption();
  assert.equal(audio.playCalls, plays, "foreground does not restart healthy listening audio");
  assert.equal(picture.paused, false);
  assert.equal(picture.currentTime, 35);
});

test("desktop ordinary handoffs still use separate media voices", async () => {
  const h = engineHarness({ native: false });
  h.load();
  await settle();
  h.load("b");
  await settle();
  assert.equal(h.elements.length, 2);
  assert.equal(h.engine.retiring.size, 1);
});

test("media play and graph resume run in the initiating gesture before bridge activation settles", async () => {
  const activation = deferred();
  const h = engineHarness({ activate: () => activation.promise });
  h.load();
  assert.deepEqual(h.events, ["native.activate", "media.play", "ctx.resume"]);
  assert.deepEqual(h.started, []);
  await settle();
  assert.deepEqual(h.waiting, ["a"]);
  activation.resolve();
  await settle();
  assert.deepEqual(h.started, ["a"]);
  h.load("b");
  await settle();
  assert.equal(h.events.filter((event) => event === "native.activate").length, 1, "an already active native session is reused across songs");
});

test("Play-Pause-Play ignores a stale native activation rejection", async () => {
  const first = deferred(), second = deferred();
  const activations = [first, second];
  const h = engineHarness({ activate: () => activations.shift().promise });
  h.load();
  h.engine.pause();
  h.engine.play();
  second.resolve();
  await settle();
  first.reject(new Error("stale bridge failure"));
  await settle();
  assert.deepEqual(h.blocked, []);
  assert.deepEqual(h.started, ["a"]);
  assert.equal(h.engine.playing, true);
});

test("old media play rejection cannot stop a newer start on the same voice", async () => {
  const first = deferred();
  const h = engineHarness({ native: false, plays: [() => first.promise] });
  h.load();
  h.engine.pause();
  h.engine.play();
  await settle();
  first.reject(new DOMException("superseded", "NotAllowedError"));
  await settle();
  assert.deepEqual(h.blocked, []);
  assert.deepEqual(h.started, ["a"]);
});

test("an active graph resume failure reports blocked instead of a successful start", async () => {
  const h = engineHarness({ native: false, resume: () => Promise.reject(new Error("interrupted")) });
  h.load();
  await settle();
  assert.equal(h.contexts[0].resumeCalls, 2, "confirm the graph after the initial resume attempt");
  assert.deepEqual(h.blocked, ["a"]);
  assert.deepEqual(h.started, []);
});

test("AbortError retries play once and reports a second failure", async () => {
  const abort = () => Promise.reject(new DOMException("seek interrupted playback", "AbortError"));
  const h = engineHarness({ native: false, plays: [abort, abort] });
  h.load();
  await settle();
  assert.equal(h.elements[0].playCalls, 2);
  assert.deepEqual(h.blocked, ["a"]);
  assert.deepEqual(h.started, []);
});

test("AbortError retry succeeds without leaving playback waiting", async () => {
  const h = engineHarness({ native: false, plays: [() => Promise.reject(new DOMException("seek", "AbortError"))] });
  h.load();
  await settle();
  assert.equal(h.elements[0].playCalls, 2);
  assert.deepEqual(h.started, ["a"]);
  assert.deepEqual(h.blocked, []);
});

test("the latest seek survives delayed metadata for a nonzero clip start", () => {
  const h = engineHarness();
  h.load("a", { start: 20, autoplay: false });
  h.engine.seek(57);
  h.elements[0].currentTime = 0; // WebKit may discard seeks until metadata arrives.
  h.elements[0].readyState = 1;
  h.elements[0].onloadedmetadata();
  assert.equal(h.engine.position, 57);
  h.elements[0].currentTime = 60;
  h.elements[0].onloadedmetadata();
  assert.equal(h.engine.position, 60, "the pending seek is consumed once");
});

test("foreground at EOF advances once without rewinding or replaying", async () => {
  const h = engineHarness();
  h.load();
  await settle();
  const media = h.elements[0];
  let ended = 0;
  h.engine.onEnded = () => ended++;
  media.currentTime = 100;
  media.ended = true;
  h.contexts[0].state = "interrupted";
  h.engine.resumeAfterInterruption();
  h.engine.resumeAfterInterruption();
  assert.equal(ended, 1);
  assert.equal(media.playCalls, 1);
  assert.equal(media.currentTime, 100);
});

test("foreground neither starts paused playback nor restarts a running voice", async () => {
  const h = engineHarness();
  h.load();
  await settle();
  h.engine.resumeAfterInterruption();
  assert.equal(h.elements[0].playCalls, 1);
  h.engine.pause();
  h.contexts[0].state = "interrupted";
  h.engine.resumeAfterInterruption();
  assert.equal(h.elements[0].playCalls, 1);
});

test("near-end crossfade advances once and pause silences its outgoing tail", async () => {
  const h = engineHarness();
  h.engine.lead = 5;
  h.load();
  await settle();
  let near = 0;
  h.engine.onNearEnd = () => near++;
  h.elements[0].currentTime = 96;
  h.engine.check();
  h.engine.check();
  assert.equal(near, 1);
  h.load("b", { crossfade: 5 });
  await settle();
  assert.equal(h.engine.retiring.size, 1);
  h.engine.pause();
  assert.equal(h.engine.retiring.size, 0);
  // Pause must shorten the five-second tail, rather than merely forget it.
  for (const { fn, delay } of [...h.timers.values()]) if (delay <= 300) fn();
  assert.equal(h.elements[0].paused, true);
  assert.equal(h.elements[1].paused, true);
});

function actionHarness({ streams = [], recovery = deferred() } = {}) {
  let state = {
    currentId: null, isPlaying: false, buffering: null, history: [], listens: [],
    tracks: { srv_a: { id: "srv_a", title: "A", stream: true, duration: 100, plays: 0 } },
    order: ["srv_a"], index: 0, upNext: [], listen: { mode: "idle" },
  };
  const loads = [], notices = [];
  let ready = false;
  const engine = { loadedTrackId: null, captureProgress() {}, unload() { this.loadedTrackId = null; },
    load(track, options) { loads.push({ track, options }); this.loadedTrackId = track.id; }, seek() {}, pause() {}, play() {} };
  const source = read("state/actions.ts");
  const selected = "let pendingStream=null, pendingDeviceRecovery=null, playbackLoadGeneration=0, playbackRequestGeneration=0, slippedIn=null, slipHooks=null, previewing=false, cued=null; const rebuiltDeviceSongs=new Set();\n"
    + between(source, "function load(id:", "\n/** Starts playing `ids`")
    + between(source, "export function cueSong(", "\n/** Where a song is:")
    + between(source, "export function togglePlay()", "\n/**\n * Finds the next playable")
    + between(source, "  engine.onError = (id, mediaError)", '\n\n  registerMediaActions();');
  const box = evaluate(selected, {
    getState: () => state, setState: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    engine, positionOf: () => engine.position ?? 0, failedInRow: new Set(), finishListening() {}, updateMediaSession() {}, saveListening() {}, startListening() {},
    streamReady: () => ready, fetchStream: () => streams.shift().promise, streamUrls: new Map(),
    effectiveRange: () => ({ start: 0, end: 100 }), engineTrack: (id) => ({ id }), prefetchNext() {},
    toast: (...args) => { notices.push(args); }, listenLocked: () => false, isPlayable: (track) => Boolean(track),
    advance() { throw new Error("Unexpected stale-error advance"); }, shuffled: (ids) => ids,
    collector: { listen: null }, isNativeApp: true, mediaUrlOf: () => "/api/device-files/srv_a", deviceUrl: () => "/api/device-files/srv_a",
    rebuildDeviceUrl: () => recovery.promise, retryDeviceRemovals() {},
  }, "load, togglePlay, cueSong");
  return { api: box.api, engine, loads, notices, get state() { return state; }, setWaiting: () => { state = { ...state, buffering: state.currentId }; }, setReady: () => { ready = true; }, recovery };
}

test("pausing loaded media during startup clears its waiting indicator", () => {
  const h = actionHarness();
  h.setReady();
  h.api.load("srv_a");
  h.setWaiting();
  h.api.togglePlay();
  assert.equal(h.state.isPlaying, false);
  assert.equal(h.state.buffering, null);
});

test("video takeover shares pending activation and completes startup verification", async () => {
  const activation = deferred();
  let activations = 0;
  const h = engineHarness({ activate: () => { activations++; return activation.promise; } });
  h.load();
  await settle();
  h.engine.swap({ id: "a", fileUrl: "/a-video.mp4", video: true });
  h.elements[1].listeners.get("playing")();
  activation.resolve();
  await settle();
  assert.equal(activations, 1);
  assert.deepEqual(h.started, ["a"]);
});

test("activation failure after video takeover is reported by the new voice", async () => {
  const activation = deferred();
  const h = engineHarness({ activate: () => activation.promise });
  h.load();
  await settle();
  h.engine.swap({ id: "a", fileUrl: "/a-video.mp4", video: true });
  h.elements[1].listeners.get("playing")();
  activation.reject(new Error("session unavailable"));
  await settle();
  assert.deepEqual(h.blocked, ["a"]);
  assert.deepEqual(h.started, []);
});

test("canceled stream completion cannot override a newer request for the same id", async () => {
  const old = deferred(), next = deferred();
  const h = actionHarness({ streams: [old, next] });
  h.api.load("srv_a");
  h.api.togglePlay();
  assert.equal(h.state.isPlaying, false);
  h.api.load("srv_a");
  old.reject(new Error("obsolete source failure"));
  await settle();
  assert.equal(h.state.isPlaying, true);
  assert.equal(h.state.buffering, "srv_a");
  assert.equal(h.notices.length, 0);
  h.setReady();
  next.resolve();
  await settle();
  assert.equal(h.loads.length, 1);
  assert.equal(h.loads[0].options.autoplay, true);
});

test("pause during device-file rebuild cancels its automatic restart", async () => {
  const h = actionHarness();
  h.setReady();
  h.api.load("srv_a");
  h.engine.onError("srv_a", { code: 4 });
  assert.equal(h.state.buffering, "srv_a");
  h.api.togglePlay();
  h.recovery.resolve(true);
  await settle();
  assert.equal(h.state.isPlaying, false);
  assert.equal(h.state.buffering, null);
  assert.equal(h.loads.length, 1, "only the original load ran");
});

test("background saves queue/position and two reloads retain a manually queued current song", () => {
  const stored = new Map();
  const localStorage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  const ids = ["srv_a", "srv_b", "srv_q", "srv_next"];
  const tracks = Object.fromEntries(ids.map((id) => [id, { id }]));
  let state = { currentId: "srv_q", isPlaying: true, tracks, listen: { mode: "idle" }, order: ["srv_a", "srv_b"], index: 0, upNext: ["srv_next"], context: { label: "Shuffled", ids: ["srv_b", "srv_a"] } };
  let position = 47;
  let flushes = 0;
  function session() {
    const events = new Map();
    const document = { visibilityState: "visible", addEventListener: (name, cb) => events.set(name, cb) };
    const actionSource = "let cued=null, playbackLoadGeneration=0, playbackRequestGeneration=0, pendingStream=null, pendingDeviceRecovery=null;\n"
      + between(read("state/actions.ts"), "export function cueSong(", "\n/**\n * Brings the queue");
    const bindings = {
      engine: { loadedTrackId: "srv_q", get position() { return position; } },
      localStorage, crypto: { randomUUID: () => "test-device" }, getState: () => state,
      setState: (patch) => { state = { ...state, ...patch }; }, listenLocked: () => false,
      isPlayable: (track) => Boolean(track), finishListening() {}, updateMediaSession() {}, shuffled: (values) => values,
      positionOf: () => position, flushPersist: () => flushes++, subscribe() {}, toast() {}, document,
      window: { setInterval() {}, addEventListener: (name, cb) => events.set(name, cb) },
    };
    const box = evaluate(actionSource + read("state/resume.ts"), bindings, "watchPlaybackSpot, restorePlaybackSpot, playbackSpot");
    box.api.watchPlaybackSpot();
    return { ...box.api, hide() { document.visibilityState = "hidden"; events.get("visibilitychange")(); } };
  }
  const original = session();
  original.hide();
  assert.equal(flushes, 1);
  for (let reload = 0; reload < 2; reload++) {
    state = { ...state, currentId: null, isPlaying: false, order: [], index: -1, upNext: [], context: null };
    const reopened = session();
    reopened.restorePlaybackSpot();
    assert.equal(state.currentId, "srv_q");
    assert.equal(state.isPlaying, false);
    assert.deepEqual(Array.from(state.order), ["srv_a", "srv_b"]);
    assert.equal(state.index, 0);
    assert.deepEqual(Array.from(state.upNext), ["srv_next"]);
    assert.equal(reopened.playbackSpot().position, 47);
    // Closing a merely restored session must preserve the saved spot unchanged.
    position = 0;
    reopened.hide();
  }
});

test("native HEAD 500 without backup stays unknown; HEAD 404 plus cache miss is missing", async () => {
  const checked = [];
  const box = evaluate(read("state/device.ts"), {
    isNativeApp: true, location: { origin: "https://slopify.test" }, URL, AbortSignal,
    window: { caches: true }, caches: { open: async () => ({ match: async (url) => { checked.push(url); return undefined; } }) },
    fetch: async (url) => ({ ok: false, status: url.endsWith("srv_transient") ? 500 : 404 }),
  }, "restoreDeviceFiles");
  const result = await box.api.restoreDeviceFiles(["srv_transient", "srv_missing"]);
  assert.deepEqual(Array.from(result.kept), []);
  assert.deepEqual(Array.from(result.missing), ["srv_missing"]);
  assert.equal(checked.length, 2);
});

test("quick pause/play toggles fade instead of stopping and restarting the media", async () => {
  const h = engineHarness();
  h.load();
  await settle();
  const audio = h.elements[0];
  assert.equal(audio.paused, false);
  for (let i = 0; i < 5; i++) {
    h.engine.pause();
    h.engine.play();
  }
  await settle();
  for (const { fn, delay } of [...h.timers.values()]) if (delay === 60) fn();
  assert.equal(audio.pauseCalls, 0, "the element never stopped during rapid toggles");
  assert.equal(audio.paused, false);
  h.engine.pause();
  const pending = [...h.timers.entries()].filter(([, t]) => t.delay === 60);
  assert.equal(pending.length, 1, "one deferred stop after the fade");
  pending[0][1].fn();
  assert.equal(audio.pauseCalls, 1);
  assert.equal(audio.paused, true);
});

// iPhone triage regressions: only media, bridge and storage boundaries are faked.
function iphoneActions({ streams = [], recovery = deferred(), native = false, playbackEngine, browser = {} } = {}) {
  const mediaHandlers = new Map(), events = new Map(), timers = new Map();
  const notices = [], loads = [], seeks = [], ready = new Set();
  let nextTimer = 0, fetches = 0, unloads = 0;
  let state = {
    currentId: null, isPlaying: false, buffering: null, history: [], listens: [], speed: 1,
    tracks: Object.fromEntries(["a", "b", "c"].map((id) => [id, { id, title: id, duration: 100, plays: 0 }])),
    artists: {}, albums: {}, order: ["a", "b", "c"], index: 0, upNext: [], repeat: "all",
    listen: { mode: "idle" }, settings: { autoplay: false }, context: null,
  };
  const engine = playbackEngine ?? {
    loadedTrackId: null, position: 0, playing: false, crossfadeSeconds: 6,
    setVolume() {}, setRate() {}, captureProgress() {},
    unload() { unloads++; this.loadedTrackId = null; this.playing = false; this.position = 0; },
    load(track, options) { loads.push({ track, options }); this.loadedTrackId = track.id; this.position = options.position ?? options.start; this.playing = options.autoplay; },
    seek(p) { seeks.push(p); this.position = p; },
    pause() { this.playing = false; }, play() { this.playing = true; },
    resumeAfterInterruption() { this.resumes = (this.resumes ?? 0) + 1; },
  };
  const source = read("state/actions.ts");
  const requestStart = source.indexOf("export function beginPlaybackRequest(");
  const requestCode = requestStart < 0 ? "" : between(source, "export function beginPlaybackRequest(", "/** Songs that failed");
  const selected = "let pendingStream=null, pendingDeviceRecovery=null, playbackLoadGeneration=0, playbackRequestGeneration=0, slippedIn=null, slipHooks=null, previewing=false, cued=null, retriedError=null, lastListenSave=0, radioHooks=null; const rebuiltDeviceSongs=new Set(), failedInRow=new Set();\n"
    + requestCode
    + between(source, "function load(id:", "\n/** Starts playing `ids`")
    + between(source, "export function cueSong(", "\n/**\n * Brings the queue")
    + between(source, "export function togglePlay()", "\nexport function nextTrackId()")
    + between(source, "export function seek(", "\nexport function jumpToOrderIndex(")
    + between(source, "function stopAtEnd(", "\nexport function next()")
    + between(source, "export function followHost(", "\n// Live audio and app state");
  const later = (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; };
  const box = evaluate(selected, {
    getState: () => state, setState: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    engine, finishListening() {}, saveListening() {}, startListening() {},
    streamReady: (id) => ready.has(id), fetchStream: () => { fetches++; return streams.shift().promise; }, streamUrls: new Map(),
    effectiveRange: (id) => state.tracks[id]?.clip ?? { start: 0, end: 100 }, engineTrack: (id) => ({ id, fileUrl: `/${id}.m4a` }), prefetchNext() {},
    toast: (...args) => { notices.push(args); }, listenLocked: () => false, isPlayable: Boolean, snoozedUntil: () => false, shuffled: (ids) => ids,
    collector: { listen: null, sample() {}, resetAnchor() {} }, isNativeApp: native, mediaUrlOf: () => "/device", deviceUrl: () => "/device",
    rebuildDeviceUrl: () => recovery.promise, retryDeviceRemovals() {}, applyEngineSettings() {}, setSpeed(rate) { state.speed = rate; },
    document: { visibilityState: "visible", addEventListener: (name, cb) => events.set(name, cb) },
    window: { setTimeout: later, setInterval: later, addEventListener: (name, cb) => events.set(name, cb) },
    setTimeout: later, clearTimeout: (id) => timers.delete(id),
    navigator: { mediaSession: { registrations: 0, setActionHandler(name, cb) { this.registrations++; mediaHandlers.set(name, cb); }, setPositionState(value) { this.position = value; } } },
    location: { href: "http://127.0.0.1:5198/" }, URL,
    wakeLive() {}, MediaMetadata: class { constructor(data) { Object.assign(this, data); } },
    ...(requestStart < 0 ? { beginPlaybackRequest: () => () => true } : {}),
    ...browser,
  }, "load, togglePlay, cueSong, followHost, wireEngine, updatePositionState, positionOf, seek, stopAtEnd, beginPlaybackRequest");
  box.api.wireEngine();
  return { ...box.api, engine, loads, seeks, ready, notices, events, timers, mediaHandlers, recovery,
    get state() { return state; }, get unloads() { return unloads; }, get fetches() { return fetches; },
    patch(patch) { state = { ...state, ...patch }; },
    runTimers(delay) { for (const [id, t] of [...timers]) if (t.delay === delay) { timers.delete(id); t.fn(); } },
    positionState: () => box.navigator.mediaSession.position,
    mediaSession: () => box.navigator.mediaSession,
  };
}

test("P1: interrupted graph reconciles state and explicit lock-screen Play resumes while hidden", async () => {
  const h = engineHarness();
  const a = iphoneActions({ playbackEngine: h.engine }); a.load("a"); await settle();
  h.document.visibilityState = "hidden";
  h.contexts[0].state = "interrupted";
  h.contexts[0].emit("statechange");
  assert.equal(a.state.isPlaying, false);
  assert.equal(h.engine.playing, false);
  a.mediaHandlers.get("play")();
  assert.equal(a.state.isPlaying, true);
  await settle();
  assert.equal(h.engine.playing, true);
  assert.equal(h.contexts[0].state, "running");
});

test("P1: explicit media-session Play also repairs stale playing intent", () => {
  const h = iphoneActions(); h.load("a");
  h.engine.playing = false;
  h.mediaHandlers.get("play")();
  assert.equal(h.engine.playing, true);
  assert.equal(h.state.isPlaying, true);
});

test("P2: skip during native crossfade silences the older tail", async () => {
  const h = engineHarness(); h.load(); await settle();
  h.load("b", { crossfade: 6 }); await settle();
  assert.equal(h.engine.retiring.size, 1);
  h.load("c"); await settle();
  assert.equal(h.engine.retiring.size, 0);
  for (const { fn, delay } of [...h.timers.values()]) if (delay <= 300) fn();
  assert.equal(h.elements[0].paused, true);
  assert.equal(h.elements[1].paused, false);
});

test("P3: unready crossfade preserves outgoing audio and its overlap option", async () => {
  const stream = deferred(), h = iphoneActions({ streams: [stream] });
  h.load("a");
  h.patch({ tracks: { ...h.state.tracks, b: { ...h.state.tracks.b, stream: true } } });
  h.load("b", { crossfade: 6 });
  assert.equal(h.unloads, 0);
  assert.equal(h.engine.loadedTrackId, "a");
  assert.equal(h.engine.playing, true);
  h.ready.add("b"); stream.resolve(); await settle();
  assert.equal(h.loads.at(-1).options.crossfade, 6);
});

test("P3: outgoing EOF cannot advance past an unready crossfade target", () => {
  const h = iphoneActions({ streams: [deferred()] }); h.load("a");
  h.patch({ tracks: { ...h.state.tracks, b: { ...h.state.tracks.b, stream: true } } });
  h.engine.onNearEnd();
  h.ready.add("c"); h.engine.onEnded();
  assert.equal(h.state.currentId, "b");
  assert.equal(h.loads.length, 1);
});

test("P3: pause cancels outgoing audio while a crossfade target is fetching", () => {
  const h = iphoneActions({ streams: [deferred()] }); h.load("a");
  h.patch({ tracks: { ...h.state.tracks, b: { ...h.state.tracks.b, stream: true } } });
  h.load("b", { crossfade: 6 }); h.togglePlay();
  assert.equal(h.engine.playing, false);
  assert.equal(h.state.isPlaying, false);
});

test("P4: failed streams stop after one Repeat All lap", async () => {
  const failures = Array.from({ length: 4 }, deferred);
  const h = iphoneActions({ streams: [...failures] });
  h.patch({ tracks: { a: { id: "a", title: "a", stream: true }, b: { id: "b", title: "b", stream: true } }, order: ["a", "b"] });
  h.load("a");
  failures[0].reject(new Error("offline")); await settle();
  failures[1].reject(new Error("offline")); await settle();
  assert.equal(h.fetches, 2);
  assert.equal(h.state.isPlaying, false);
  assert.equal(h.state.buffering, null);
});

test("P5: device-file recovery preserves failed playback position", async () => {
  const h = iphoneActions({ native: true }); h.load("a"); h.engine.position = 47;
  h.engine.onError("a", { code: 4 });
  h.recovery.resolve(true); await settle();
  assert.equal(h.engine.position, 47);
  assert.equal(h.state.isPlaying, true);
});

test("P6: preview stop pauses media before rewinding to the clip opening", async () => {
  const h = engineHarness(); h.load("a", { start: 20, end: 30 }); await settle();
  h.elements[0].currentTime = 30;
  const seek = h.engine.seek.bind(h.engine);
  h.engine.seek = (position) => { assert.equal(h.elements[0].paused, true, "no playing seek under the pause fade"); seek(position); };
  const source = between(read("state/actions.ts"), "function stopAtEnd(", "\nfunction advance(");
  const box = evaluate(source, { engine: h.engine, effectiveRange: () => ({ start: 20 }), setState() {}, updateMediaSession() {} }, "stopAtEnd");
  box.api.stopAtEnd({ currentId: "a" });
  assert.equal(h.elements[0].currentTime, 20);
});

test("P7: both host load branches start from host position, including updated pending streams", async () => {
  for (const same of [false, true]) {
    const h = iphoneActions();
    if (same) h.patch({ currentId: "a" });
    h.followHost("a", 47, true, "Room");
    assert.equal(h.engine.position, 47);
  }
  const stream = deferred(), h = iphoneActions({ streams: [stream] });
  h.patch({ tracks: { ...h.state.tracks, a: { ...h.state.tracks.a, stream: true } } });
  h.followHost("a", 47, true, "Room"); h.followHost("a", 53, false, "Room");
  h.ready.add("a"); stream.resolve(); await settle();
  assert.equal(h.engine.position, 53);
  assert.equal(h.state.isPlaying, false);
});

test("P8: mid-song waiting/stalled events show delayed buffering and playing clears it", async () => {
  const h = engineHarness(), a = iphoneActions({ playbackEngine: h.engine });
  a.load("a"); await settle();
  for (const event of ["waiting", "stalled"]) {
    h.elements[0].emit(event); a.runTimers(400);
    assert.equal(a.state.buffering, "a");
    h.elements[0].emit("playing");
    assert.equal(a.state.buffering, null);
  }
});

test("P9: lock-screen position uses cued song instead of previously loaded voice", () => {
  const h = iphoneActions(); h.load("a"); h.togglePlay(); h.engine.position = 80;
  h.cueSong("b", 37, { ids: ["b"], label: "Restored" });
  assert.equal(h.positionState().position, 37);
});

test("P11: external headphone-disconnect pause stays paused after foreground", async () => {
  const h = engineHarness(), a = iphoneActions({ playbackEngine: h.engine }); a.load("a"); await settle();
  h.document.visibilityState = "hidden";
  h.elements[0].paused = true; h.elements[0].emit("pause");
  assert.equal(a.state.isPlaying, false);
  h.document.visibilityState = "visible"; h.engine.resumeAfterInterruption();
  assert.equal(h.elements[0].playCalls, 1);
  assert.equal(h.engine.playing, false);
});

test("P11: foreground catches external pause even when the pause event was deferred", async () => {
  const h = engineHarness(); h.load(); await settle();
  h.elements[0].paused = true;
  h.engine.resumeAfterInterruption(); await settle();
  assert.equal(h.elements[0].playCalls, 1);
  assert.equal(h.engine.playing, false);
});

test("P12: resolving a song cannot supersede a newer playback request", async () => {
  const h = iphoneActions(), found = deferred(), played = [];
  const source = between(read("views/Song.tsx"), "  const play = async () =>", "\n  const radio = async () =>");
  const box = evaluate(source, {
    current: false, togglePlay: h.togglePlay, playable: () => found.promise,
    beginPlaybackRequest: h.beginPlaybackRequest,
    playList: (...args) => played.push(args), title: "Old song", route: {},
  }, "play");
  const pending = box.api.play();
  h.load("b"); found.resolve("a"); await pending;
  assert.equal(played.length, 0);
});

for (const queueEdit of [false, true]) test(`P10: ${queueEdit ? "queue edits and scrub" : "scrub alone"} after restore survive two paused reloads`, () => {
  const stored = new Map();
  const storage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  stored.set("slopify.playback-spot.v1", JSON.stringify({ id: "srv_a", position: 47, at: 1, device: "other", ids: ["srv_a", "srv_b"], order: ["srv_a", "srv_b"], index: 0, upNext: [] }));
  let state, position;
  function session() {
    state = { currentId: null, isPlaying: false, tracks: { srv_a: {}, srv_b: {} }, listen: { mode: "idle" }, order: [], index: -1, upNext: [] };
    const events = new Map(), listeners = [];
    const patch = (p) => { state = { ...state, ...p }; listeners.forEach((fn) => fn()); };
    const document = { visibilityState: "visible", addEventListener: (key, fn) => events.set(key, fn) };
    const box = evaluate(read("state/resume.ts"), {
      localStorage: storage, crypto: { randomUUID: () => "local" }, getState: () => state,
      positionOf: () => position, subscribe: (fn) => listeners.push(fn), flushPersist() {}, toast() {}, document,
      window: { setInterval() {}, addEventListener: (key, fn) => events.set(key, fn) },
      cueSong(id, p, context) { position = p; patch({ currentId: id, context, order: context.order, index: context.index, upNext: context.upNext }); return true; },
    }, "restorePlaybackSpot, watchPlaybackSpot, playbackSpot");
    box.api.watchPlaybackSpot(); box.api.restorePlaybackSpot();
    return { ...box.api, patch, hide() { document.visibilityState = "hidden"; events.get("visibilitychange")(); } };
  }
  const first = session();
  if (queueEdit) first.patch({ upNext: ["srv_b"] });
  position = 63; first.hide();
  for (let i = 0; i < 2; i++) {
    const reopened = session();
    assert.equal(position, 63);
    assert.deepEqual(Array.from(state.upNext), queueEdit ? ["srv_b"] : []);
    reopened.hide();
  }
});

test("P1/P11: internal pause and retired voice events do not interrupt a new song", async () => {
  const h = engineHarness(), interrupted = [];
  h.engine.onInterrupted = (id) => interrupted.push(id);
  h.load(); await settle();
  h.engine.pause(); h.elements[0].emit("pause"); h.engine.play(); await settle();
  h.load("b", { crossfade: 6 }); await settle();
  h.elements[0].paused = true; h.elements[0].emit("pause"); h.elements[0].emit("waiting");
  assert.deepEqual(interrupted, []);
  assert.equal(h.engine.playing, true);
});

test("P7: initial host playhead preserves the clip's looping boundary", async () => {
  const h = engineHarness(); h.load("a", { start: 20, end: 80, position: 47 }); await settle();
  assert.equal(h.engine.position, 47);
  h.engine.seek(0);
  assert.equal(h.engine.position, 20);
});

test("P12: latest async song intent remains valid until another playback intent", () => {
  const h = iphoneActions();
  const old = h.beginPlaybackRequest(), latest = h.beginPlaybackRequest();
  assert.equal(old(), false);
  assert.equal(latest(), true);
  h.load("b");
  assert.equal(latest(), false);
});

test("P11 review: deferred route pause at clip boundary cannot autoplay the next song", async () => {
  const h = engineHarness(), a = iphoneActions({ playbackEngine: h.engine });
  a.load("a"); await settle();
  h.elements[0].currentTime = 99.99;
  h.elements[0].paused = true;
  h.elements[0].ended = false;
  h.engine.resumeAfterInterruption(); await settle();
  assert.equal(a.state.currentId, "a");
  assert.equal(a.state.isPlaying, false);
  assert.equal(h.elements[0].playCalls, 1);
});

test("P3 review: scrubbing pending crossfade targets its new song and leaves outgoing audio alone", async () => {
  const stream = deferred(), h = iphoneActions({ streams: [stream] });
  h.load("a"); h.engine.position = 94;
  h.patch({ tracks: { ...h.state.tracks, b: { ...h.state.tracks.b, stream: true } } });
  h.engine.onNearEnd();
  h.seek(40);
  assert.equal(h.engine.position, 94);
  assert.equal(h.positionOf("b"), 40);
  assert.equal(h.positionState().position, 40);
  h.ready.add("b"); stream.resolve(); await settle();
  assert.equal(h.engine.loadedTrackId, "b");
  assert.equal(h.engine.position, 40);
});

test("a graph interruption during the native start handshake doesn't cancel that start", async () => {
  const activation = deferred();
  const h = engineHarness({ activate: () => activation.promise });
  h.load();
  // Activating the native session briefly interrupts WebKit's graph before the start task checks it.
  const ctx = h.contexts[0];
  ctx.state = "interrupted";
  ctx.emit("statechange");
  activation.resolve();
  await settle();
  await settle();
  assert.deepEqual(h.started, ["a"], "the start completes once the graph resumes");
  assert.equal(h.engine.playing, true);
});

test("lock screen gets the song's cover and its next/previous controls again once a song plays", () => {
  const h = iphoneActions();
  h.patch({ tracks: { ...h.state.tracks, a: { ...h.state.tracks.a, albumId: "al" } }, albums: { al: { id: "al", title: "Album", artworkUrl: "/api/art/al.jpg" } } });
  const atStartup = h.mediaSession().registrations;
  h.load("a"); h.togglePlay();
  const session = h.mediaSession();
  assert.deepEqual(Array.from(session.metadata.artwork, (image) => image.src), ["http://127.0.0.1:5198/api/art/al.jpg"]);
  assert.ok(session.registrations > atStartup, "handlers are set again for the song that's playing");
  assert.equal(typeof h.mediaHandlers.get("nexttrack"), "function");
});

test("lock screen gets the app's cover drawn square, since iOS fetches artwork without the session cookie", async () => {
  const requests = [], drawn = [];
  const canvas = { getContext: () => ({ drawImage: (...args) => drawn.push(args.slice(1)) }), toDataURL: (type) => `data:${type};base64,COVER` };
  const h = iphoneActions({ browser: {
    fetch: async (url, init) => { requests.push([url, init.credentials]); return { ok: true, blob: async () => "bytes" }; },
    createImageBitmap: async () => ({ width: 640, height: 360, close() {} }),
    document: { visibilityState: "visible", addEventListener() {}, createElement: () => canvas },
    location: { href: "http://127.0.0.1:5198/", origin: "http://127.0.0.1:5198" },
  } });
  h.patch({ tracks: { ...h.state.tracks, a: { ...h.state.tracks.a, albumId: "al" } }, albums: { al: { id: "al", title: "Album", artworkUrl: "/api/artwork/a" } } });
  h.load("a"); h.togglePlay();
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(requests, [["http://127.0.0.1:5198/api/artwork/a", "include"]], "the page fetches its own cover once, with its cookie");
  assert.deepEqual(drawn, [[140, 0, 360, 360, 0, 0, 512, 512]], "a wide thumbnail is cropped to its middle square");
  assert.deepEqual(Array.from(h.mediaSession().metadata.artwork, (image) => image.src), ["data:image/jpeg;base64,COVER"], "the drawn cover replaces the address without waiting for the next play or pause");
});
