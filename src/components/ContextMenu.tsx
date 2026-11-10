import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "../lib/hooks";
import { closeMenu, takeMenuOpener } from "../state/actions";
import { useStore, type MenuArt, type MenuItem } from "../state/store";
import { PlaylistArt, TrackArt } from "./Artwork";
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

function MenuList({ items, x, y, flipX, title, subtitle, art, onDone, sub, sheet }: { items: MenuItem[]; x: number; y: number; flipX?: number; title?: string; subtitle?: string; art?: MenuArt; onDone: () => void; sub?: boolean; sheet?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
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
      setPos({ left: 0, top: 0, ready: true });
      el.querySelector<HTMLButtonElement>(".menu-items button:not(:disabled)")?.focus({ preventScroll: true });
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 10;
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - pad) left = sub && flipX !== undefined ? flipX - r.width : window.innerWidth - r.width - pad;
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top), ready: true });
    if (!sub) el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y, sub, flipX, sheet]);

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    // The submenu is portalled but React still bubbles its events to the parent menu.
    e.stopPropagation();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>(":scope > .menu-items > button:not(:disabled)") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
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
      className={`menu${pos.ready ? " ready" : ""}${sub ? " sub" : ""}${sheet ? " sheet" : ""}${art ? " has-art" : ""}${sheet && openSub ? " covered" : ""}`}
      style={sheet ? undefined : { left: pos.left, top: pos.top }}
      role="menu"
      aria-label={title}
      onKeyDown={key}
      onContextMenu={(e) => e.preventDefault()}
    >
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
      <div className="menu-items">
        {items.map((item, i) =>
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
      {openSub && items[openSub.index]?.submenu ? createPortal(
        <MenuList
          items={items[openSub.index].submenu!}
          x={openSub.x}
          y={openSub.y}
          flipX={openSub.flipX}
          sub
          sheet={sheet}
          // A sheet's submenu replaces it on screen, so it says where you are and has a way back.
          title={sheet ? items[openSub.index].label : undefined}
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
