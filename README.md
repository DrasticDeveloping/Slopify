# Proof for PR #70

Media and logs for https://github.com/DrasticDeveloping/Slopify/pull/70. Not part of the app.

- **App:** the real portable EXE from `node scripts/package-windows.mjs --channel nightly` at PR head `967c74e`
  (version `0.0.4-nightly.20261117.2109.12628`), with isolated data (`SLOPIFY_DESKTOP_DATA_DIR`), signed out, muted.
- **Releases:** GitHub was replaced by `harness/fake-github.mjs` (a local HTTPS server) using Chromium's
  `--host-resolver-rules` + `--ignore-certificate-errors`, so test releases could be published without touching
  the real repo. Its notes use the exact format `scripts/publish-release.mjs` writes.
  - "phone" scenario: a newer nightly marked `<!-- Platforms: mobile -->`, then the installed version.
  - "desktop" scenario: adds a newer nightly marked `<!-- Platforms: desktop mobile -->`.
- **Driving:** `harness/drive.mjs` over the app's DevTools port: screenshots, frames for the video, and the app's own
  update state (`window.slopifyDesktop.updates.get()`). The yellow captions are drawn by the harness.
- `fake-github-requests.log`: every request the app made. `app-update-log.txt`: the app's `[updates]` log lines.
- `publish-dry-run.txt`: the real publish script against the real repo, with release creation intercepted.
