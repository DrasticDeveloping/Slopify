import { useEffect, useRef, useState } from "react";
import { ContextMenu } from "./components/ContextMenu";
import { FullPlayer } from "./components/FullPlayer";
import { Icon } from "./components/Icon";
import { ModalHost } from "./components/modals/ModalHost";
import { PlayerBar } from "./components/PlayerBar";
import { RightPanel, usePanel } from "./components/RightPanel";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { UpdateBanner } from "./components/UpdateBanner";
import { TopBar } from "./components/TopBar";
import { activeCustomTheme, builtinThemes, onAccent } from "./state/themes";
import {
  closeMenu, closeModal, cycleRepeat, findMusic, openMenu, goBack, goForward, importFiles, navigate, next, openModal, positionOf, previous, seek, setVolume, takeScrollRestore, trackScroll,
  toggleLike, toggleMute, togglePlay, cycleShuffle, wireEngine,
} from "./state/actions";
import { prepareMixes } from "./recommend/mixes";
import { startMusicServer } from "./state/server";
import { syncLibraryData, watchLibraryData } from "./state/sync";
import { restorePlaybackSpot, watchPlaybackSpot } from "./state/resume";
import { getState, setState, useStore, type Route } from "./state/store";
import { AlbumView, PlaylistView } from "./views/Collection";
import { HistoryView } from "./views/History";
import { HomeView } from "./views/Home";
import { MixView } from "./views/Mix";
import { LibraryView, PlaylistsView } from "./views/Library";
import { ArtistView } from "./views/Artist";
// Plugs web-discovery radio into the player (see connectRadio).
import "./recommend/radio";
import "./recommend/smart-shuffle";
import "./state/slipins";
import { ReleaseView } from "./views/Release";
import { SearchView } from "./views/Search";
import { ServerView } from "./views/Server";
import { FriendsView, SharedView } from "./views/Friends";
import { watchSocial } from "./state/social";
import { StorageView } from "./views/Storage";

function View({ route }: { route: Route }) {
  switch (route.name) {
    case "home":
      return <HomeView />;
    case "mix":
      return <MixView id={route.id} />;
    case "search":
      return <SearchView q={route.q} />;
    case "library":
      return <LibraryView filter={route.filter} />;
    case "playlists":
      return <PlaylistsView />;
    case "playlist":
      return <PlaylistView id={route.id} />;
    case "album":
      return <AlbumView id={route.id} />;
    case "artist":
      return <ArtistView id={route.id} />;
    case "release":
      return <ReleaseView id={route.id} />;
    case "storage":
      return <StorageView />;
    case "server":
      return <ServerView />;
    case "history":
      return <HistoryView />;
    case "friends":
      return <FriendsView />;
    case "shared":
      return <SharedView id={route.id} />;
  }
}

/** Route identity for transitions; typing in search shouldn't re-animate the page. */
function routeKey(route: Route) {
  if (route.name === "search") return route.q.trim() ? "search-results" : "search-browse";
  if (route.name === "library") return "library";
  return JSON.stringify(route);
}

function useTheme() {
  const theme = useStore((s) => s.settings.theme);
  const custom = useStore((s) => activeCustomTheme(s.settings));
  const reduce = useStore((s) => s.settings.reduceMotion);
  const compact = useStore((s) => s.settings.compact);
  const palette = useStore((s) => (s.currentId ? s.albums[s.tracks[s.currentId]?.albumId]?.palette : undefined));

  useEffect(() => {
    const root = document.documentElement;
    // A theme you made that's been deleted (perhaps on another device) falls back to Dynamic.
    const shown = custom ? "custom" : theme.startsWith("custom-") ? "dynamic" : theme;
    root.dataset.theme = shown;
    root.dataset.motion = reduce ? "reduce" : "full";
    root.dataset.density = compact ? "compact" : "comfortable";
    for (const name of ["--accent", "--accent-2", "--accent-3", "--bg", "--on-accent"]) root.style.removeProperty(name);
    if (custom) {
      // The panels and third glow are mixed from these in CSS.
      root.style.setProperty("--accent", custom.accent);
      root.style.setProperty("--accent-2", custom.accent2);
      root.style.setProperty("--bg", custom.background);
      root.style.setProperty("--on-accent", onAccent(custom.accent));
    } else if (shown === "dynamic") {
      const p = palette ?? { a: "#a78bfa", b: "#f472b6", c: "#1e1b4b" };
      root.style.setProperty("--accent", p.a);
      root.style.setProperty("--accent-2", p.b);
      root.style.setProperty("--accent-3", p.c);
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute("content", custom?.background ?? builtinThemes.find((t) => t.id === shown)?.swatch[2] ?? "#08080c");
  }, [theme, custom, reduce, compact, palette]);
}

const typing = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
};

function useShortcuts() {
  useEffect(() => {
    /*
     * The control that last took focus from a click (not the keyboard). A clicked button keeps
     * focus, and Space would press it again; for it, Space plays/pauses instead. The browser's
     * :focus-visible can't tell: it turns on for the focused button as soon as any key is pressed.
     */
    let clickedAt = 0;
    let clicked: EventTarget | null = null;
    const onPointerDown = (e: PointerEvent) => {
      clickedAt = performance.now();
      // Clicking the control that already has focus doesn't move focus, so note it here.
      const el = e.target instanceof Element ? e.target.closest("button, a, [role=slider], [role=row]") : null;
      if (el && el === document.activeElement) clicked = el;
    };
    // Tab moves focus by keyboard, however soon after a click.
    const onTab = (e: KeyboardEvent) => {
      if (e.key === "Tab") clickedAt = 0;
    };
    const onFocusIn = (e: FocusEvent) => {
      // Focus moved by a click, or by the app straight after one (a dialog closing, say).
      clicked = performance.now() - clickedAt < 600 ? e.target : null;
    };
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (s.route.name !== "search") navigate({ name: "search", q: "" });
        setState((st) => ({ searchFocusNonce: st.searchFocusNonce + 1 }));
        return;
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        openModal({ type: "settings" });
        return;
      }
      if (e.key === "Escape") {
        if (s.menu) closeMenu();
        else if (s.modal) closeModal();
        else if (s.fullPlayer && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        else if (s.fullPlayer) setState({ fullPlayer: false });
        else if (s.selection.length) setState({ selection: [] });
        return;
      }
      if (typing(e.target) || s.modal || s.menu) return;
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
        return;
      }
      if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        goForward();
        return;
      }
      const target = e.target as HTMLElement;
      const onControl = target.closest?.("button, a, [role=slider], [role=row]");
      if (!s.settings.letterShortcuts && e.key.length === 1 && e.key !== " " && !mod) return;
      switch (e.key) {
        case " ":
          // Space presses a control only when you reached it from the keyboard (see `clicked`).
          if (onControl && target.getAttribute("role") !== "row" && target !== clicked) return;
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
        case "ArrowLeft": {
          if (onControl && !mod) return;
          e.preventDefault();
          if (mod) {
            if (e.key === "ArrowRight") next();
            else previous();
          } else if (s.currentId) seek(positionOf(s.currentId) + (e.key === "ArrowRight" ? 5 : -5));
          break;
        }
        case "ArrowUp":
        case "ArrowDown":
          if (!mod) return;
          e.preventDefault();
          setVolume(s.volume + (e.key === "ArrowUp" ? 0.05 : -0.05));
          break;
        case "/":
          e.preventDefault();
          if (s.route.name !== "search") navigate({ name: "search", q: "" });
          setState((st) => ({ searchFocusNonce: st.searchFocusNonce + 1 }));
          break;
        case "?":
          openModal({ type: "settings", tab: "shortcuts" });
          break;
        default: {
          if (mod || e.altKey) return;
          const k = e.key.toLowerCase();
          if (k === "m") toggleMute();
          else if (k === "l" && s.currentId) toggleLike(s.currentId);
          else if (k === "s") cycleShuffle();
          else if (k === "r") cycleRepeat();
          else if (k === "q") setState({ panel: s.panel === "queue" ? null : "queue" });
          else if (k === "f" && s.currentId) setState({ fullPlayer: !s.fullPlayer });
        }
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onTab, true);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onTab, true);
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}

function useFileDrop() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
    const enter = (e: DragEvent) => {
      if (!hasFiles(e) || getState().modal) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (hasFiles(e) && !getState().modal) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      setOver(false);
      if (!hasFiles(e) || getState().modal) return;
      e.preventDefault();
      if (e.dataTransfer?.files.length) importFiles(e.dataTransfer.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overFn);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("drop", drop);
    };
  }, []);
  return over;
}

const mobileTabs: Array<{ route: Route; label: string; icon: string }> = [
  { route: { name: "home" }, label: "Home", icon: "home" },
  { route: { name: "search", q: "" }, label: "Search", icon: "search" },
  { route: { name: "library" }, label: "Library", icon: "library" },
  { route: { name: "playlists" }, label: "Playlists", icon: "playlists" },
];

/** Keeps keyboard and screen-reader focus inside whichever overlay is on top. */
function useInertBackground() {
  const full = useStore((s) => s.fullPlayer);
  const modal = useStore((s) => Boolean(s.modal));
  const panel = useStore((s) => s.panel);
  useEffect(() => {
    const blocked = full || modal;
    document.querySelectorAll(".sidebar, .main, .right-panel, .playerbar, .mobile-nav").forEach((el) => el.toggleAttribute("inert", blocked));
    document.querySelector(".full-player")?.toggleAttribute("inert", modal);
  }, [full, modal, panel]);
}

export function App() {
  const route = useStore((s) => s.route);
  const panel = usePanel();
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const dropping = useFileDrop();
  useTheme();
  useShortcuts();
  useInertBackground();

  useEffect(() => {
    wireEngine();
    watchLibraryData();
    watchPlaybackSpot();
    watchSocial();
    // Once the library is known: the song you were playing is put back, and today's mixes are made (then kept up to date each minute).
    void startMusicServer(() => syncLibraryData().catch(() => undefined).then(() => {
      restorePlaybackSpot();
      return prepareMixes();
    }));
    const mixTimer = window.setInterval(() => void prepareMixes(), 60_000);
    return () => clearInterval(mixTimer);
  }, []);

  const key = routeKey(route);
  useEffect(() => trackScroll(() => scroller.current?.scrollTop ?? 0), []);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const top = takeScrollRestore();
    el.scrollTo({ top: 0, behavior: "instant" });
    setScrolled(false);
    if (!top) return;
    // A page you went back to scrolls to where you were. It fills in as its data loads,
    // so this keeps trying until it's tall enough (for up to 3 seconds), unless you scroll first.
    let frame = 0;
    let gaveUp = false;
    const until = performance.now() + 3000;
    const stop = () => { gaveUp = true; };
    const inputs = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    inputs.forEach((type) => el.addEventListener(type, stop, { passive: true }));
    const step = () => {
      if (gaveUp) return;
      el.scrollTo({ top, behavior: "instant" });
      if (Math.abs(el.scrollTop - top) < 2 || performance.now() > until) return void setScrolled(el.scrollTop > 8);
      frame = requestAnimationFrame(step);
    };
    step();
    return () => {
      cancelAnimationFrame(frame);
      inputs.forEach((type) => el.removeEventListener(type, stop));
    };
  }, [key]);

  return (
    <div className={`app${panel ? " has-panel" : ""}${collapsed ? " side-collapsed" : ""}`}>
      <div className="ambient" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <Sidebar />
      <main className="main" aria-label="Content" tabIndex={-1}>
        <div className="main-scroll" ref={scroller} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 8)}>
          <TopBar scrolled={scrolled} />
          <div className="view-wrap" key={key}>
            <View route={route} />
          </div>
        </div>
      </main>
      <RightPanel />
      <PlayerBar />
      <nav className="mobile-nav" aria-label="Primary">
        {mobileTabs.map((t) => (
          <button key={t.label} type="button" className={route.name === t.route.name ? "on" : ""} aria-current={route.name === t.route.name ? "page" : undefined} onClick={() => navigate(t.route)}>
            <Icon name={t.icon} size={22} />
            <span>{t.label}</span>
          </button>
        ))}
        <button
          type="button"
          className={["storage", "server", "history", "friends", "shared"].includes(route.name) ? "on" : ""}
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu({
              x: r.right - 240,
              y: r.top - 8,
              title: "More",
              items: [
                { label: "Song storage", icon: "storage", run: () => navigate({ name: "storage" }) },
                { label: "Music server", icon: "server", run: () => navigate({ name: "server" }) },
                { label: "Your stats & history", icon: "stats", run: () => navigate({ name: "history" }) },
                { separator: true },
                { label: "Find music", icon: "search", run: () => findMusic() },
                { label: "Friends", icon: "users", run: () => navigate({ name: "friends" }) },
                { label: "Listen along", icon: "radio", run: () => openModal({ type: "listenAlong" }) },
                { label: "Settings", icon: "settings", run: () => openModal({ type: "settings" }) },
              ],
            });
          }}
        >
          <Icon name="more" size={22} />
          <span>More</span>
        </button>
      </nav>
      <FullPlayer />
      <ModalHost />
      <ContextMenu />
      <Toasts />
      <UpdateBanner />
      {dropping ? (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <Icon name="download" size={36} />
            <strong>Drop to import</strong>
            <span>Audio and video files play right in Slopify</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
