import { useState, type CSSProperties, type ReactNode } from "react";
import { plural } from "../../lib/format";
import { qualified, reasonWeight, type ReasonKind, type TasteState } from "../../recommend/taste";
import { resetRecommendations, showHiddenRecommendations, updateSettings } from "../../state/actions";
import { checkForUpdates, installUpdate, isDesktopApp, setDesktopSetting, setUpdateChannel, useDesktopSettings, useDesktopUpdates, type DesktopUpdates, type UpdateChannel } from "../../state/desktop";
import { cloudEnabled, manageAccount, saveProfile, signIn, signOut, useAccount } from "../../state/cloud";
import { toast } from "../../state/actions";
import { connect, disconnect } from "../../state/server";
import { linkComputer } from "../../state/sync";
import { installApp, installationHelp, updateApp, usePwa } from "../../state/pwa";
import { defaultSettings, resetAppData, useStore, type Settings, type SettingsTab, type Theme } from "../../state/store";
import { Icon } from "../Icon";
import { Slider } from "../Slider";
import { Shell, Toggle } from "./Shell";

const tabs: Array<[SettingsTab, string, string]> = [
  ["general", "General", "settings"],
  ["playback", "Playback", "wave"],
  ["appearance", "Appearance", "palette"],
  ["server", "Server", "server"],
  ["shortcuts", "Shortcuts", "keyboard"],
];

export const themes: Array<{ id: Theme; name: string; note: string; swatch: [string, string, string] }> = [
  { id: "dynamic", name: "Dynamic", note: "Follows the artwork", swatch: ["#ff7ab6", "#7c5cff", "#2dd4bf"] },
  { id: "midnight", name: "Midnight", note: "Violet classic", swatch: ["#8b5cf6", "#6366f1", "#14121f"] },
  { id: "ocean", name: "Ocean", note: "Deep blues", swatch: ["#38bdf8", "#2563eb", "#0b1626"] },
  { id: "forest", name: "Forest", note: "Calm greens", swatch: ["#4ade80", "#059669", "#0b1a12"] },
  { id: "sunset", name: "Sunset", note: "Warm coral", swatch: ["#fb923c", "#e11d48", "#1f0f0c"] },
  { id: "mono", name: "Mono", note: "Quiet greyscale", swatch: ["#f4f4f5", "#a1a1aa", "#18181b"] },
];

const TONE_PRESETS: Array<{ name: string; tone: Omit<Settings["tone"], "balance"> }> = [
  { name: "Flat", tone: { bass: 0, mid: 0, treble: 0 } },
  { name: "Bass boost", tone: { bass: 6, mid: 0, treble: 0 } },
  { name: "Bass reducer", tone: { bass: -6, mid: 0, treble: 0 } },
  { name: "Vocal", tone: { bass: -2, mid: 4, treble: 2 } },
  { name: "Treble boost", tone: { bass: 0, mid: 0, treble: 6 } },
  { name: "Loudness", tone: { bass: 5, mid: -1, treble: 4 } },
  { name: "Late night", tone: { bass: -3, mid: 2, treble: -4 } },
];
const dB = (v: number) => `${v > 0 ? "+" : ""}${v} dB`;
const side = (v: number) => (Math.abs(v) < 0.05 ? "Centre" : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? "left" : "right"}`);

/** Bass, mid, treble and balance for everything that plays, with presets. */
function ToneControls() {
  const tone = { ...defaultSettings.tone, ...useStore((s) => s.settings.tone) };
  const change = (patch: Partial<Settings["tone"]>) => updateSettings({ tone: { ...tone, ...patch } });
  const preset = TONE_PRESETS.find((p) => p.tone.bass === tone.bass && p.tone.mid === tone.mid && p.tone.treble === tone.treble)?.name ?? "Custom";
  const bands: Array<[keyof Omit<Settings["tone"], "balance">, string, string]> = [
    ["bass", "Bass", "Low end: kick drums and bass lines."],
    ["mid", "Mid", "Vocals and most instruments."],
    ["treble", "Treble", "Cymbals, air and detail."],
  ];
  const flat = tone.bass === 0 && tone.mid === 0 && tone.treble === 0 && tone.balance === 0;
  return (
    <>
      <h3 className="set-section">Equalizer</h3>
      <div className="set-group">
        <Row icon="sliders" title="Preset" desc="Shapes the sound of everything you play, on this device.">
          <label className="select">
            <select
              value={preset}
              onChange={(e) => {
                const p = TONE_PRESETS.find((x) => x.name === e.target.value);
                if (p) change(p.tone);
              }}
              aria-label="Equalizer preset"
            >
              {TONE_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              {preset === "Custom" ? <option value="Custom">Custom</option> : null}
            </select>
          </label>
          <button type="button" className="btn sm" disabled={flat} onClick={() => change({ bass: 0, mid: 0, treble: 0, balance: 0 })}>Reset</button>
        </Row>
        {bands.map(([key, name, desc]) => (
          <div className="set-slider tone-slider" key={key}>
            <span className="tone-label"><strong>{name}</strong><small className="muted">{desc}</small></span>
            <Slider max={24} step={1} value={tone[key] + 12} onInput={(v) => change({ [key]: Math.round(v) - 12 })} label={name} format={(v) => dB(Math.round(v) - 12)} showTooltip />
            <span className="muted small tone-value">{dB(tone[key])}</span>
          </div>
        ))}
        <div className="set-slider tone-slider">
          <span className="tone-label"><strong>Balance</strong><small className="muted">Left and right speakers.</small></span>
          <Slider max={2} step={0.05} value={tone.balance + 1} onInput={(v) => change({ balance: Math.round((v - 1) * 20) / 20 })} label="Balance" format={(v) => side(v - 1)} showTooltip />
          <span className="muted small tone-value">{side(tone.balance)}</span>
        </div>
      </div>
    </>
  );
}

function Row({ icon, title, desc, children, column }: { icon: string; title: string; desc?: ReactNode; children?: ReactNode; column?: boolean }) {
  return (
    <div className={`set-row${column ? " column" : ""}`}>
      <span className="set-icon"><Icon name={icon} size={19} /></span>
      <span className="set-copy">
        <strong>{title}</strong>
        {desc ? <small>{desc}</small> : null}
      </span>
      {children ? <span className="set-control">{children}</span> : null}
    </div>
  );
}

const KIND_NAMES: Partial<Record<ReasonKind, string>> = {
  liked: "songs you liked",
  saved: "songs in your playlists",
  enjoyed: "songs you replay",
  artist: "artists you play",
  genre: "your favourite genres",
  playlist: "playlist neighbours",
  after: "songs you play in sequence",
  similar: "songs like the one playing",
  linked: "ListenBrainz listener matches",
  fresh: "songs you haven't heard",
  "discover-song": "related songs from outside your library",
  "discover-artist": "related artists from outside your library",
};

/** One line on what the recommender has learned from kept and skipped suggestions. */
function learnedSummary(taste: TasteState) {
  const kinds = Object.keys(KIND_NAMES) as ReasonKind[];
  const named = (list: ReasonKind[]) => list.map((k) => KIND_NAMES[k]).join(", ");
  const more = kinds.filter((k) => reasonWeight(taste, k) >= 1.15);
  const less = kinds.filter((k) => reasonWeight(taste, k) <= 0.85);
  if (!more.length && !less.length) return "Nothing learned yet: keep or skip a few suggestions and it adapts.";
  return [more.length ? `Leaning towards ${named(more)}.` : "", less.length ? `Playing down ${named(less)}.` : ""].filter(Boolean).join(" ");
}

const shortcuts: Array<[string, string]> = [
  ["Space", "Play / pause"],
  ["Ctrl →  /  Ctrl ←", "Next / previous song"],
  ["→  /  ←", "Seek 5 seconds"],
  ["Ctrl ↑  /  Ctrl ↓", "Volume up / down"],
  ["M", "Mute"],
  ["L", "Like current song"],
  ["S", "Shuffle"],
  ["R", "Repeat: loop song, repeat all, off"],
  ["Q", "Toggle queue"],
  ["F", "Full screen player (full screen while watching a video)"],
  ["Ctrl K  /  /", "Search"],
  ["Alt ←  /  Alt →", "Back / forward"],
  ["Ctrl ,", "Settings"],
  ["Esc", "Close dialogs and menus"],
];

function updateStatus(u: DesktopUpdates) {
  switch (u.status) {
    case "unsupported": return "This copy of Slopify doesn't check for updates. Builds made with an update source do.";
    case "checking": return "Checking for updates…";
    case "none": return "You're up to date.";
    case "available": return u.portable ? `Slopify ${u.available} is out. This portable copy updates by downloading the new one.` : `Slopify ${u.available} is out.`;
    case "downloading": return `Downloading Slopify ${u.available ?? ""}… ${u.progress}%`;
    case "ready": return `Slopify ${u.available} is ready. Restart to finish updating; your music and playlists stay.`;
    case "error": return u.error ?? "Couldn't check for updates.";
    default: return "Slopify checks for updates in the background.";
  }
}

/** The desktop app's version, update channel and update status. */
function DesktopUpdateRows() {
  const u = useDesktopUpdates();
  if (!u) return null;
  const off = u.status === "unsupported";
  return (
    <>
      <Row icon="sync" title={`Slopify ${u.version}`} desc={updateStatus(u)}>
        {u.status === "ready" || (u.portable && u.status === "available") ? (
          <button type="button" className="btn primary" onClick={installUpdate}>{u.portable ? "Download" : "Restart"}</button>
        ) : (
          <button type="button" className="btn sm" disabled={off || u.status === "checking" || u.status === "downloading"} onClick={checkForUpdates}>
            Check for updates
          </button>
        )}
      </Row>
      <Row icon="sparkle" title="Update channel" desc="Nightly gets new builds as soon as they're made, before they reach Stable. They may have more bugs.">
        <select className="input sm" value={u.channel} disabled={off || u.status === "downloading"} onChange={(e) => setUpdateChannel(e.target.value as UpdateChannel)} aria-label="Update channel">
          <option value="stable">Stable</option>
          <option value="nightly">Nightly</option>
        </select>
      </Row>
    </>
  );
}

/** Closing to the tray and the Discord status, in the desktop app. */
function DesktopBehaviourRows() {
  const d = useDesktopSettings();
  if (!d) return null;
  return (
    <>
      <Row icon="collapse" title="Keep playing when closed" desc="Closing the window keeps Slopify playing in the system tray, like Discord. Quit from the tray icon.">
        <Toggle checked={d.closeToTray} onChange={(v) => setDesktopSetting({ closeToTray: v })} label="Keep playing when closed" />
      </Row>
      <Row icon="discord" title="Show what you're playing on Discord" desc={d.discordAvailable ? "Your Discord profile shows the song as \"Listening to\" while the Discord app is open." : "This copy of Slopify wasn't built with a Discord application, so it can't show your status."}>
        <Toggle checked={d.discordAvailable && d.discord} disabled={!d.discordAvailable} onChange={(v) => setDesktopSetting({ discord: v })} label="Show what you're playing on Discord" />
      </Row>
    </>
  );
}

/** Your Slopify account (when this build has the online service): sign in, and the name everyone sees. */
function AccountRows() {
  const account = useAccount();
  const name = useStore((s) => s.settings.profileName);
  const synced = useStore((s) => s.server.cloudSyncedAt);
  const syncError = useStore((s) => s.server.cloudError);
  const linkedElsewhere = useStore((s) => s.server.linkedElsewhere);
  const [draft, setDraft] = useState<string | null>(null);
  if (!cloudEnabled) {
    return (
      <Row icon="user" title="Display name" desc="The name shown on your profile.">
        <input className="input sm" value={name} maxLength={24} onChange={(e) => updateSettings({ profileName: e.target.value || "You" })} aria-label="Display name" />
      </Row>
    );
  }
  if (account.status !== "signedIn") {
    return (
      <Row icon="user" title="Slopify account" desc="Sign in to keep your library on every device and to listen along with friends. Without an account, everything stays on this computer.">
        <button type="button" className="btn primary sm" disabled={account.status === "loading"} onClick={signIn}>{account.status === "loading" ? "Loading…" : "Sign in"}</button>
      </Row>
    );
  }
  const commit = async () => {
    const value = draft?.trim();
    setDraft(null);
    if (!value || value === account.profile?.displayName) return;
    try {
      await saveProfile({ displayName: value });
    } catch (error) {
      toast("Couldn't save your name", { tone: "error", detail: error instanceof Error ? error.message : undefined });
    }
  };
  return (
    <>
      <Row icon="user" title={account.email ?? "Signed in"} desc={account.error ?? (syncError ? `Library sync: ${syncError}` : synced ? `Your library follows this account. Last synced ${new Date(synced).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : "Your library and profile follow this account.")}>
        <button type="button" className="btn sm" onClick={manageAccount}>Manage</button>
        <button type="button" className="btn sm" onClick={() => void signOut()}>Sign out</button>
      </Row>
      {linkedElsewhere ? (
        <Row icon="sync" title="This computer's library isn't synced" desc={`Its songs and playlists belong to ${linkedElsewhere}, so they stay out of this account. Use them with this account instead to add them to it.`}>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              if (window.confirm(`Add this computer's songs and playlists to ${account.email ?? "this account"}? ${linkedElsewhere} will no longer sync with them.`)) void linkComputer(true);
            }}
          >
            Use with this account
          </button>
        </Row>
      ) : null}
      <Row icon="users" title="Display name" desc="What friends see in Listen Along.">
        <input
          className="input sm"
          value={draft ?? account.profile?.displayName ?? name}
          maxLength={40}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          aria-label="Display name"
        />
      </Row>
    </>
  );
}

function installDescription(pwa: { installed: boolean; canInstall: boolean }) {
  if (pwa.installed) return "Launch it from your apps. Songs kept on this device also play offline.";
  if (pwa.canInstall) return "A home for your music in its own app window. Songs kept on this device also play offline.";
  return installationHelp();
}

export function SettingsModal({ initial }: { initial?: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(initial ?? "general");
  const settings = useStore((s) => s.settings);
  const pwa = usePwa();
  const status = useStore((s) => s.server.status);
  const taste = useStore((s) => s.taste);
  const hiddenCount = Object.keys(taste.hidden).length + Object.keys(taste.hiddenDiscoveries).length;
  const set = <K extends keyof Settings>(key: K) => (value: Settings[K]) => updateSettings({ [key]: value } as Partial<Settings>);
  const fmtSec = (v: number) => `${Math.round(v)} seconds`;

  return (
    <Shell title="Settings" subtitle="Kept in step through your music server" size="xl" className="settings-modal">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {tabs.map(([id, label, icon]) => (
            <button key={id} type="button" className={tab === id ? "on" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
              <Icon name={icon} size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-content" key={tab}>
          {tab === "general" ? (
            <>
              <h3 className="set-section">Slopify app</h3>
              <div className="set-group">
                {isDesktopApp ? (
                  <>
                    <DesktopUpdateRows />
                    <DesktopBehaviourRows />
                  </>
                ) : (
                  <Row icon="download" title={pwa.installed ? "Slopify is installed" : "Install Slopify"} desc={installDescription(pwa)}>
                    {pwa.canInstall || pwa.installing ? (
                      <button type="button" className="btn primary" disabled={pwa.installing} onClick={() => void installApp()}>
                        {pwa.installing ? "Installing…" : "Install"}
                      </button>
                    ) : null}
                  </Row>
                )}
                {pwa.updateReady ? (
                  <Row icon="sync" title="An update is ready" desc="Restart when you're ready. Your saved music and playlists stay here.">
                    <button type="button" className="btn" onClick={updateApp}>Update & restart</button>
                  </Row>
                ) : null}
              </div>
              <h3 className="set-section">Listening</h3>
              <div className="set-group">
                <Row icon="sparkle" title="Autoplay" desc="When your queue ends, keep playing similar music.">
                  <Toggle checked={settings.autoplay} onChange={set("autoplay")} label="Autoplay" />
                </Row>
                <Row icon="shuffle" title="Slip-ins" desc="Songs you mark with “Slip into my listening” play now and then between your songs, when they fit what's playing. Your playlist carries on afterwards. Skip them as often as you like.">
                  <label className="select">
                    <select value={settings.slipIns} onChange={(e) => updateSettings({ slipIns: e.target.value as typeof settings.slipIns })} aria-label="How often to slip songs in">
                      <option value="often">Often</option>
                      <option value="sometimes">Sometimes</option>
                      <option value="rare">Rarely</option>
                      <option value="off">Off</option>
                    </select>
                  </label>
                </Row>
              </div>
              <h3 className="set-section">{cloudEnabled ? "Account" : "Profile"}</h3>
              <div className="set-group">
                <AccountRows />
              </div>
              <h3 className="set-section">Recommendations</h3>
              <div className="set-group">
                <Row icon="library" title="Include songs from your library" desc="Recommended for you shows only new songs by default. Turn this on to also get suggestions from songs you already have.">
                  <Toggle checked={settings.recommendLibrary} onChange={set("recommendLibrary")} label="Include songs from your library" />
                </Row>
                <Row
                  icon="sparkle"
                  title="What shapes your suggestions"
                  desc={`${plural(taste.listens.filter(qualified).length, "listen")}, ${plural(Object.keys(taste.likes).length, "like")} and ${plural(Object.keys(taste.saves).length, "playlist save")} recorded on this device. ${learnedSummary(taste)}`}
                />
                <Row icon="close" title="Hidden suggestions" desc={hiddenCount ? `${plural(hiddenCount, "song")} you said you're not interested in.` : "Nothing hidden."}>
                  <button type="button" className="btn sm" disabled={!hiddenCount} onClick={showHiddenRecommendations}>Show again</button>
                </Row>
                <Row icon="sync" title="Reset recommendations" desc="Forget listening, likes and saves as signals, and what was learned. Your library and playlists stay.">
                  <button type="button" className="btn sm" onClick={resetRecommendations}>Reset</button>
                </Row>
              </div>
              <h3 className="set-section">Data</h3>
              <div className="set-group">
                <Row icon="sync" title="Reset app data" desc="Clears playlists, settings and recommendations on this device. Songs you imported from the web stay and come back.">
                  <button type="button" className="btn danger sm" onClick={resetAppData}>Reset</button>
                </Row>
              </div>
            </>
          ) : null}

          {tab === "playback" ? (
            <>
              <h3 className="set-section">Transitions</h3>
              <div className="set-group">
                <Row icon="wave" title="Crossfade" desc={settings.crossfade ? `Songs overlap by ${settings.crossfadeSeconds} seconds.` : "Blend the end of a song into the next one."}>
                  <Toggle checked={settings.crossfade} onChange={set("crossfade")} label="Crossfade" />
                </Row>
                <div className={`set-slider${settings.crossfade ? "" : " off"}`}>
                  <span className="muted small">1s</span>
                  <Slider max={12} step={1} value={settings.crossfadeSeconds} onInput={(v) => updateSettings({ crossfadeSeconds: Math.max(1, Math.round(v)) })} label="Crossfade duration" format={fmtSec} disabled={!settings.crossfade} />
                  <span className="muted small">12s</span>
                </div>
              </div>
              <h3 className="set-section">Sound</h3>
              <div className="set-group">
                <Row icon="sliders" title="Normalize volume" desc="Keep loudness consistent between songs.">
                  <Toggle checked={settings.normalize} onChange={set("normalize")} label="Normalize volume" />
                </Row>
              </div>
              <ToneControls />
            </>
          ) : null}

          {tab === "appearance" ? (
            <>
              <h3 className="set-section">Theme</h3>
              <div className="theme-grid" role="radiogroup" aria-label="Theme">
                {themes.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={settings.theme === t.id}
                    className={`theme-card${settings.theme === t.id ? " on" : ""}`}
                    style={{ "--s1": t.swatch[0], "--s2": t.swatch[1], "--s3": t.swatch[2] } as CSSProperties}
                    onClick={() => updateSettings({ theme: t.id })}
                  >
                    <span className="theme-preview">
                      <i />
                      <b />
                      <em />
                    </span>
                    <strong>{t.name}</strong>
                    <small>{t.note}</small>
                    {settings.theme === t.id ? <Icon name="checkCircle" size={20} className="theme-check" /> : null}
                  </button>
                ))}
              </div>
              <h3 className="set-section">Layout & motion</h3>
              <div className="set-group">
                <Row icon="list" title="Compact song rows" desc="Fit more songs on screen.">
                  <Toggle checked={settings.compact} onChange={set("compact")} label="Compact song rows" />
                </Row>
                <Row icon="sparkle" title="Reduce motion" desc="Turn off animated transitions and the artwork pulse.">
                  <Toggle checked={settings.reduceMotion} onChange={set("reduceMotion")} label="Reduce motion" />
                </Row>
              </div>
            </>
          ) : null}

          {tab === "server" ? (
            <>
              <h3 className="set-section">Connection</h3>
              <div className="set-group">
                <Row
                  icon="server"
                  title="Music server"
                  desc={<><span className={`status-orb sm ${status}`} /> {status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : "Offline"} · This computer ({location.host})</>}
                >
                  {status === "offline" ? (
                    <button type="button" className="btn primary" onClick={() => void connect({ announce: true })}>Connect</button>
                  ) : (
                    <button type="button" className="btn" disabled={status === "connecting"} onClick={disconnect}>Disconnect</button>
                  )}
                </Row>
              </div>
              <h3 className="set-section">This device</h3>
              <div className="set-group">
                <Row icon="download" title="Keep songs on this device" desc="Saved songs are kept here as files so they play without the server. Off: they stream through the server each time.">
                  <select className="input sm" value={settings.downloadMode} onChange={(e) => updateSettings({ downloadMode: e.target.value as Settings["downloadMode"] })} aria-label="Keep songs on this device">
                    <option value="verified_file_cache">Keep a copy</option>
                    <option value="stream_only">Stream only</option>
                  </select>
                </Row>
              </div>
            </>
          ) : null}

          {tab === "shortcuts" ? (
            <>
              <h3 className="set-section">Keyboard shortcuts</h3>
              <div className="set-group shortcuts">
                {shortcuts.map(([keys, label]) => (
                  <div key={label} className="shortcut">
                    <span>{label}</span>
                    <span className="keys">{keys.split("  /  ").map((k) => <kbd key={k} className="kbd">{k}</kbd>)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}
