import { useState, type CSSProperties } from "react";
import { installUpdate, useDesktopUpdates } from "../state/desktop";
import { Icon } from "./Icon";

/** The desktop app's update, at the top right: downloading, installing, or ready to restart. Hidden in a browser. */
export function UpdateBanner() {
  const u = useDesktopUpdates();
  /** The banner closed by hand; a new one (another stage or version) shows again. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!u?.available) return null;
  const offer = u.status === "ready" || (u.portable && u.status === "available");
  if (!offer && u.status !== "downloading" && u.status !== "installing") return null;
  const key = `${u.status}:${u.available}`;
  if (dismissed === key) return null;

  const title = u.status === "installing" ? `Installing Slopify ${u.available}` : u.status === "downloading" ? `Downloading Slopify ${u.available}` : `Slopify ${u.available} is ready`;
  const detail = u.status === "installing" ? "Slopify will reopen in a moment."
    : u.status === "downloading" ? `${u.progress}%`
    : u.portable ? "Download it to update this copy."
    : "Restart to update, or it installs next time Slopify starts.";
  return (
    <div className="toast update-banner" role="status" aria-live="polite">
      <Icon name={u.status === "ready" || u.status === "installing" ? "sync" : "download"} size={20} className="toast-icon" />
      <div className="toast-body">
        <strong>{title}</strong>
        <small>{detail}</small>
        {u.status === "downloading" || u.status === "installing" ? (
          <span className={`toast-progress${u.status === "installing" ? " indeterminate" : ""}`}><i style={{ "--p": u.progress / 100 } as CSSProperties} /></span>
        ) : null}
      </div>
      {offer ? <button type="button" className="text-btn" onClick={installUpdate}>{u.portable ? "Download" : "Restart"}</button> : null}
      {u.status !== "installing" ? (
        <button type="button" className="icon-btn sm" onClick={() => setDismissed(key)} aria-label="Dismiss">
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </div>
  );
}
