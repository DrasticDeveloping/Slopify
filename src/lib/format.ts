export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "–:––";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export function formatLongDuration(seconds: number) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unit]}`;
}

export function formatCount(n: number) {
  return new Intl.NumberFormat("en", { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function formatAdded(ts: number) {
  const days = Math.round((ts - Date.now()) / 86_400_000);
  if (days > -1) return "Today";
  if (days > -7) return rtf.format(days, "day");
  if (days > -30) return rtf.format(Math.round(days / 7), "week");
  return new Date(ts).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
}

export function plural(n: number, word: string, many = `${word}s`) {
  return `${n.toLocaleString("en")} ${n === 1 ? word : many}`;
}

export function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
