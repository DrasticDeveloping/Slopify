import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';
const root = process.env.SLOPIFY_TEST_ROOT ? pathToFileURL(`${resolve(process.env.SLOPIFY_TEST_ROOT)}/`) : new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
const importsRemoved = (s) => s.replace(/^import\s[\s\S]*?\sfrom\s["'][^"']+["'];\s*$/gm, '').replace(/^export /gm, '');
const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: 'fragment' };
function dom(tree) {
  if (!tree) return [];
  if (Array.isArray(tree)) return tree.flatMap(dom);
  if (typeof tree !== 'object') return [];
  if (typeof tree.type === 'function') return dom(tree.type(tree.props));
  return [tree, ...dom(tree.props.children)];
}
async function shelfHarness(songs = []) {
  let open;
  class Element {}
  const wrapper = new URL('src/components/RecommendationCard.tsx', root);
  const source = (fs.existsSync(wrapper) ? importsRemoved(fs.readFileSync(wrapper, 'utf8')) : '') + '\n' + importsRemoved(read('src/components/DiscoveryShelf.tsx'));
  const { code } = await transformWithOxc(source, 'DiscoveryShelf.tsx', { jsx: { runtime: 'classic' } });
  const box = vm.createContext({
    React, HTMLElement: Element, useEffect() {}, useMemo: (fn) => fn(),
    useStore: (fn) => fn({ tracks: {}, isPlaying: false }),
    useDiscovery: () => ({ songs, hasResults: true, loading: false, note: '', refresh() {} }),
    useLongPress: (fn) => ({ onTouchStart: (e) => fn(e.currentTarget) }),
    registerStreams() {}, streamTrackId: (key) => key, canStream: () => false,
    Shelf: ({ children, action }) => React.createElement('section', {}, action, children),
    Art: () => null, TrackArt: () => null, Icon: () => null, SkeletonCards: () => null,
    hashString: () => 1, paletteFromSeed: () => ({}), artistName: (name) => name,
    menuPosition: () => ({}), openMenu: (menu) => { open = menu; },
  });
  vm.runInContext(`${code}\nglobalThis.api={DiscoveryShelf}`, box);
  return { render: (props) => dom(box.api.DiscoveryShelf(props)), element: new Element(), get menu() { return open; } };
}
test('SR7: library recommendation menu offers Not interested first and preserves its reason', () => {
  let dismissed;
  const source = importsRemoved(read('src/lib/menus.ts').split('export function openTrackMenu')[0]);
  const box = vm.createContext({
    getState: () => ({tracks:{t1:{id:'t1',title:'Song',storage:'files'}},artists:{},albums:{},playlists:[]}),
    isPlayable: () => true, isLiked: () => false, isSlipIn: () => false, snoozeItem: () => null,
    hideRecommendation: (id, why) => { dismissed = { id, why }; },
  });
  vm.runInContext(`${stripTypeScriptTypes(source)}\nglobalThis.api={trackMenu}`, box);
  const items = box.api.trackMenu(['t1'], { why:'discover-search' });
  assert.equal(items[0].label, 'Not interested');
  items[0].run();
  assert.deepEqual(dismissed, {id:'t1',why:'discover-search'});
});
test('SR8: dismissing all cached suggestions retains Find more', async () => {
  const h = await shelfHarness();
  const nodes = h.render({ hideWhenEmpty:true });
  assert.ok(nodes.some((n) => n.type === 'button' && n.props.children.includes('Find more')));
});
test('SR9: recommendation exposes a named menu action alongside long press', async () => {
  const h = await shelfHarness([{key:'artist|song',title:'Song',artist:'Artist',kind:'discover-search',candidate:{}}]);
  const nodes = h.render({});
  const button = nodes.find((n) => n.type === 'button' && n.props['aria-label'] === 'More options for Song');
  assert.ok(button, 'Accessible menu button is rendered');
  button.props.onClick({currentTarget:h.element});
  assert.equal(h.menu.items[0].label, 'Not interested');
  assert.ok(nodes.find((n) => n.props.className?.includes('rec-card')).props.onTouchStart, 'Long press remains available');
});
