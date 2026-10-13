<img src="assets/icon.svg" width="64" height="64" alt="">

# Slopify — Resonance Remastered

A redesigned, web-based UI for [Resonance](https://github.com/Drastics-Experiments/resonance), the Spotify-inspired music player. It reimagines the old Electron desktop UI (Library, Playlists, Song Storage, Music Server, Now Playing, Clip Editor, Listening History, Listen Along, Import, Settings) as a smoother React app. See [RESONANCE.md](RESONANCE.md) for how Slopify continues Resonance: what carried over, what's new, and what didn't come over.

Everything runs locally. The library starts empty: import songs or whole playlists from Spotify, SoundCloud or YouTube, or drop your own audio files in. Home → Recommended for you then suggests new songs, which play in full straight away (see [docs/recommendations.md](docs/recommendations.md)).

```bash
npm install
npm run build    # type-check and production build
npm run desktop  # build, then open Slopify in its own app window
npm start        # or run it as a server for other devices: http://127.0.0.1:5199
npm run dev      # development server with hot reload, also on :5199
```

`npm start` runs Slopify as one Node program (`server/main.mjs`): it serves the built web app and its backend together, with no Vite at runtime. The backend handles everything that touches the computer (library files, downloads, ffmpeg), so the same web app works on Windows, macOS and Linux. Options:

| Flag | Environment | Default | |
|---|---|---|---|
| `--port` | `PORT` | `5199` | |
| `--host` | `HOST` | `127.0.0.1` | `0.0.0.0` shares Slopify on your local network |
| `--data` | `SLOPIFY_DATA_DIR` | `data/` in the app folder | where your library is kept |

For example: `npm start -- --port 5253`.

`npm run desktop` opens Slopify as a desktop app (Electron), in its own window with its own title bar, like Discord or T3 Code, not in a browser. Run from a checkout, it uses that checkout's `data/` library on port 5197, separate from an installed copy. Clicking Launch again while it's open brings the window forward. Closing the window keeps Slopify playing in the system tray (right-click the tray icon to quit), and it can show what you're playing on Discord; both are in **Settings → General**.

In T3, **Launch Slopify** runs `npm.cmd run desktop`. **Build Windows EXEs** and **Build nightly EXEs** make the files to send to people (see below).

With the app already built, `node server/main.mjs --open` also opens the Electron desktop window. It does not open a browser or start the standalone server on port 5199. Use `--port` and `--data` with `--open` to override the desktop port and library folder; the desktop always listens on this computer only. Without `--open`, the command still runs the standalone server for other devices. If `dist/` is missing, run `npm.cmd run build` first.

## Install Slopify

For a Windows desktop app you can send to someone, run `npm.cmd run dist:win` (or `npm.cmd run dist:win:nightly` for a nightly). It produces a portable EXE and an installer in `release/<version>/`, with the backend and FFmpeg included. Installed copies update themselves from Stable or Nightly, chosen in **Settings → General**. See [the Windows release process](docs/windows-releases.md) for setup, sharing, and updates.

Source and desktop releases share the public `DrasticDeveloping/Slopify` repository. The Release workflow uses GitHub's built-in token: manual runs can keep artifacts without publishing, and the 09:00 UTC schedule publishes a Nightly when `master` has changed.

Build once with `npm run build`, then run `npm start`. Open Slopify in Chrome or Edge and choose **Install Slopify** from the profile menu, or **Settings → General → Install**. The browser also offers its own install option. On iPhone or iPad, use **Share → Add to Home Screen**.

The installed app opens in its own window. Its interface and files kept on the device work offline after the first successful online load. Finding new music, saving new links, and syncing need the server. Closing the installed web app stops playback; the tray and Discord status are only in the desktop app.

Updates show an **Update** prompt instead of interrupting playback. Choose it when ready to restart; your library and playlists are saved before restarting. Each production build generates a versioned offline shell automatically. The shell cache never stores API responses or media, and updates preserve the separate device-song cache.

Installation requires HTTPS when hosted remotely; `localhost` and `127.0.0.1` also work. Keep a stable address and port: browser libraries and device files belong to that address. The development server is for editing; use `npm start` to test offline behavior.

## Saving music and the music server

Use the search bar or **Find music** to search Spotify, SoundCloud, and YouTube, or paste a song or playlist link. Results play in full; **Save** adds a song to your library. YouTube songs can be saved as audio or video.

- **Server:** the backend (`server/api.mjs`) runs in `npm start`, or inside the Vite dev server while developing, and reuses Resonance's provider modules (`server/providers`).
- **Storage:** `data/songs.json` stores source links and metadata, including audio/video mode, clips, and extensible `extra` fields. `data/library-state.json` stores playlists, likes, listening history, recommendation feedback, and listener settings. `SLOPIFY_DATA_DIR` overrides this location.
- **Media:** audio/video files are prepared temporarily outside `data/`, with bounded cache limits and idle expiry. The server releases them once a device verifies its copy. Artwork may be kept as a small image file.
- **Device copies:** Settings → Server → Keep songs on this device controls browser Cache Storage. Kept songs play without the server; removing a device copy preserves the server link. Deleting from the library removes the shared song after the Undo window.
- **Sync:** connection status uses the backend health check. Library data merges automatically and **Sync library** refreshes it immediately. Clip edits made offline retry on reconnect. Device download preferences stay on the device.
- **Existing libraries:** the first run migrates `library.json` into link records and keeps a backup. Old media is retained until a device verifies its copy; records without a source link retain their old file to avoid losing existing songs.
- **Spotify:** Spotify songs are matched to a YouTube audio source. Spotify search goes through the same third-party search API (`debridvault.elfhosted.com`) that Resonance used.
- **Static builds:** use `npm start` for the backend and production app together. A static `dist/` deployment alone cannot save links or sync; files already kept on the device still play.

Created in [T3 Code](https://t3.codes).
