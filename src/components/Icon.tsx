import type { CSSProperties, JSX } from "react";

const paths: Record<string, JSX.Element> = {
  home: <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z" />,
  homeFill: <path className="f" d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
  library: <><rect x="4" y="4" width="4" height="16" rx="1" /><rect x="10" y="4" width="4" height="16" rx="1" /><path d="m16.5 5 3.5 14" /></>,
  playlists: <><path d="M4 6h11M4 11h11M4 16h7" /><circle cx="17" cy="17" r="2.6" /><path d="M19.6 17V7.5L15 8.6" /></>,
  storage: <><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><path d="M3.5 14h17" /><circle cx="16.5" cy="16.5" r=".6" className="f" /></>,
  server: <><rect x="3.5" y="4" width="17" height="7" rx="2" /><rect x="3.5" y="13" width="17" height="7" rx="2" /><path d="M7.5 7.5h.01M7.5 16.5h.01M11 7.5h6M11 16.5h6" /></>,
  history: <><path d="M4 4v5h5" /><path d="M5.6 8.6A7.5 7.5 0 1 1 4.5 13" /><path d="M12 8v4.2l2.8 1.8" /></>,
  stats: <><path d="M5 20V10M10 20V4M15 20v-7M20 20V8" /></>,
  play: <path className="f" d="M7.5 4.8v14.4a1 1 0 0 0 1.53.85l11.2-7.2a1 1 0 0 0 0-1.7L9.03 3.95A1 1 0 0 0 7.5 4.8Z" />,
  pause: <><rect className="f" x="6" y="4.5" width="4.4" height="15" rx="1.4" /><rect className="f" x="13.6" y="4.5" width="4.4" height="15" rx="1.4" /></>,
  next: <><path className="f" d="M5 5.6v12.8a.8.8 0 0 0 1.24.67l9.4-6.4a.8.8 0 0 0 0-1.33l-9.4-6.4A.8.8 0 0 0 5 5.6Z" /><path d="M19 5v14" strokeWidth="2.4" /></>,
  prev: <><path className="f" d="M19 5.6v12.8a.8.8 0 0 1-1.24.67l-9.4-6.4a.8.8 0 0 1 0-1.33l9.4-6.4A.8.8 0 0 1 19 5.6Z" /><path d="M5 5v14" strokeWidth="2.4" /></>,
  shuffle: <><path d="M3 7h2.6a5 5 0 0 1 4 2l4.8 6a5 5 0 0 0 4 2H21" /><path d="m18 14 3 3-3 3" /><path d="M3 17h2.6a5 5 0 0 0 4-2l4.8-6a5 5 0 0 1 4-2H21" /><path d="m18 4 3 3-3 3" /></>,
  repeat: <><path d="m17 3 3 3-3 3" /><path d="M4 11.5V10a4 4 0 0 1 4-4h12" /><path d="m7 21-3-3 3-3" /><path d="M20 12.5V14a4 4 0 0 1-4 4H4" /></>,
  heart: <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z" />,
  heartFill: <path className="f" d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  checkCircle: <><circle cx="12" cy="12" r="8.5" className="f" /><path d="m8 12.3 2.8 2.8L16.2 9.6" stroke="var(--on-accent, #000)" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  more: <><circle cx="5.5" cy="12" r="1.5" className="f" /><circle cx="12" cy="12" r="1.5" className="f" /><circle cx="18.5" cy="12" r="1.5" className="f" /></>,
  chevronLeft: <path d="m14.5 5-7 7 7 7" />,
  chevronRight: <path d="m9.5 5 7 7-7 7" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m6 15 6-6 6 6" />,
  queue: <><path d="M4 6h12M4 11h12M4 16h7" /><path className="f" d="M15 14.2v5.6a.6.6 0 0 0 .9.5l4.4-2.8a.6.6 0 0 0 0-1l-4.4-2.8a.6.6 0 0 0-.9.5Z" /></>,
  nowPlaying: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M10 9.5v5l4-2.5z" className="f" /></>,
  volume: <><path className="f" d="M4 9.5v5h3.6L12.5 19V5L7.6 9.5z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></>,
  volumeLow: <><path className="f" d="M4 9.5v5h3.6L12.5 19V5L7.6 9.5z" /><path d="M15.5 9a4 4 0 0 1 0 6" /></>,
  volumeMute: <><path className="f" d="M4 9.5v5h3.6L12.5 19V5L7.6 9.5z" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></>,
  expand: <path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5" />,
  collapse: <path d="M10 4v6H4M14 20v-6h6M4 10l6-6M20 14l-6 6" />,
  download: <><path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5" /><path d="M5 19.5h14" /></>,
  downloaded: <><circle cx="12" cy="12" r="9" className="f" /><path d="M12 7.5v7m0 0 3-3m-3 3-3-3" stroke="var(--on-accent, #000)" /></>,
  upload: <><path d="M12 15V4m0 0 4.5 4.5M12 4 7.5 8.5" /><path d="M5 19.5h14" /></>,
  sync: <><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" /><path d="M20 20v-4h-4" /></>,
  trash: <><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" /></>,
  edit: <path d="m4 16.5-.5 4 4-.5L18.8 8.7l-3.5-3.5L4 16.5ZM13.8 6.7l3.5 3.5" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.54V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.54-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.54V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.54 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" /></>,
  scissors: <><circle cx="6" cy="7" r="2.6" /><circle cx="6" cy="17" r="2.6" /><path d="m8.2 8.5 11.3 8M8.2 15.5l11.3-8" /></>,
  users: <><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19c.6-3.3 2.6-5 5.5-5s4.9 1.7 5.5 5" /><circle cx="16.5" cy="8" r="2.4" /><path d="M15 13.2c.5-.2 1-.3 1.5-.3 2 0 3.5 1.2 4 3.6" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2.2" /><path d="M15.5 8.5V6.2a1.7 1.7 0 0 0-1.7-1.7H6.2a1.7 1.7 0 0 0-1.7 1.7v7.6a1.7 1.7 0 0 0 1.7 1.7h2.3" /></>,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  video: <><rect x="3.5" y="6" width="12.5" height="12" rx="2.5" /><path d="m16 10.5 4.5-2.8v8.6L16 13.5" /></>,
  music: <><path d="M9 18V6.5l10-2V16" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></>,
  sidebar: <><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M9.5 4.5v15" /></>,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.6 3.5 5.5 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.5-3.5-8.5S9.6 6.1 12 3.5Z" /></>,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14h9" /></>,
  snooze: <><circle cx="12" cy="13" r="7.5" /><path d="M4.5 5.5 7 3.5M19.5 5.5 17 3.5M9.8 10.5h4.4l-4.4 5h4.4" /></>,
  palette: <><path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.6 0-1.3-1.1-1.6-1.1-2.7 0-.9.7-1.6 1.6-1.6h2a4.2 4.2 0 0 0 4.2-4.2c0-3.9-3.8-6.9-8.5-6.9Z" /><circle cx="7.8" cy="11" r="1.1" className="f" /><circle cx="10.5" cy="7.5" r="1.1" className="f" /><circle cx="15" cy="7.8" r="1.1" className="f" /></>,
  sliders: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  bolt: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />,
  discord: <path className="f" d="M18.6 6.3A15 15 0 0 0 15 5.2l-.4.9a13.7 13.7 0 0 0-5.2 0L9 5.2a15 15 0 0 0-3.7 1.1C3 9.8 2.3 13.2 2.6 16.6a15 15 0 0 0 4.5 2.3l1-1.5a9.6 9.6 0 0 1-1.6-.8l.4-.3a10.7 10.7 0 0 0 10.2 0l.4.3-1.6.8 1 1.5a15 15 0 0 0 4.5-2.3c.4-3.9-.6-7.3-2.8-10.3ZM9.3 14.5c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.7.8 1.6 1.8c0 1-.7 1.8-1.6 1.8Zm5.4 0c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.7.8 1.6 1.8c0 1-.7 1.8-1.6 1.8Z" />,
  speed: <><path d="M5 18a8.5 8.5 0 1 1 14 0" /><path d="m12 13.5 3.5-4.5" /></>,
  wave: <path d="M3 12h2l2-5 3 10 3-14 3 12 2-5 1 2h2" />,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></>,
  user: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.8-3.8 3.4-5.8 7-5.8s6.2 2 7 5.8" /></>,
  sort: <path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3" />,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
  list: <path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />,
  smartShuffle: <><path d="M3 7h2.6a5 5 0 0 1 4 2l4.8 6a5 5 0 0 0 4 2H21" /><path d="m18 14 3 3-3 3" /><path d="M3 17h2.6a5 5 0 0 0 4-2l1.1-1.4" /><path d="M17.5 2.5c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5Z" className="f" /></>,
  sparkle: <path d="M12 3.5c.6 4.3 2.2 5.9 6.5 6.5-4.3.6-5.9 2.2-6.5 6.5-.6-4.3-2.2-5.9-6.5-6.5 4.3-.6 5.9-2.2 6.5-6.5ZM18.5 15c.3 1.8 1 2.5 2.8 2.8-1.8.3-2.5 1-2.8 2.8-.3-1.8-1-2.5-2.8-2.8 1.8-.3 2.5-1 2.8-2.8Z" />,
  help: <><circle cx="12" cy="12" r="8.5" /><path d="M9.7 9.5a2.4 2.4 0 0 1 4.6.9c0 1.6-2.3 2-2.3 3.4M12 16.8h.01" /></>,
  radio: <><circle cx="12" cy="12" r="2" /><path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.4 18.6a9.3 9.3 0 0 1 0-13.2M18.6 5.4a9.3 9.3 0 0 1 0 13.2" /></>,
  logout: <><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M10 16.5 5.5 12 10 7.5M5.5 12H15" /></>,
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20, className, style, title }: { name: IconName | string; size?: number; className?: string; style?: CSSProperties; title?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      style={style}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {paths[name] ?? paths.music}
    </svg>
  );
}

/** Animated "now playing" equalizer glyph. */
export function Bars({ paused }: { paused?: boolean }) {
  return (
    <span className={`eq${paused ? " paused" : ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
