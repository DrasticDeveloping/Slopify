import { useEffect, useRef, useState, type CSSProperties } from "react";
import { goBack, goForward, navigate, openMenu, openModal, playList, togglePlay } from "../state/actions";
import { getState, useStore } from "../state/store";
import { Icon } from "./Icon";
import { useContextPlaying } from "./Shelf";

export function TopBar({ scrolled }: { scrolled: boolean }) {
  const back = useStore((s) => s.back.length);
  const forward = useStore((s) => s.forward.length);
  const route = useStore((s) => s.route);
  const header = useStore((s) => s.header);
  const nonce = useStore((s) => s.searchFocusNonce);
  const name = useStore((s) => s.settings.profileName);
  const listen = useStore((s) => s.listen.mode);
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(route.name === "search" ? route.q : "");
  const playState = useContextPlaying(header?.play?.route);

  useEffect(() => {
    setDraft(route.name === "search" ? route.q : "");
  }, [route]);

  useEffect(() => {
    if (nonce) {
      input.current?.focus();
      input.current?.select();
    }
  }, [nonce]);

  const onSearch = (q: string) => {
    setDraft(q);
    navigate({ name: "search", q });
  };

  const profileMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    openMenu({
      x: r.right - 240,
      y: r.bottom + 8,
      title: name,
      subtitle: "Slopify account",
      items: [
        { label: "Your stats & history", icon: "stats", run: () => navigate({ name: "history" }) },
        { label: "Song storage", icon: "storage", run: () => navigate({ name: "storage" }) },
        { label: "Music server", icon: "server", run: () => navigate({ name: "server" }) },
        { label: "Clip editor", icon: "scissors", run: () => openModal({ type: "clipEditor", trackId: getState().currentId ?? undefined }) },
        { label: "Listen along", icon: "users", run: () => openModal({ type: "listenAlong" }) },
        { label: "Import music", icon: "download", run: () => openModal({ type: "import" }) },
        { separator: true },
        { label: "Settings", icon: "settings", hint: "Ctrl ,", run: () => openModal({ type: "settings" }) },
        { label: "Keyboard shortcuts", icon: "keyboard", hint: "?", run: () => openModal({ type: "settings", tab: "shortcuts" }) },
      ],
    });
  };

  const showTitle = Boolean(header?.visible);

  return (
    <div className={`topbar${scrolled ? " scrolled" : ""}${showTitle ? " titled" : ""}`} style={header ? ({ "--tint": header.tint } as CSSProperties) : undefined}>
      <div className="history-btns">
        <button type="button" className="icon-btn round" onClick={goBack} disabled={!back} aria-label="Go back" title="Back (Alt ←)">
          <Icon name="chevronLeft" size={20} />
        </button>
        <button type="button" className="icon-btn round" onClick={goForward} disabled={!forward} aria-label="Go forward" title="Forward (Alt →)">
          <Icon name="chevronRight" size={20} />
        </button>
      </div>

      <div className={`topbar-title${showTitle ? " show" : ""}`} aria-hidden={!showTitle}>
        {header?.play ? (
          <button
            type="button"
            className={`play-fab sm${playState.playing ? " is-playing" : ""}`}
            tabIndex={showTitle ? 0 : -1}
            onClick={() => (playState.active ? togglePlay() : header.play && playList(header.play.ids, undefined, header.play))}
            aria-label={playState.playing ? `Pause ${header.title}` : `Play ${header.title}`}
          >
            <Icon name={playState.playing ? "pause" : "play"} size={16} />
          </button>
        ) : null}
        <strong>{header?.title}</strong>
      </div>

      <label className={`search-box${route.name === "search" ? " active" : ""}`}>
        <Icon name="search" size={19} />
        <input
          ref={input}
          value={draft}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (draft) onSearch("");
              else input.current?.blur();
            }
          }}
          placeholder="What do you want to play?"
          aria-label="Search songs, artists, albums, and playlists"
          spellCheck={false}
          autoComplete="off"
        />
        {draft ? (
          <button type="button" className="icon-btn sm" onClick={() => { onSearch(""); input.current?.focus(); }} aria-label="Clear search">
            <Icon name="close" size={16} />
          </button>
        ) : (
          <kbd className="kbd">Ctrl K</kbd>
        )}
      </label>

      <div className="topbar-actions">
        <button type="button" className="btn ghost sm hide-narrow" onClick={() => openModal({ type: "import" })}>
          <Icon name="download" size={17} />
          Import
        </button>
        <button type="button" className={`icon-btn round${listen !== "idle" ? " on" : ""}`} onClick={() => openModal({ type: "listenAlong" })} aria-label="Listen along" title="Listen along">
          <Icon name="users" size={19} />
        </button>
        <button type="button" className="avatar-btn" onClick={(e) => profileMenu(e.currentTarget)} aria-label="Open profile menu" aria-haspopup="menu">
          {name.slice(0, 1).toUpperCase()}
        </button>
      </div>
    </div>
  );
}
