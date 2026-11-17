import { useState, type CSSProperties } from "react";
import { useDayChange } from "../lib/hooks";
import { baseVersion, builtAt, dayOf, isNightly, plural, whenBuilt } from "../lib/releases";
import { openModal } from "../state/actions";
import { installUpdate, isMacDesktop, useDesktopUpdates } from "../state/desktop";
import { useStore } from "../state/store";
import { Icon } from "./Icon";

/**
 * The desktop app's update, at the top right: downloading, installing, or ready to
 * restart. It stays the same size however much changed; the changes themselves are
 * in What's new (modals/WhatsNew.tsx). Hidden in a browser.
 */
export function UpdateBanner() {
  const u = useDesktopUpdates();
  const playing = useStore((s) => s.isPlaying);
  /** The banner closed by hand; a new one (another stage or version) shows again. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  useDayChange(Boolean(u?.available));
  if (!u?.available) return null;
  const offer = u.status === "ready" || (u.portable && u.status === "available");
  const downloading = u.status === "downloading";
  const installing = u.status === "installing";
  if (!offer && !downloading && !installing) return null;
  const key = `${u.status}:${u.available}`;
  if (dismissed === key) return null;

  const nightly = isNightly(u.available);
  const built = builtAt(u.available, u.releaseDate);
  const eyebrow = installing ? "Installing" : downloading ? "Downloading" : u.status === "available" ? "Update available" : "Update ready";
  const title = nightly ? "New nightly build" : `Slopify ${u.available}`;
  const meta = nightly
    ? `${baseVersion(u.available)}${built ? ` · built ${whenBuilt(built)}` : ""}`
    : built ? `Released ${dayOf(built)}` : null;
  const log = u.changelog && u.changelog.total > 0 ? u.changelog : null;
  const count = log ? `${log.total}${log.complete ? "" : "+"}` : "";

  return (
    <div className={`update-banner${offer ? "" : " compact"}`}>
      <div className="ub-top">
        <span className="ub-badge" aria-hidden="true">
          <Icon name={installing ? "sync" : downloading ? "download" : "sparkleFill"} size={19} className={installing ? "spin" : undefined} />
        </span>
        <div className="ub-head" role="status" aria-live="polite">
          <span className="ub-eyebrow">{eyebrow}{nightly ? <span className="ub-chip">Nightly</span> : null}</span>
          <strong className="ub-title">{title}</strong>
          {offer ? (meta ? <span className="ub-meta">{meta}</span> : null) : (
            <>
              <span
                className={`ub-progress${installing ? " shimmer" : ""}`}
                role="progressbar"
                aria-label={installing ? "Installing" : "Downloading"}
                aria-valuemin={installing ? undefined : 0}
                aria-valuemax={installing ? undefined : 100}
                aria-valuenow={installing ? undefined : u.progress}
              >
                {installing ? null : <i style={{ "--p": u.progress / 100 } as CSSProperties} />}
              </span>
              <span className="ub-row">
                <span>{installing ? "Slopify will reopen in a moment" : "Keeps going if you hide this"}</span>
                {downloading ? <span>{u.progress}%</span> : null}
              </span>
            </>
          )}
        </div>
        {installing ? null : (
          <button
            type="button"
            className="icon-btn sm ub-close"
            onClick={() => setDismissed(key)}
            aria-label={downloading ? "Hide (the download continues)" : u.portable ? "Dismiss" : "Dismiss (it installs next time Slopify opens)"}
            title={downloading ? "Hide" : "Later"}
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      {offer ? (
        <>
          <div className="ub-actions">
            {log ? (
              <button type="button" className="btn sm" aria-haspopup="dialog" aria-label={`What's new: ${log.complete ? "" : "at least "}${plural(log.total, "change")}`} onClick={() => openModal({ type: "whatsNew" })}>
                What’s new <span className="ub-count" aria-hidden="true">{count}</span>
              </button>
            ) : u.releaseUrl ? (
              <a className="btn sm" href={u.releaseUrl} target="_blank" rel="noreferrer">
                Release notes <Icon name="external" size={15} />
              </a>
            ) : null}
            <button type="button" className="btn sm primary ub-go" onClick={installUpdate}>
              {u.portable ? <>Open download page <Icon name="external" size={15} /></> : <><Icon name="sync" size={15} />Restart to update</>}
            </button>
          </div>
          <p className={`ub-foot${playing && !u.portable ? " warn" : ""}`}>
            {u.portable ? (isMacDesktop ? "This copy can't replace itself where it is, so download the new one." : "This copy is portable, so download the new EXE.")
              : playing ? "Restarting stops the music. Or it installs next time."
              : "Or it installs next time Slopify opens."}
          </p>
        </>
      ) : null}
    </div>
  );
}
