# Slopify and Resonance

Slopify continues [Resonance](https://github.com/Drastics-Experiments/resonance), the Spotify-inspired music player. It began as a remaster of Resonance's desktop interface and grew into the next version of the app. That's why the package is still called `resonance-remastered`. As its own app, it starts again at version 0.0.1.

## Where it came from

Resonance is a cross-platform player. Windows and macOS share one Electron app (`windows/` in the Resonance repository), and iOS and Android have their own native apps. You build a library by importing songs from Spotify, SoundCloud and YouTube, or by adding your own audio files.

Slopify started from the Resonance desktop app. It rebuilds that app's interface as a React web app and keeps the parts that already worked.

## What carried over

- **Importing from the web.** Resonance's provider modules (search, YouTube and SoundCloud downloads, file naming) live on in `server/providers/`. They were copied from Resonance, then extended. Spotify search uses the same third-party search API that Resonance used, and Spotify songs are still matched to a YouTube source.
- **The screens.** Library, Playlists, Song Storage, Music Server, Now Playing, Clip Editor, Listening History, Listen Along, Import and Settings all come from Resonance, redesigned.
- **How things behave.** Several flows follow the original closely:
  - Saving a link works like Resonance's "Import from Web" dialog.
  - "Watch video" and "Return to Now Playing" work the same way.
  - The clip editor shows a real waveform and video frames.
  - Listening stats break down by hour and weekday.
  - Storage reports real disk space.
- **Desktop extras.** The tray icon, Discord status and crossfade all come from Resonance's desktop app.
- **Your music stays yours.** Your music server and playback still run on your own computer. Only the optional accounts, sync and Listen Along use Slopify's online service.

## What's new in Slopify

- **One app on every device.** The same web app runs as a desktop app (Electron) and as a server other devices can open. It can also be installed from the browser, including on a phone.
- **A library of links.** The server keeps each song's source link and metadata. Media is prepared when it's needed, and devices can keep their own offline copies.
- **Finding music.** Search covers YouTube, Spotify and SoundCloud. Results play in full right away, and YouTube videos stream as video.
- **Recommendations.** Home suggestions, mixes generated when the app opens, song and artist radio, artist pages and discographies.
- **Listening features.** Slip-ins (songs you pick, played now and then between your own choices) and an equalizer.
- **Accounts and sync.** Optional sign-in syncs your saved song links between computers. Audio files you added yourself stay on the computer they came from.

## What didn't come over

- The native iOS and Android apps. On phones, Slopify is installed from the browser.
- The macOS installer. Slopify's server and web app run on macOS and Linux, but only Windows installers are built for now (see [docs/windows-releases.md](docs/windows-releases.md)).

## Moving from Resonance

Slopify keeps its own library (`data/` by default; see the [README](README.md)) and doesn't read Resonance's library folder. To bring songs across, add the original links again through search, or add your audio files. Playlists have to be recreated.
