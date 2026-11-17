import { useEffect, useRef, useState, type CSSProperties } from "react";
import { thisDevice } from "../lib/native";
import { scrollBehavior } from "../lib/motion";
import { goBack, goForward, navigate, openMenu, openModal, playList, togglePlay } from "../state/actions";
import { getState, useStore, type MenuState } from "../state/store";
import { installApp, usePwa } from "../state/pwa";
import { cloudEnabled, manageAccount, signIn, signOut, useAccount } from "../state/cloud";
import { openShared, parseShareLink } from "../state/social";
import { spotifySongLinks } from "../state/importer";
import { HiddenEmail } from "./HiddenEmail";
import { Icon } from "./Icon";
import { useContextPlaying } from "./Shelf";
import { pageTitle } from "../lib/page-title";

/** The last search-focus request carried out (see TopBar). */
let focusedSearchFor = 0;

export function TopBar({ scrolled }: { scrolled: boolean }) {
  const pwa = usePwa();
  const back = useStore((s) => s.back.length);
  const forward = useStore((s) => s.forward.length);
  const route = useStore((s) => s.route);
  const title = useStore((s) => pageTitle(s.route, s));
  const header = useStore((s) => s.header);
  const nonce = useStore((s) => s.searchFocusNonce);
  const name = useStore((s) => s.settings.profileName);
  const listen = useStore((s) => s.listen.mode);
  const account = useAccount();
  const avatar = account.status === "signedIn" ? account.profile?.avatarUrl : null;
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(route.name === "search" ? route.q : "");
  const [editingSearch, setEditingSearch] = useState(false);
  const playState = useContextPlaying(header?.play?.route);

  useEffect(() => {
    setDraft(route.name === "search" ? route.q : "");
  }, [route]);

  // Each request to focus search (Ctrl+K, "/", Find music) is carried out once: a top bar built later (on a phone each
  // page has its own) mustn't take the focus again for a request that was already met.
  useEffect(() => {
    if (nonce > focusedSearchFor) {
      focusedSearchFor = nonce;
      input.current?.focus();
      input.current?.select();
    }
  }, [nonce]);

  const onSearch = (q: string) => {
    // A shared playlist's link opens the playlist.
    const shareId = parseShareLink(q);
    if (shareId) {
      setDraft("");
      openShared(shareId);
      return;
    }
    setDraft(q);
    navigate({ name: "search", q });
  };

  /** The profile menu while it's open, so it can follow the account (sign-in finishing or failing). */
  const shownProfile = useRef<{ el: HTMLElement; menu: MenuState } | null>(null);
  const profileMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const shownName = account.status === "signedIn" ? account.profile?.displayName ?? name : name;
    const menu: MenuState = {
      x: r.right - 240,
      y: r.bottom + 8,
      // Signed out, no initial: the menu is saying no account is signed in.
      art: avatar ? { image: avatar, round: true } : account.status === "signedIn" || account.status === "disabled" ? { initial: (shownName || "Y").slice(0, 1).toUpperCase(), round: true } : { icon: "user", round: true },
      // Signed out, the name is only this device's: say plainly that no account is signed in.
      title: account.status === "signedIn" ? account.profile?.displayName ?? name ?? "You" : account.status === "disabled" ? name || "You" : "Not signed in",
      subtitle: account.status === "signedIn"
        ? account.profile?.username ? `@${account.profile.username}` : account.email ? <HiddenEmail email={account.email} /> : "Signed in"
        : account.status === "loading" ? "Checking your account…"
        : account.status === "signedOut" ? account.error ?? "Sync your library and add friends" : `On ${thisDevice}`,
      items: [
        ...(account.status === "signedOut" ? [{ label: "Sign in", icon: "user", accent: true, run: signIn }, { separator: true }] : []),
        ...(cloudEnabled ? [{ label: "Friends", icon: "users", run: () => navigate({ name: "friends" }) }] : []),
        // Phones hide the top bar's Listen along button, so it's here instead.
        ...(window.matchMedia("(max-width: 680px)").matches ? [{ label: "Listen along", icon: "radio", run: () => openModal({ type: "listenAlong" }) }] : []),
        { label: "Your stats & history", icon: "stats", run: () => navigate({ name: "history" }) },
        { label: "Song storage", icon: "storage", run: () => navigate({ name: "storage" }) },
        { label: "Music server", icon: "server", run: () => navigate({ name: "server" }) },
        { separator: true },
        ...(pwa.canInstall ? [{ label: "Install Slopify", icon: "download", run: () => void installApp() }] : []),
        { label: "Settings", icon: "settings", hint: "Ctrl ,", run: () => openModal({ type: "settings" }) },
        // Touch screens have no keyboard for shortcuts.
        ...(window.matchMedia("(hover: none) and (pointer: coarse)").matches ? [] : [{ label: "Keyboard shortcuts", icon: "keyboard", hint: "?", run: () => openModal({ type: "settings", tab: "shortcuts" }) }]),
        ...(account.status === "signedIn" ? [{ separator: true }, { label: "Manage account", icon: "user", run: manageAccount }, { label: "Sign out", icon: "logout", run: () => void signOut() }] : []),
      ],
    };
    shownProfile.current = { el, menu };
    openMenu(menu);
  };
  useEffect(() => {
    const shown = shownProfile.current;
    if (shown && getState().menu === shown.menu) profileMenu(shown.el);
  }, [account]);

  const showTitle = Boolean(header?.visible);

  return (
    <div className={`topbar${route.name === "search" ? " searching" : ""}${editingSearch ? " editing-search" : ""}${scrolled ? " scrolled" : ""}${showTitle ? " titled" : ""}`} style={header ? ({ "--tint": header.tint } as CSSProperties) : undefined} onBlur={(e) => {
      if (!(e.relatedTarget instanceof Element) || !e.relatedTarget.closest("[data-search-control]")) setEditingSearch(false);
    }}>
      <div className="topbar-start">
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
      </div>

      <button type="button" className="mobile-page-title" aria-label="Scroll to top" onClick={() => document.querySelector(".main-scroll:not(.back-page)")?.scrollTo({ top: 0, behavior: scrollBehavior() })}>{header?.title || title}</button>
      <label className={`search-box${route.name === "search" ? " active" : ""}`} data-search-control>
        <Icon name="search" size={19} />
        <input
          ref={input}
          value={draft}
          onChange={(e) => onSearch(e.target.value)}
          onPaste={(e) => {
            // Songs copied from Spotify's app arrive as one link per line, which a one-line box would run together.
            const songs = spotifySongLinks(e.clipboardData.getData("text"));
            if (songs.length < 2) return;
            e.preventDefault();
            onSearch(songs.join(" "));
          }}
          onFocus={() => setEditingSearch(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") input.current?.blur();
            if (e.key === "Escape") {
              if (draft) onSearch("");
              else input.current?.blur();
            }
          }}
          placeholder="What do you want to play?"
          aria-label="Search songs, artists, albums, and playlists"
          type="search"
          enterKeyHint="search"
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
        {editingSearch ? <button type="button" className="search-cancel" data-search-control onPointerDown={(e) => e.preventDefault()} onClick={() => {
          input.current?.blur();
          setEditingSearch(false);
          document.querySelector<HTMLElement>(".main")?.focus({ preventScroll: true });
        }}>Cancel</button> : null}
        <button type="button" className={`icon-btn round${listen !== "idle" ? " on" : ""}`} onClick={() => openModal({ type: "listenAlong" })} aria-label="Listen along" title="Listen along">
          <Icon name="users" size={19} />
        </button>
        <button type="button" className="avatar-btn" onClick={(e) => profileMenu(e.currentTarget)} aria-label="Open profile menu" aria-haspopup="menu">
          {avatar ? <img src={avatar} alt="" referrerPolicy="no-referrer" /> : name && (account.status === "signedIn" || account.status === "disabled") ? name.slice(0, 1).toUpperCase() : <Icon name="user" size={18} />}
        </button>
      </div>
    </div>
  );
}
