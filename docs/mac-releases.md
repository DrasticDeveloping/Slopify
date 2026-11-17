# Make Mac builds to share

On a Mac with Node 22.12 or newer, run these commands from the project folder:

```sh
npm ci
npm run dist:mac            # or dist:mac:nightly for a nightly
```

This builds the current interface and packages it with Electron, the local music server and FFmpeg, for both Apple silicon and Intel Macs. FFmpeg for the other kind of Mac is downloaded from the same ffmpeg-static release npm used, once, and kept in `build/desktop/`. The first build needs internet access to download the packaging tools and Electron for each kind of Mac. Recipients don't need Node, npm, FFmpeg or a separate server.

In T3, **Launch Slopify** (`npm run desktop`) runs the app straight from the thread's worktree instead, without packaging it.

## What to send

Each build goes in `release/<version>/`, next to the Windows files when both are built for the same version:

| File | Use |
| --- | --- |
| `Slopify-<version>-arm64.dmg` | For Apple silicon Macs (M1 and later). |
| `Slopify-<version>-x64.dmg` | For Intel Macs. |
| Matching `.dmg.sha256` files | SHA-256 checksums for checking that a file transferred correctly. |
| `Slopify-<version>-<arch>-mac.zip` | The app in a zip, which installed copies download to update. Only needed when publishing. |
| `latest-mac.yml` or `nightly-mac.yml`, and `.blockmap` | Update files. Only needed when publishing; don't send them. |
| `build-mac.json` | What was built: version, channel, update repo, Git commit, and the files. |

`npm run dist:mac:unpacked` makes just the app for this Mac, quickly, to try out; `release/unpacked-path.txt` says where it is. `--arch arm64` or `--arch x64` (`node scripts/package-mac.mjs --arch x64`) builds for one kind of Mac only.

## Opening it the first time

To install, open the DMG and drag Slopify onto Applications.

The app is signed *ad hoc*, not with an Apple Developer ID, so macOS doesn't recognise who made it. The first time, it refuses to open it ("Apple could not verify Slopify…"): choose **Done**, then open **System Settings → Privacy & Security**, and choose **Open Anyway** next to the message about Slopify. After that it opens normally, and updates don't ask again.

## Updates

The Mac app follows the same Stable and Nightly channels as Windows (see [docs/windows-releases.md](windows-releases.md)), from the same GitHub releases: each release has the Mac and Windows files. It checks 3 seconds after opening and every 10 minutes after that, downloads updates in the background, and installs them on restart. An update found as it opens installs straight away, and Slopify reopens on the new version.

Apple's own way of updating apps (Squirrel.Mac, which electron-updater uses) only installs apps signed with a Developer ID. So the Mac app installs updates itself (`desktop/mac-update.cjs`). It downloads the zip for this kind of Mac and checks it against the SHA-512 in `latest-mac.yml` or `nightly-mac.yml`. It then unpacks it, checks that it's the same app and that its signature is intact, and once Slopify has quit puts it in place of the app. An Intel copy running on Apple silicon moves to the Apple silicon app.

A copy that can't replace itself shows **Download** instead, like Windows' portable EXE, with a note to move it to Applications. This happens when it's still running from the DMG, was opened from Downloads without being moved (macOS then runs it from a hidden read-only copy), or is in a folder this account can't change.

To test updates without GitHub, build an older and a newer version with `SLOPIFY_UPDATE_REPO=test/test`, serve the newer one's `release/<version>/` folder over HTTP (`python3 -m http.server`), and open the older app with `SLOPIFY_UPDATE_FEED_URL` set to that address. Set `SLOPIFY_DESKTOP_DATA_DIR` and `SLOPIFY_DESKTOP_PORT` too, to keep it away from your own library. To pass these, start the app's executable (`Slopify.app/Contents/MacOS/Slopify`) from Terminal, or use `open -n -a Slopify.app --env NAME=value`. An older build unzipped into any folder you can write to updates the same way it would in Applications.

## Signing with a Developer ID

With an Apple Developer ID certificate, electron-builder signs the app with it instead: set `CSC_LINK` (the `.p12` file, or its base64) and `CSC_KEY_PASSWORD`, or `CSC_NAME` for one in the keychain. Set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` as well to notarize it, which removes the Open Anyway step. The release workflow doesn't do this yet; it would need those as Actions secrets. Updates install the same way either way.

## Where recipient data lives

The library and browser storage live in `~/Library/Application Support/Slopify`, outside the app, so replacing or updating the app keeps them. Startup details are written to `desktop.log` there. Like on Windows, the app's music server listens on `http://127.0.0.1:5198`.

## In the app

The Mac app has the usual menu bar: **Slopify → Settings…** (⌘,), Edit, View and Window. ⌘W closes the window and ⌘Q quits. With **Keep playing when closed** on, closing the window keeps the music going, with Slopify's icon in the menu bar (play/pause, next, previous, quit) and in the Dock. The shortcut list in Settings, and the hints around the app, show ⌘ and ⌥ instead of Ctrl and Alt.
