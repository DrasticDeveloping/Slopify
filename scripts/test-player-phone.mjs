// Evaluate the production player components, replacing only React hooks and the playback boundary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';

const source = fs.readFileSync(new URL('../src/components/PlayerBar.tsx', import.meta.url), 'utf8');
const part = (from, to) => {
  const start = source.indexOf(from);
  const end = to ? source.indexOf(to, start + from.length) : source.length;
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end).replace(/^export /gm, '');
};
const jsx = (type, props, key) => ({ type, props, key });
const compiled = await transformWithOxc(`${part('export function SeekRow', 'export function VolumeControl')}
${part('function MiniProgress')}
globalThis.components = { SeekRow, MiniProgress };`, 'player-phone.tsx');

function harness({ start = 0, end = 200, position = 0 } = {}) {
  const state = { currentId: 'first', listen: { mode: 'idle' } };
  const seeks = [];
  const frames = [];
  const element = { style: {} };
  const Slider = () => {};
  const box = vm.createContext({
    require: () => ({ jsx, jsxs: jsx }),
    useCurrent: () => ({ track: { id: state.currentId, duration: 200 }, range: { start, end } }),
    useStore: fn => fn(state), getState: () => state,
    useLiveText: () => ({}), useCallback: fn => fn,
    useRef: () => ({ current: element }), useEffect: fn => fn(),
    onLiveFrame: fn => { frames.push(fn); return () => {}; },
    formatTime: String, pollPosition: () => position, positionOf: () => position,
    seek: value => seeks.push({ id: state.currentId, value }), Slider,
  });
  vm.runInContext(compiled.code, box);
  const findSlider = node => {
    if (!node || typeof node !== 'object') return undefined;
    if (node.type === Slider) return node;
    for (const child of [node.props?.children].flat(Infinity)) {
      const result = findSlider(child);
      if (result) return result;
    }
  };
  return { state, seeks, element, frames, ...box.components, slider: () => findSlider(box.components.SeekRow({})) };
}

test('a seek held across a song change cannot seek the next song', () => {
  const h = harness();
  const held = h.slider();
  h.state.currentId = 'second';
  held.props.onCommit(150);
  assert.equal(h.seeks.length, 0);
  h.slider().props.onCommit(40);
  assert.deepEqual(h.seeks, [{ id: 'second', value: 40 }]);
});

test('seek slider identity changes with its song, cancelling pointer capture', () => {
  const h = harness();
  const first = h.slider();
  h.state.currentId = 'second';
  assert.notEqual(h.slider().key, first.key);
});

test('mini player progress uses the clipped interval and clamps its boundaries', () => {
  for (const [position, expected] of [[0, 0], [60, 0], [110, .5], [160, 1], [200, 1]]) {
    const h = harness({ start: 60, end: 160, position });
    h.MiniProgress();
    h.frames.forEach(fn => fn());
    assert.equal(h.element.style.transform, `scaleX(${expected})`, `position ${position}`);
  }
});
