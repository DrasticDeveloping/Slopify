import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { closeMenu, takeMenuOpener } from "../state/actions";
import { useStore, type MenuItem } from "../state/store";
import { Icon } from "./Icon";

function MenuList({ items, x, y, flipX, title, subtitle, onDone, sub }: { items: MenuItem[]; x: number; y: number; flipX?: number; title?: string; subtitle?: string; onDone: () => void; sub?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
  const [openSub, setOpenSub] = useState<{ index: number; x: number; y: number; flipX: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 10;
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - pad) left = sub && flipX !== undefined ? flipX - r.width : window.innerWidth - r.width - pad;
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top), ready: true });
    if (!sub) el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y, sub, flipX]);

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
      className={`menu${pos.ready ? " ready" : ""}${sub ? " sub" : ""}`}
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      aria-label={title}
      onKeyDown={key}
      onContextMenu={(e) => e.preventDefault()}
    >
      {title ? (
        <div className="menu-head">
          <strong>{title}</strong>
          {subtitle ? <small>{subtitle}</small> : null}
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
              className={`menu-item${item.danger ? " danger" : ""}${openSub?.index === i ? " open" : ""}`}
              disabled={item.disabled}
              onPointerEnter={(e) => {
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
          onDone={() => {
            setOpenSub(null);
            ref.current?.querySelectorAll<HTMLButtonElement>(".menu-item")[openSub.index]?.focus();
          }}
        />,
        ref.current?.parentElement ?? document.body,
      ) : null}
    </div>
  );
}

export function ContextMenu() {
  const menu = useStore((s) => s.menu);
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
    <div className="menu-layer" onPointerDown={(e) => e.target === e.currentTarget && closeMenu()} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }}>
      <MenuList key={`${menu.x},${menu.y},${menu.title}`} items={menu.items} x={menu.x} y={menu.y} title={menu.title} subtitle={menu.subtitle} onDone={closeMenu} />
    </div>
  );
}
