# Agent checkpoint — Slopify

Updated 2026-10-11.

## Request

- **Done:** the remaster/redesign of the old Resonance Electron UI as a React/Vite web app (Sol verified it).
- **Current:** rename the UI to "Slopify" (done). Then add real song import whose UX matches Resonance's "Import from Web" dialog. Backend changes are allowed.
- **Roles:** GPT-6.1-Sol does all compile/build checks, testing, and bug finding. Claude implements.

## Import work (uncommitted, branch `t3/659b8828`)

### Backend: `server/api.mjs`

A Vite plugin (dev and preview) that reuses Resonance's provider modules, copied unchanged into `server/providers/*.cjs`.

| Route | Purpose |
|---|---|
| `GET /api/health` | Service check |
| `GET /api/library` | List imported songs |
| `DELETE /api/library/:id` | Delete an imported song |
| `GET /api/media/:id` | Serve audio, with Range support |
| `GET /api/artwork/:id` | Serve cover art |
| `POST /api/import/resolve` | NDJSON. Searches all providers, or inspects a link |
| `POST /api/import/start` | NDJSON. Downloads, tags, and saves to the library |
| `POST /api/import/preview` | Prepares a 30 s preview |
| `GET /api/import/preview/:token` | Serves the preview |

- Data lives in `data/` (git-ignored). `SLOPIFY_DATA_DIR` overrides the location.

### Client

- **`src/state/importer.ts`** (separate store) handles:
  - the NDJSON client
  - resolve with 450 ms auto-resolve for complete links
  - selection
  - single and playlist import, with fallback candidates × 3 attempts
  - a playlist named after the source playlist (created or topped up)
  - the transfer toast (Cancel action; progress of -1 shows as indeterminate)
  - 30 s previews that pause and resume the main player
  - `syncServerLibrary()` at startup and `addServerTrack()`
- **Server tracks:**
  - ids are `srv_<serverId>`
  - `storage: "files"`, with `mediaUrl`, `serverId`, and `sourceUrl`
  - the album is `al_srv_<id>`, with `artworkUrl`
  - they persist through the existing catalog patch
  - hydration drops songs whose files are gone
- **`actions.ts`:**
  - `engineTrack` uses `fileUrl ?? mediaUrl`
  - `deleteFromDevice` deletes the server copy after 15 s (Undo cancels; `pagehide` flushes)
  - the mock `importCandidate` was removed
- **`ImportModal.tsx`** was rewritten:
  - "Import from Web" title, with a "Link or music search" input
  - Audio/Video toggle; video is disabled for Spotify/SoundCloud links
  - a provider pill and per-provider sections for search results
  - radios for single sources, checkboxes and "Download N songs" for playlists
  - preview buttons and an "Upload to server" toggle (mock server flag)
  - status line with Cancel; errors shown as "message (stage)"
  - Choose files / drag-and-drop kept
- Artwork: `Art` takes `image`, and the views pass `album.artworkUrl`.

## Commands

- PowerShell: `npm.cmd run typecheck`, then `npm.cmd run build`. A Vite `spawn EPERM` failure is a sandbox issue; retry with the permitted escalation.
- **Dev server:** the user's server is http://127.0.0.1:5199. It was restarted 2026-10-11 so the import API mounts: `node node_modules\vite\bin\vite.js --port 5199 --strictPort --host 127.0.0.1`, hidden, PID 31504. Logs are in `%TEMP%\slopify-5199.{out,err}.log`.
- **QA:** use a separate snapshot and port. Don't kill 5199.
- **Snapshot copy:** `robocopy <src> <dst> /E /XD "<src>\node_modules" "<src>\data" "<src>\dist" "<src>\.git" /XF *.tsbuildinfo`, then junction `node_modules`. Use full paths in `/XD`: a bare `data` also drops `src/data`, which broke round 1. Check that the `src` file counts match.
- **Round 2 snapshot:** `C:\Users\daz\.t3\qa-snapshots\slopify-import-r2`, QA port 5200.

## Known limits / risks

- Spotify search depends on the third-party `debridvault.elfhosted.com`, as in Resonance.
- Provider scraping (YouTube/SoundCloud) can break or rate-limit, so network-dependent QA may be flaky.
- "Upload to server" only marks the song as uploaded in the mock server.

## QA status

- **r1:** the snapshot was missing `src/data`, and there was a `SourceTrack.provider` type error. Both fixed.
- **r2:** the gate passed and most of the flows passed. Two bugs, both fixed:
  - main playback overlapped a preview that was still loading
  - single-source links had no preview button
- **r3:** the backend checks passed; browser automation timed out.
- **r4:** the browser recheck passed:
  - both fixes
  - the duplicate toast
  - seek
  - delete/Undo, including the delayed server delete
  - playlist import, including the top-up
  - local files
  
  Sol's verdict was "good enough to hand to the user".
- **Feedback round** (provider tabs as separate lists, video playback, play-bar desync):
  - **r5/r6:** `import.meta.hot.decline()` failed typecheck and is a no-op in Vite. Replaced it with accept-and-reload in stateful modules.
  - **r7:** tabs, video (panel, full player, fullscreen), play-state sync and HMR reload passed. One bug: a preview kept playing after switching tabs. Fixed in `setProviderFocus`.
  - **Spotify (found by me):** review-flagged matches couldn't be selected. Replaced `canAutoSelect` with `isDownloadable`.
  - **r8** (snapshot `slopify-import-r8`): both fixes passed, covering Spotify search, track link and playlist, plus the YouTube/SoundCloud regression. Verdict: good enough.

## Next

Waiting on the user's feedback. Committing or opening a PR only happens if the user asks.
