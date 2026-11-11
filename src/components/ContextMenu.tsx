import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useCoverPalette } from "../lib/art-colors";
import { useMediaQuery } from "../lib/hooks";
import { closeMenu, takeMenuOpener } from "../state/actions";
import { useStore, type MenuArt, type MenuItem } from "../state/store";
import { BlurredTrackArt, PlaylistArt, TrackArt } from "./Artwork";
import { Icon } from "./Icon";

/** The cover at the top of a menu, so it's clear at a glance what the menu acts on (as Spotify's and Apple Music's do). */
function MenuArtView({ art }: { art: MenuArt }) {
  const playlist = useStore((s) => (art.playlistId ? s.playlists.find((p) => p.id === art.playlistId) : undefined));
  if (art.trackId) return <TrackArt trackId={art.trackId} className="menu-art" />;
  if (playlist) return <PlaylistArt playlist={playlist} className="menu-art" />;
  if (art.image) return <span className={`menu-art menu-art-img${art.round ? " round" : ""}`}><img src={art.image} alt="" referrerPolicy="no-referrer" /></span>;
  if (art.initial) return <span className={`menu-art menu-art-initial${art.round ? " round" : ""}`}>{art.initial}</span>;
  if (art.icon) return <span className={`menu-art menu-art-icon${art.round ? " round" : ""}`}><Icon name={art.icon} size={20} /></span>;
  return null;
}

/** The song whose cover stands for what the menu is about: the song itself, or a playlist's first song with a cover. */
function useMenuCoverTrack(art: MenuArt | undefined) {
  return useStore((s) => {
    if (art?.trackId) return s.tracks[art.trackId] ? art.trackId : undefined;
    const playlist = art?.playlistId && art.playlistId !== "liked" ? s.playlists.find((p) => p.id === art.playlistId) : undefined;
    return playlist?.trackIds.find((id) => s.albums[s.tracks[id]?.albumId]?.artworkUrl);
  });
}

/** The colour of what the menu is about, washed across its top: read from the cover itself, as the Dynamic theme
 *  does (its generated colours when it has none); the theme's accent for anything without a cover. */
function useMenuTint(art: MenuArt | undefined, coverTrack: string | undefined) {
  const url = useStore((s) => (coverTrack ? s.albums[s.tracks[coverTrack]?.albumId]?.artworkUrl : undefined));
  const generated = useStore((s) => {
    if (coverTrack) return s.albums[s.tracks[coverTrack]?.albumId]?.palette.b;
    if (art?.trackId) return s.albums[s.tracks[art.trackId]?.albumId]?.palette.b;
    if (art?.playlistId) return s.playlists.find((p) => p.id === art.playlistId)?.palette.b;
    return undefined;
  });
  const cover = useCoverPalette(url, undefined);
  return cover?.a ?? generated;
}

/** Splits off the quick actions (a row of tiles across the top), tidying the separators the rest is left with. */
function splitQuick(items: MenuItem[], sub?: boolean) {
  const quick = sub ? [] : items.filter((item) => item.quick && !item.separator && !item.submenu);
  if (quick.length < 2) return { quick: [] as MenuItem[], list: items };
  const list: MenuItem[] = [];
  for (const item of items) {
    if (quick.includes(item)) continue;
    if (item.separator && (!list.length || list[list.length - 1].separator)) continue;
    list.push(item);
  }
  while (list.length && list[list.length - 1].separator) list.pop();
  return { quick, list };
}

function MenuList({ items, x, y, flipX, title, subtitle, art, onDone, sub, sheet, plain }: { items: MenuItem[]; x: number; y: number; flipX?: number; title?: string; subtitle?: string; art?: MenuArt; onDone: () => void; sub?: boolean; sheet?: boolean; plain?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false, origin: "top left" });
  const coverTrack = useMenuCoverTrack(sub ? undefined : art);
  const tint = useMenuTint(sub ? undefined : art, coverTrack);
  const { quick, list } = splitQuick(items, sub);
  // Under a coloured header the rest of the menu is plain black, so the cover's colour is the only one in it;
  // its submenus match it.
  const isPlain = plain || !!art || quick.length > 0;
  const [openSub, setOpenSub] = useState<{ index: number; x: number; y: number; flipX: number } | null>(null);
  /** The item to focus once its submenu has closed (in a sheet the menu is hidden until then). */
  const [returnTo, setReturnTo] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (returnTo === null || openSub) return;
    // Indexes count separators too, so the item is found by its place among all the list's children.
    (ref.current?.querySelector(":scope > .menu-items")?.children[returnTo] as HTMLElement | undefined)?.focus();
    setReturnTo(null);
  }, [returnTo, openSub]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (sheet) {
      setPos({ left: 0, top: 0, ready: true, origin: "bottom center" });
      el.querySelector<HTMLButtonElement>(".menu-items button:not(:disabled)")?.focus({ preventScroll: true });
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 10;
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - pad) left = sub && flipX !== undefined ? flipX - r.width : window.innerWidth - r.width - pad;
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
    left = Math.max(pad, left);
    top = Math.max(pad, top);
    // It grows out of the corner nearest the pointer, so a menu pushed left or up of the click still opens from it.
    setPos({ left, top, ready: true, origin: `${top < y - 4 ? "bottom" : "top"} ${left < x - 4 ? "right" : "left"}` });
    if (!sub) el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y, sub, flipX, sheet]);

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    // The submenu is portalled but React still bubbles its events to the parent menu.
    e.stopPropagation();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>(":scope > .menu-quick > button:not(:disabled), :scope > .menu-items > button:not(:disabled)") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const tiles = [...(ref.current?.querySelectorAll<HTMLButtonElement>(":scope > .menu-quick > button:not(:disabled)") ?? [])];
    const tile = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (tile >= 0 && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      // The quick actions are a row: left and right move along it.
      e.preventDefault();
      tiles[(tile + (e.key === "ArrowRight" ? 1 : -1) + tiles.length) % tiles.length]?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    } else if (e.key === "ArrowRight") {
      const el = document.activeElement as HTMLButtonElement;
      if (el?.dataset.sub) {
        e.preventDefault();
        el.click();
      }
    } else if (e.key === "ArrowLeft" && sub) {
      e.preventDefault();
      e.stopPropagation();
      onDone();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (sub) onDone();
      else closeMenu();
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  };

  return (
    <div
      ref={ref}
      className={`menu${pos.ready ? " ready" : ""}${sub ? " sub" : ""}${sheet ? " sheet" : ""}${art ? " has-art" : ""}${quick.length ? " has-quick" : ""}${isPlain ? " plain" : ""}${sheet && openSub ? " covered" : ""}`}
      style={{ ...(sheet ? {} : { left: pos.left, top: pos.top, transformOrigin: pos.origin }), ...(tint ? { "--menu-tint": tint } : {}) } as CSSProperties}
      role="menu"
      aria-label={title}
      onKeyDown={key}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* The cover, blurred, behind the header: the menu takes on the look of what it's about (drawn once, never animated). */}
      {coverTrack ? <BlurredTrackArt trackId={coverTrack} className="menu-backdrop" /> : null}
      {sheet ? <span className="sheet-grip" aria-hidden="true" /> : null}
      {title ? (
        <div className="menu-head">
          {sheet && sub ? (
            <button type="button" className="icon-btn sm menu-back" onClick={onDone} aria-label="Back">
              <Icon name="chevronLeft" size={18} />
            </button>
          ) : art ? <MenuArtView art={art} /> : null}
          <span className="menu-head-text">
            <strong>{title}</strong>
            {subtitle ? <small>{subtitle}</small> : null}
          </span>
        </div>
      ) : null}
      {quick.length ? (
        <div className="menu-quick" style={{ "--tiles": quick.length } as CSSProperties}>
          {quick.map((item, i) => (
            <button
              key={i}
              type="button"
              role={item.on !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={item.on}
              aria-label={item.label}
              className={`menu-tile${item.on ? " on" : ""}`}
              style={{ "--i": i } as CSSProperties}
              disabled={item.disabled}
              onPointerEnter={() => setOpenSub(null)}
              onClick={() => {
                closeMenu();
                item.run?.();
              }}
            >
              <span className="menu-tile-icon"><Icon name={item.icon ?? "play"} size={19} /></span>
              <span className="menu-tile-label">{item.short ?? item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="menu-items">
        {list.map((item, i) =>
          item.separator ? (
            <div key={i} className="menu-sep" role="separator" />
          ) : (
            <button
              key={i}
              type="button"
              role={item.checked !== undefined ? "menuitemradio" : "menuitem"}
              aria-checked={item.checked}
              aria-haspopup={item.submenu ? "menu" : undefined}
              aria-expanded={item.submenu ? openSub?.index === i : undefined}
              data-sub={item.submenu ? "1" : undefined}
              className={`menu-item${item.danger ? " danger" : ""}${item.accent ? " accent" : ""}${openSub?.index === i ? " open" : ""}`}
              style={{ "--i": Math.min(i + quick.length, 14) } as CSSProperties}
              disabled={item.disabled}
              onPointerEnter={(e) => {
                if (sheet) return;
                if (item.submenu) {
                  const r = e.currentTarget.getBoundingClientRect();
                  setOpenSub({ index: i, x: r.right + 4, y: r.top - 6, flipX: r.left - 4 });
                } else setOpenSub(null);
              }}
              onClick={(e) => {
                if (item.submenu) {
                  const r = e.currentTarget.getBoundingClientRect();
                  setOpenSub({ index: i, x: r.right + 4, y: r.top - 6, flipX: r.left - 4 });
                  requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".menu.sub button:not(:disabled)")?.focus());
                  return;
                }
                closeMenu();
                item.run?.();
              }}
            >
              {item.checked !== undefined ? (
                <span className="menu-icon">{item.checked ? <Icon name="check" size={16} /> : null}</span>
              ) : item.icon ? (
                <span className="menu-icon"><Icon name={item.icon} size={17} /></span>
              ) : null}
              <span className="menu-label">{item.label}</span>
              {item.hint ? <kbd className="kbd">{item.hint}</kbd> : null}
              {item.submenu ? <Icon name="chevronRight" size={15} className="menu-caret" /> : null}
            </button>
          ),
        )}
      </div>
      {openSub && list[openSub.index]?.submenu ? createPortal(
        <MenuList
          items={list[openSub.index].submenu!}
          x={openSub.x}
          y={openSub.y}
          flipX={openSub.flipX}
          sub
          sheet={sheet}
          plain={isPlain}
          // A sheet's submenu replaces it on screen, so it says where you are and has a way back.
          title={sheet ? list[openSub.index].label : undefined}
          subtitle={sheet ? title : undefined}
          onDone={() => {
            setReturnTo(openSub.index);
            setOpenSub(null);
          }}
        />,
        ref.current?.parentElement ?? document.body,
      ) : null}
    </div>
  );
}

export function ContextMenu() {
  const menu = useStore((s) => s.menu);
  // On a phone a menu is a sheet from the bottom, within thumb reach, as in Spotify's and Apple Music's apps.
  const sheet = useMediaQuery("(max-width: 680px)");
  const wasOpen = useRef(false);

  // Hand focus back to whatever opened the menu (captured in openMenu, before the
  // menu focused its first item), unless something else, like a dialog, has taken it.
  useLayoutEffect(() => {
    if (menu) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const el = takeMenuOpener();
    const active = document.activeElement;
    if (el?.isConnected && el !== document.body && (!active || active === document.body)) el.focus();
  }, [menu]);

  if (!menu) return null;
  return (
    <div className={`menu-layer${sheet ? " sheet" : ""}`} onPointerDown={(e) => e.target === e.currentTarget && closeMenu()} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }}>
      <MenuList key={`${menu.x},${menu.y},${menu.title}`} items={menu.items} x={menu.x} y={menu.y} title={menu.title} subtitle={menu.subtitle} art={menu.art} sheet={sheet} onDone={closeMenu} />
    </div>
  );
}
