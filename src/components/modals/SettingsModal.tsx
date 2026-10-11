import { useState, type CSSProperties, type ReactNode } from "react";
import { setServerStatus, updateSettings } from "../../state/actions";
import { resetDemo, useStore, type Settings, type SettingsTab, type Theme } from "../../state/store";
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

const shortcuts: Array<[string, string]> = [
  ["Space", "Play / pause"],
  ["Ctrl →  /  Ctrl ←", "Next / previous song"],
  ["→  /  ←", "Seek 5 seconds"],
  ["Ctrl ↑  /  Ctrl ↓", "Volume up / down"],
  ["M", "Mute"],
  ["L", "Like current song"],
  ["S", "Shuffle"],
  ["R", "Cycle repeat"],
  ["Q", "Toggle queue"],
  ["F", "Full screen player"],
  ["Ctrl K  /  /", "Search"],
  ["Alt ←  /  Alt →", "Back / forward"],
  ["Ctrl ,", "Settings"],
  ["Esc", "Close dialogs and menus"],
];

export function SettingsModal({ initial }: { initial?: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(initial ?? "general");
  const settings = useStore((s) => s.settings);
  const status = useStore((s) => s.server.status);
  const [url, setUrl] = useState(settings.serverUrl);
  const set = <K extends keyof Settings>(key: K) => (value: Settings[K]) => updateSettings({ [key]: value } as Partial<Settings>);
  const fmtSec = (v: number) => `${Math.round(v)} seconds`;

  return (
    <Shell title="Settings" subtitle="Saved on this device" size="xl" className="settings-modal">
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
              <h3 className="set-section">Desktop</h3>
              <div className="set-group">
                <Row icon="bolt" title="Keep playing in the background" desc="Music keeps going in the system tray when the window closes.">
                  <Toggle checked={settings.runInBackground} onChange={set("runInBackground")} label="Keep playing in the background" />
                </Row>
                <Row icon="discord" title="Discord Rich Presence" desc="Show what you're listening to on your Discord profile.">
                  <Toggle checked={settings.discord} onChange={set("discord")} label="Discord Rich Presence" />
                </Row>
                <Row icon="sparkle" title="Autoplay" desc="When your queue ends, keep playing similar music.">
                  <Toggle checked={settings.autoplay} onChange={set("autoplay")} label="Autoplay" />
                </Row>
              </div>
              <h3 className="set-section">Profile</h3>
              <div className="set-group">
                <Row icon="user" title="Display name" desc="Shown to friends in Listen Along rooms.">
                  <input className="input sm" value={settings.profileName} maxLength={24} onChange={(e) => updateSettings({ profileName: e.target.value || "You" })} aria-label="Display name" />
                </Row>
              </div>
              <h3 className="set-section">Demo</h3>
              <div className="set-group">
                <Row icon="sync" title="Reset demo data" desc="Restores the sample library, playlists, and settings.">
                  <button type="button" className="btn danger sm" onClick={resetDemo}>Reset</button>
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
                <Row icon="server" title="Music server" desc={<><span className={`status-orb sm ${status}`} /> {status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : "Offline"}</>} column>
                  <form
                    className="url-row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      updateSettings({ serverUrl: url.trim() || settings.serverUrl });
                      setServerStatus("connected");
                    }}
                  >
                    <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Server URL" spellCheck={false} />
                    {status === "connected" && url === settings.serverUrl ? (
                      <button type="button" className="btn" onClick={() => setServerStatus("offline")}>Disconnect</button>
                    ) : (
                      <button type="submit" className="btn primary" disabled={status === "connecting"}>{status === "connecting" ? "Connecting…" : "Connect"}</button>
                    )}
                  </form>
                </Row>
              </div>
              <h3 className="set-section">Transfers</h3>
              <div className="set-group">
                <Row icon="upload" title="Uploads" desc="How imports reach the server.">
                  <select className="input sm" value={settings.uploadMode} onChange={(e) => updateSettings({ uploadMode: e.target.value as Settings["uploadMode"] })} aria-label="Upload mode">
                    <option value="local_file">Local files</option>
                    <option value="link">Links only</option>
                    <option value="off">Off</option>
                  </select>
                </Row>
                <Row icon="download" title="Downloads" desc="Keep verified copies on this device, or stream only.">
                  <select className="input sm" value={settings.downloadMode} onChange={(e) => updateSettings({ downloadMode: e.target.value as Settings["downloadMode"] })} aria-label="Download mode">
                    <option value="verified_file_cache">Offline cache</option>
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
