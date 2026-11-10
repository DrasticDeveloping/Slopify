import { useState } from "react";
import { closeModal, ask } from "../../state/actions";
import { signIn, useAccount } from "../../state/cloud";
import { copyText, sendShared, sharePlaylist, shareLink, shareOf, stopSharing, useSocial } from "../../state/social";
import { useStore } from "../../state/store";
import { PlaylistArt } from "../Artwork";
import { Icon } from "../Icon";
import { plural } from "../../lib/format";
import { Shell, Toggle } from "./Shell";

/** Share a playlist: its link, whether friends see it on your profile, sending it to friends, and stopping. */
export function ShareModal({ id }: { id: string }) {
  const account = useAccount();
  const social = useSocial();
  const playlist = useStore((s) => s.playlists.find((p) => p.id === id));
  const share = shareOf(id, social);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  if (!playlist) return null;
  const title = `Share “${playlist.name}”`;
  // The dialog shows what's being shared, washed in its colour.
  const look = { art: <PlaylistArt playlist={playlist} />, tint: playlist.palette.b };

  if (account.status !== "signedIn") {
    return (
      <Shell title={title} subtitle={`Playlist · ${plural(playlist.trackIds.length, "song")}`} {...look} size="sm">
        <ul className="feature-rows">
          <li><span className="feature-icon"><Icon name="link" size={17} /></span><span><strong>One link, always current</strong><small>Anyone signed in to Slopify can play and follow it.</small></span></li>
          <li><span className="feature-icon"><Icon name="user" size={17} /></span><span><strong>On your profile</strong><small>Friends can find it there, if you choose.</small></span></li>
          <li><span className="feature-icon"><Icon name="users" size={17} /></span><span><strong>Send it to friends</strong><small>It lands in their Slopify, ready to play.</small></span></li>
        </ul>
        {account.status === "disabled" ? (
          <p className="muted small">Sharing needs Slopify's online service, which this copy of Slopify isn't set up with.</p>
        ) : (
          <div className="form-actions">
            <button type="button" className="btn primary wide" disabled={account.status === "loading"} onClick={signIn}><Icon name="user" size={17} />Sign in to share</button>
          </div>
        )}
      </Shell>
    );
  }

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  if (!share) {
    return (
      <Shell title={title} subtitle="Anyone signed in to Slopify with the link can play and follow it." {...look} size="sm">
        <ul className="feature-rows">
          <li><span className="feature-icon"><Icon name="sync" size={17} /></span><span><strong>Always up to date</strong><small>Changes you make here show for everyone.</small></span></li>
          <li><span className="feature-icon"><Icon name="user" size={17} /></span><span><strong>Yours to change</strong><small>Others can follow it, or save their own copy.</small></span></li>
          <li><span className="feature-icon"><Icon name="folder" size={17} /></span><span><strong>Device files stay private</strong><small>Songs that are only files on this device aren't shared.</small></span></li>
        </ul>
        <div className="form-actions">
          <button type="button" className="btn" onClick={closeModal}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !social}
            onClick={() => void run(async () => {
              const link = await sharePlaylist(id, true);
              if (link) await copyText(link);
            })}
          >
            {busy ? <><span className="spinner" />Sharing</> : <><Icon name="link" size={17} />Share and copy link</>}
          </button>
        </div>
      </Shell>
    );
  }

  const link = shareLink(share.shareId);
  const friends = social?.friends ?? [];
  return (
    <Shell title={title} subtitle={<><span className="live-dot share-live" />Shared · updates as you change it</>} {...look} size="sm">
      <div className="share-link">
        <input className="input mono sm" value={link} readOnly aria-label="Playlist link" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn sm" onClick={() => void copyText(link)}><Icon name="copy" size={16} />Copy</button>
      </div>
      <p className="muted small">People paste it into Slopify's search bar to open it.</p>

      <div className="share-row">
        <span>
          <strong>Show on my profile</strong>
          <small className="muted">Friends can find it on your profile.</small>
        </span>
        <Toggle checked={share.onProfile} disabled={busy} label="Show on my profile" onChange={(on) => void run(() => sharePlaylist(id, on))} />
      </div>

      <h3 className="mini-head">Send to friends</h3>
      {friends.length ? (
        <>
          <ul className="share-friends">
            {friends.map((f) => (
              <li key={f.id}>
                <label>
                  <input type="checkbox" checked={picked.includes(f.id)} onChange={() => setPicked(picked.includes(f.id) ? picked.filter((x) => x !== f.id) : [...picked, f.id])} />
                  <span>{f.displayName}</span>
                </label>
              </li>
            ))}
          </ul>
          <button type="button" className="btn sm" disabled={busy || !picked.length} onClick={() => void run(async () => {
            await sendShared(share.shareId, picked);
            setPicked([]);
          })}>
            <Icon name="users" size={16} />Send{picked.length ? ` to ${picked.length}` : ""}
          </button>
        </>
      ) : <p className="muted small">Add friends on the Friends page to send them playlists.</p>}

      <div className="form-actions">
        <button
          type="button"
          className="btn danger"
          disabled={busy}
          onClick={async () => {
            const ok = await ask({ title: `Stop sharing “${playlist.name}”?`, body: "Its link stops working, and it's removed for everyone following it. Your playlist stays.", confirmLabel: "Stop sharing", danger: true, icon: "link" });
            if (!ok) return;
            void run(async () => {
              await stopSharing(id);
              closeModal();
            });
          }}
        >
          Stop sharing
        </button>
        <button type="button" className="btn primary" onClick={closeModal}>Done</button>
      </div>
    </Shell>
  );
}
