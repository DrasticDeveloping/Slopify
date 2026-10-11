<img src="assets/icon.svg" width="64" height="64" alt="">

# Slopify — Resonance Remastered

A redesigned, web-based UI for [Resonance](https://github.com/Drastics-Experiments/resonance), the Spotify-inspired music player. It reimagines the old Electron desktop UI (Library, Playlists, Song Storage, Music Server, Now Playing, Clip Editor, Listening History, Listen Along, Import, Settings) as a smoother React app.

Everything runs locally with a mock library. Each sample song is generated live with the Web Audio API, so playback, seeking, speed, crossfade, clip ranges, and the visualizer all work without any audio files. You can also drop your own audio files in to play them.

```bash
npm install
npm run dev      # http://localhost:5199
npm run build    # type-check and production build
npm run preview  # serve the production build on :5199
```

## Import from Web

**Import music → Import from Web** works like it did in Resonance. You can paste a Spotify, SoundCloud, or YouTube link (track or playlist), or search all three. Then you can preview a result for 30 seconds and download it in the background.

- **Server:** the import API runs inside the Vite dev/preview server (`server/api.mjs`) and reuses Resonance's provider modules (`server/providers`).
- **Storage:** downloaded songs and their artwork are saved under `data/`. You can override that location with `SLOPIFY_DATA_DIR`.
- **Spotify:** Spotify songs are matched to a YouTube audio source. Spotify search goes through the same third-party search API (`debridvault.elfhosted.com`) that Resonance used.
- **Static builds:** a static `dist/` build without the dev/preview server can't import from the web, but local files still work.

Created in [T3 Code](https://t3.codes).
