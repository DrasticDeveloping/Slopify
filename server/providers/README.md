# Provider modules

Ported unchanged (apart from the user agent string) from the Resonance desktop app's main process
(`windows/*.cjs` in https://github.com/Drastics-Experiments/resonance). They handle Spotify,
SoundCloud and YouTube search, link resolution, source matching, downloads, and ffmpeg tagging.
`../api.mjs` exposes them to the web UI over HTTP.
