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

## Round: loop / video UX / header overlap (branch `t3/3a3eb1f3`, uncommitted)

User feedback: (1) loop button doesn't work, (2) better video viewing UX, (3) full-player header covered by art.

- **Loop:** Sol found the engine loops correctly; the first click set Repeat *all*, so the song moved on. `cycleRepeat` is now Off → One → All, with a single updating toast.
- **Header:** the art was sized by `100dvh - 440px` and overflowed the centred stage. Now `.fp-art-slot` (container query units), `safe center`, and `.fp-head` z-index 2.
- **Video mode** (`FullPlayer.tsx`, `video-mode`): full-bleed video, overlay controls that auto-hide (`useIdle`), click = play/pause, double-click / F = full screen on `document.documentElement` (`toggleFullscreen` in `VideoSurface.tsx`), paused glyph, overlay queue.
- **QA r1** failed the gate: `src/data` was missing. A bare `data` line in `.gitignore` also ignored `src/data`, so `library.ts` and `types.ts` were never committed and master doesn't build from a clean checkout. Fixed: the rule is now `/data`, and the files were copied from `t3-659b8828`.
- **QA r2:** snapshot `C:\Users\daz\.t3\qa-snapshots\slopify-video-r2`, server http://127.0.0.1:5202 (PID 10508, `SLOPIFY_DATA_DIR=C:\Users\daz\.t3\qa-snapshots\slopify-video-data`, logs `%TEMP%\slopify-5202.*.log`). `node_modules` is a junction to `t3-659b8828` (the lockfiles differ only in line endings). `tsc -b` may hit TS5033 (tsbuildinfo write denied) in Sol's sandbox; the fallback is `npx.cmd tsc -p tsconfig.json --noEmit`.

- **QA r2** results:
  - The gate passed.
  - Loop and the header passed. The header has a ~1 px overlap when the pulsing art scales past 1; that is ignored, since it sits in the header's padding below its layer.
  - Three P2 bugs, now fixed:
    - Escape in full screen closed the player. It now exits full screen first, in both `FullPlayer` `trap` and the `App` Escape handler.
    - The mobile video queue covered the transport. The queue `bottom` is now 230px on desktop and 300px at ≤680px.
    - The right-panel video collapsed to 0 height at 1280×720. `.np-art` is now `flex: none`.
- **QA r3** (targeted recheck): snapshot `slopify-video-r3`, server 5202 (PID 32920).
  - Passed: the gate, Escape (first press exits full screen, second closes and restores focus), queue clearance at 390×844, 1280×720 and 1366×600, the right-panel video (16:9, opens the player), and the audio header.
  - Each reload logged a font **403**. This comes from the snapshot setup: its `node_modules` junction resolves outside the snapshot root, which Vite's `fs.allow` blocks. It is not an app defect.
  - Sol's verdict: good enough to hand back.

## Next

Done and handed back. Server 5202 (PID 32920) is still serving r3 so the user can try it. Committing or opening a PR only happens if the user asks.

### Audit completed

- 22 findings accepted: 4 P1, 16 P2, 2 P3. Report-only; application source preserved. SHA256 comparison: all 57 source/config/lockfile files match frozen snapshot.
- P1: concurrent import filename overwrite; failed save poisons future library writes; unsynchronized initial library loads detach arrays; unreadable/malformed library treated as empty and overwritten.
- P2 backend: late cancellation leaks/commits imported media; unhandled file stream errors can terminate server; abandoned responses retain readable streams; concurrent same-source preview requests can EEXIST (after preview directory initialized).
- P2 client: failed server deletions resurrect imports; media error advances while paused; shuffle off during out-of-context queued song loses collection cursor; metadata arriving after clip editor initialization leaves zero draft; duration shrinking below saved clip start collapses effective range; hour-formatted clip times rejected; file drop on playlist row reorders its first track; storage scope switches leave hidden selections/incorrect byte total; sub-400ms reload loses unflushed persistence; empty-MIME video extension classified audio; startup library sync can remove current track without reconciling playback; fixed date domain drops new-day stats in a long-lived tab.
- P3: local filename parsing drops title after second delimiter; UTC minute buckets disagree with local play history dates.
- Excluded: normal single-tab cross-playlist drag repro not established; intentional mock services; session-only local file persistence; disabled artist plays sort.
- Gate reviewer: npm.cmd run typecheck passed; npm.cmd run build passed via exact-command approved escalation after spawn EPERM. Normal Vite server HTTP readiness 200; browser title Slopify observed. Browser DOM/console/reload/visual/media end-to-end flows UNVERIFIED.
- Browser blocker raw: "Preview snapshot failed: Preview automation snapshot timed out after 15000ms." twice, then "Preview automation evaluate timed out after 15000ms." Alternate CUA: "Browser is not available: iab", apps/browsers inventory empty. No continuing retry loop.
- Snapshot-only font request received403 due shared dependency junction outside Vite allow-list; do not classify as app defect.
- Isolated executed tests: backend reviewer extracted Library class tests proved concurrent load arrays and save chain poisoning. Parent audit-repros.cjs (in snapshot) executed extracted unmodified functions and confirmed paused error -> next playing, shuffle-off cursor0, collapsed clip60..60, hour parse null, empty-MIME mp4/audio and title suffix loss. Other findings source-proven, not browser-reproduced.
- Review ownership: startup_gate bounded gate, backend_review broad round1, playback_final_review broad round2, targeted_new_findings bounded checks A-D only. Findings-only agents, no source fixes.
- Owned QA server left running PID60172; http://127.0.0.1:5205; working snapshot C:\Users\daz\AppData\Local\Temp\slopify-audit-20261011; launch node.exe node_modules\vite\bin\vite.js --host127.0.0.1 --port5205 --strictPort (arguments separately); isolated SLOPIFY_DATA_DIR; logs gate-server.out.log/gate-server.err.log in snapshot. Existing user server untouched.
- No fixes, commit, push, PR, or publishing requested/performed.

### Audit fixes (implementer, uncommitted, same branch)

- The user asked to fix the findings the implementer agreed with: 20 of 22. Rejected:
  - **#10:** `onError` advances only while `isPlaying`, and pausing clears it.
  - **#17:** `pagehide` calls `flushPersist`.
- **Server:**
  - `api.mjs`: shared-promise `load`; only ENOENT counts as empty, damaged JSON throws; save chain survives failures; `startImport` rolls back files and record on failure or abort; `remove` restores on a failed save; `pipeline` streaming; per-request preview files.
  - `local-import-platform.cjs` `uniqueDestination` claims names with `wx`.
- **Client:**
  - `actions.ts`: `effectiveRange` falls back to the full song; `toggleShuffle` keeps the cursor; unconfirmed server deletes are kept in localStorage (`slopify.unconfirmedServerDeletes`) and retried in `syncServerLibrary`; `importFiles` title split and empty-MIME video.
  - `importer.ts`: sync stops a removed current song and filters order, index and context; `streamCall` shows the server's error message.
  - ClipEditor: h:mm:ss parsing and the late-duration range. TrackList: file drops ignored. Storage: visible-only selection.
  - Local `dayKey`/`todayKey`; per-date `seededHistory` recomputed in History.
- **Note:** another agent briefly edited this worktree (recommendations work) and then reverted itself and moved to its own worktree. Its changes are not here.
- **QA r1 (Sol):**
  - Snapshot `C:\Users\daz\.t3\qa-snapshots\slopify-fixes-r1`.
  - Server http://127.0.0.1:5202, PID 59496 (mine), `SLOPIFY_DATA_DIR=C:\Users\daz\.t3\qa-snapshots\slopify-fixes-data`.
  - taskId clientRequestId `slopify-fixes-qa-r1`.
  - r1 stopped at the gate. The typecheck passed via `npx.cmd tsc -p tsconfig.json --noEmit`; `npm.cmd run build` hit TS5033 (tsbuildinfo write denied, an environment issue).
  - Rerun as `slopify-fixes-qa-r1b`, with instructions to retry using the escalation or else split the build: `vite build --outDir %TEMP%\slopify-fixes-build`.
  - **r1b results:**
    - The gate passed (build ok after the escalation).
    - 19 of 20 passed, plus the smoke checks (reloads ×2, video, R cycle).
    - FAIL #14: plain `123` seconds was rejected. This was already true in the old parser. `parseTime` was rewritten: any number of digits without a colon, under-60 rules after a colon.
  - **Targeted recheck** `slopify-fixes-qa-r2-cliptime`:
    - snapshot `C:\Users\daz\.t3\qa-snapshots\slopify-fixes-r2` (only `ClipEditor.tsx` differs from r1)
    - server 5202, now PID 38900
    - PASSED: typecheck; 12/12 pure-function cases; in the browser, `123` → 2:03, `1:75` is rejected, `0:30` works.
  - All 20 fixes are verified and handed back. 5202 (PID 38900) still serves r2. Commit/PR only if the user asks.

## Recommendations port (2026-10-11)

User request: copy the important parts of the other agent's recommender (worktree `feature-song-recommendations`, uncommitted, read-only for us) into this branch and make it better. The user said Sol can test with the Spotify playlist https://open.spotify.com/playlist/3GFq90TBYHpE9DUuevkEb2.

- New: `src/recommend/{taste,rank,discover}.ts`, `server/recommendations.mjs` (`POST /api/recommendations/related`), `src/components/DiscoveryShelf.tsx`, `docs/recommendations.md` (design and what changed).
- Wired into: engine progress hooks (`engine.ts`), the store (`taste`, `flushPersist`, `PlaybackContext.picks`), `actions.ts` (listening collector, radio, hide, autoplay, mixes, likes/saves), `importer.ts` (discovery Add & play/review), Home, menus, Settings → General → Recommendations, `ImportModal` (matched-upload line), CSS.
- Dropped from the original: the logistic model, AUC/evaluation export, node test files and the genre picker.
- QA r1: snapshot `C:\Users\daz\.t3\qa-snapshots\slopify-recs-r1`, server http://127.0.0.1:5203 (PID 43900, wrapper 61328), `SLOPIFY_DATA_DIR=C:\Users\daz\.t3\qa-snapshots\slopify-recs-data`, logs `%TEMP%\slopify-5203.{out,err}.log`. 5202 (PID 38900) still serves the audit r2 snapshot. 5199 belongs to the user; 5205–5208 belong to other agents.
- QA r1 (Sol): typecheck and build pass; most behaviour passed. Four P2s and one P3 were fixed:
  - ordinary listens now bump `rev`
  - artist-named searches must match the artist
  - `discoveryKey` cleans names for ownership and dedupe
  - radio/autoplay scale personal signals by relevance to the seed
  - hide Undo removes only its own rejection
- Live ListenBrainz returned nothing in r1. The server now uses the lead artist for multi-artist credits, ignores "(feat.)" in titles, and takes the top exact recording match.
- QA r2 (targeted recheck): snapshot `slopify-recs-r2`, server 5203 now PID 47352 (r1's 43900 is stopped), same data dir, logs `%TEMP%\slopify-5203-r2.*.log`.
- QA r2: all r1 fixes verified, and live ListenBrainz suggestions now appear (Katy Perry → Ariana Grande, Olivia Rodrigo). One P2 remained: recent listening could steer radio/autoplay away from the seed. Fixed: seeded modes compare only against the seed. Targeted r3 recheck: snapshot `slopify-recs-r3`, server 5203 now PID 57088 (wrapper 60644), logs `%TEMP%\slopify-5203-r3.*.log`.
- QA r3 (targeted): good enough. Gate passed. Neon Undertow radio now continues with Glass Boulevard (2.421 vs Condensation 0.882); autoplay picks Nightcall Static; Home still shows "Goes with" reasons; the saved-song regression still holds. Not exercised: the end-of-track autoplay transition after this fix (ranking verified only). Handed back; 5203 (PID 57088) is still serving r3. Commit/PR only if the user asks.
- User follow-up: "Recommended for you" must not show library songs by default. The user chose outside-library suggestions. Added the `settings.recommendLibrary` setting (default false). With it off, Home shows DiscoveryShelf titled "Recommended for you" and no separate Discover shelf; with it on, the library shelf shows with "Discover new music" below. The toggle is in Settings → General → Recommendations. Check r4: snapshot `slopify-recs-r4`, server 5203 PID 40868 (wrapper 3740), logs `%TEMP%\slopify-5203-r4.*.log`.
- Check r4: good enough. Default shelf has only outside-library cards (0 matches against 90 catalog songs including 16 imports); the toggle works, persists, and defaults to off when missing; the rest of Home renders. Handed back.
- User follow-up: "it should show way more than 2-4 songs". There were two causes:
  - Only 3 searches ran.
  - MusicBrainz answered 503 after one request, and our 60 s back-off then killed every other artist seed. That's also why r1 saw no artist edges.
- Now: 5+5 seeds, 14 song + 6 artist searches (3 at a time) plus "More from" top-ups, and a shelf of up to 30. The server identifies seeds via ListenBrainz Labs (`acr-lookup` → `recording-search` + `recording-mbid-lookup`), with MusicBrainz only as a fallback (1.5 s spacing, 5–10 s back-off). A direct trace with 5+5 playlist seeds gave all artists "available" in about 7 s.
- Check r5: snapshot `slopify-recs-r5`, server 5203 PID 58464 (wrapper 61128), logs `%TEMP%\slopify-5203-r5.*.log`.
- Check r5: good enough. 13 cards (4 within 3 s, all by 8 s), Find more gave 13 new ones, Add & play worked, no rate limits. Notes:
  - Only 1 seed was in use, because the r1 Reset had cleared the save signals.
  - One SoundCloud source failed on import (`SOUNDCLOUD_NOT_FOUND`), which is provider/importer behaviour.
  - Some artist searches returned no results.
  - Unconfirmed: the first open showed 5 fallback cards.
- Fix: imported songs now count as support 1 (`IMPORT_WEIGHT`); rank subtracts it for "enjoyed" and "fresh". Check r6: snapshot `slopify-recs-r6`, server 5203 PID 58888 (wrapper 37480), logs `%TEMP%\slopify-5203-r6.*.log`.
- Check r6: 5+5 seeds came from imports, but only 14 cards. Causes:
  - "Artist - Title" uploads failed title matching (also the "New Rules" duplicate)
  - NO_SEARCH_RESULTS counted as a failure
  - a fixed search count
- Fixes: compacted artist and title cleaning, an "Artist - " prefix split, reserve searches up to 48 that run only while the shelf is under 24 (SHELF_TARGET), and empty results that are not errors. Check r7: snapshot `slopify-recs-r7`, server 5203 PID 59584 (wrapper 18868), logs `%TEMP%\slopify-5203-r7.*.log`.
- Check r7: good. Home 25 cards and Find more 26 (48 and 45 searches), all searches done by ~15 s, no failure banner, no rate limits, no owned or duplicate songs, and Add & play works.
  - Open item: an extended "(Official Video - Live from …)" title was not cleaned. Fixed after r7: DECORATION now strips any "(Official …)" tag. Only a node regex check was run on that; Sol has not rechecked it.
  - "Paparazzi" remixes on SoundCloud may be two uploads of one remix; left as is (different URLs and durations).
- User follow-up: recommended songs should play like downloaded songs, in full rather than as a preview.
  - Added streamed tracks (`Track.stream`, ids `stream_<hash>`, not in trackIds, never persisted). The audio comes from the preview service, which already downloads the full file; it now keeps 12 files.
  - `actions.load` buffers and then plays; `prefetchNext` fetches ahead; liking or "Add to library" imports without interrupting playback (`savedStreams` keeps the heart in sync).
  - Library-style cards, a stream right-click menu, and a loading ring on the play buttons.
  - Check r8: snapshot `slopify-recs-r8`, server 5203 child PID 28060 (wrapper 57360), logs `%TEMP%\slopify-5203-r8.*.log`.
- User follow-up: remove the placeholder music. This edits the worktree only; r8 QA is still running on its own snapshot.
  - `buildCatalog` and the artist seeds are gone; `likedPlaylist()` remains.
  - The store starts empty and keeps only persisted tracks with a `serverId` (web imports). Starter playlists p1–p5 are dropped when empty, and `resetDemo` is renamed `resetAppData`.
  - `src/audio/synth.ts` is deleted; the engine has no SynthVoice, so a song without a file reports an error.
  - Genre mixes are removed: MixView, the mix route, `mixIds`/`mixNames`, Home "Made for you" and the Search genre tiles and banner.
  - Listen Along plays library recommendations.
  - Home hides empty shelves, keeps streamed songs out of library shelves, and has an empty-library "Import from Web" panel. Search lists only library artists and albums.
  - History stats show only real logged minutes (`recentDays` replaces `seededHistory`).
  - README and the design note are updated.
  - Pending: r8 results, then one combined QA on a new snapshot (r9).
- Check r8 (streaming): full songs play (228 s song, seeks past 30 s, about 1.9 s to start, 0.24 s for a prefetched next song); Play all, menus, save-while-playing and the failure path work. Three P2s, all fixed:
  - stream ids in persisted playlists: `addStreamsLater`, plus a filter in `flushPersist`
  - stuck `buffering` when switching songs: `load` clears it
  - bulk likes dropping saves: a serial `saveStreamToLibrary` queue
- Combined check r9 (r8 fixes plus demo removal): snapshot `slopify-recs-r9`, server 5203 child PID 64212 (wrapper 58468), logs `%TEMP%\slopify-5203-r9.*.log`.
- Check r9 stopped at the gate: TS2322 because Sidebar's Home match list still had "mix". Fixed, and also removed the fake artist metadata ("Verified artist", monthly listeners, the random genre button; RightPanel listeners/genre). Artist pages now list library songs and albums only. Check r9b: snapshot `slopify-recs-r9b`, server 5203 child PID 57492 (wrapper 52768), logs `%TEMP%\slopify-5203-r9b.*.log`.
- Check r9b: everything passed except a P2 (a second action on an already-queued save was dropped) and a P3 (subtitle copy). Both fixed: `queuedSaves` now holds a callback list, and the subtitle is updated. Targeted recheck r9c: snapshot `slopify-recs-r9c`, server 5203 child PID 64500 (wrapper 51748), logs `%TEMP%\slopify-5203-r9c.*.log`.
- Check r9c: good enough. A queued save with playlist + like + second playlist imports once and lands everywhere, and survives reloads. Copy is OK. Its P3 (stream ids briefly in persisted `listens`) is fixed by filtering stream ids in `flushPersist`; that one-line change was not rechecked by Sol.
- Done and handed back. 5203 (child PID 64500, wrapper 51748) still serves r9c; 5202 (PID 38900) is still the old audit r2 server. Commit or PR only if the user asks.
