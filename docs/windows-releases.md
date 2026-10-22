# Make Windows builds to share

On a Windows x64 computer with Node 22.12 or newer, run these commands from the project folder. In PowerShell, use `npm.cmd` to avoid blocked PowerShell shims.

```powershell
npm.cmd ci
npm.cmd run dist:win
```

In this T3 project, **Build Windows EXEs** in the project action dropdown runs the same build command, and **Build nightly EXEs** runs `npm.cmd run dist:win:nightly`. Use them from this checkout after installing dependencies.

The second command builds the current interface and packages it with Electron, the local music server, and FFmpeg. The first build needs internet access to download the packaging tools. Recipients do not need Node, npm, FFmpeg, or a separate server.

## What to send

Each build goes in its own folder, `release/<version>/` (for example `release/0.0.1/` or `release/0.0.2-nightly.20261012.930/`):

| File | Use |
| --- | --- |
| `Slopify-<version>-x64-Portable.exe` | Send this single file for a no-install app. Double-click it to open Slopify. |
| `Slopify-<version>-x64-Setup.exe` | An installer with a destination choice and desktop shortcut. Installs for the current user, and updates itself. |
| Matching `.exe.sha256` files | SHA-256 checksums for checking that a file transferred correctly. |
| `latest.yml` or `nightly.yml`, and `.blockmap` | Update files. Only needed when publishing a release; don't send them. |
| `build.json` | What was built: version, channel, update repo, and Git commit. |

`release/last-build.json` points to the newest build, and `release/unpacked-path.txt` to the temporary unpacked app from `dist:win:unpacked` (its EXE needs the surrounding files; don't send it alone).

Choose **one** of the two distribution EXEs. Both open the same app in its own window and start its backend automatically. Closing the app stops its backend. Launching it again focuses the existing window.

Your development library, saved songs, playlists, logs, environment files, and credentials are not included. Each recipient starts with an empty library and can save their own music. The package does include FFmpeg's license and build/source information under `resources/licenses/`.

## Updates: Stable and Nightly

Slopify updates work like T3 Code's nightly builds. There are two channels:

- **Stable** follows normal releases, numbered from `package.json` (`0.0.1`).
- **Nightly** also gets nightly builds, made as often as every night. A nightly is numbered from the next patch version plus the UTC date and time it was built, like `0.0.2-nightly.20261012.930`. The final numeric identifier records seconds and milliseconds, so builds within a minute also sort correctly. Every nightly sorts after the one before it and before the stable `0.0.2`. When `0.0.2` ships, nightly users move to it, then on to the `0.0.3` nightlies.

People choose their channel in **Settings → General → Update channel**. A nightly build starts on Nightly, and a stable build starts on Stable. Moving from Nightly to Stable installs the newest stable release, even if its version is older than the nightly they're running.

The installed app checks 10 seconds after opening and every 4 hours after that. It downloads updates in the background, then offers **Restart**. It also installs the update the next time Slopify is closed. The portable EXE can't replace itself, so it shows a **Download** link to the new release instead.

### Discord status

The desktop app can show "Listening to Slopify" with the song on people's Discord profiles, through the Discord app on the same computer. Discord shows the name of a Discord *application*, which you create once:

1. Go to <https://discord.com/developers/applications>, choose **New Application**, and name it **Slopify**. Optionally give it Slopify's icon.
2. Copy its **Application ID** into `release.config.json` as `"discordClientId": "123…"`, and build again.

Builds without an id work normally; Settings explains that this copy can't show a Discord status. For a quick test without rebuilding, set `SLOPIFY_DISCORD_CLIENT_ID` before launching.

### Where updates come from

Installed copies check public GitHub Releases on **[DrasticDeveloping/Slopify](https://github.com/DrasticDeveloping/Slopify/releases)**, the same repository that holds the source. `release.config.json` names it as `updateRepo`; packaged `resources/app-update.yml` records `owner: DrasticDeveloping` and `repo: Slopify`. Until the first release is published, Settings reports that no releases are available. Older builds without an update source need to be replaced once.

Actions publishes with the built-in `GITHUB_TOKEN`. Only the workflow's separate publish job gets `contents: write`; the build itself runs with read-only access. No personal access token or Actions secret is needed. The workflow sets the package's update repository to `github.repository`.

### Publish the first Stable and Nightly

The initial Stable uses package.json's current version, `0.0.1`. Run these commands when ready to publish, waiting for the first run to finish before starting the second:

```powershell
gh workflow run release.yml --repo DrasticDeveloping/Slopify --ref master -f channel=stable -f publish=true
gh workflow run release.yml --repo DrasticDeveloping/Slopify --ref master -f channel=nightly -f publish=true
```

For a build artifact only, use `-f channel=nightly -f publish=false`. Manual runs default to publishing disabled. For subsequent Stable releases, update package.json and package-lock.json together with `npm.cmd version patch --no-git-tag-version`, then commit and merge that version before dispatching.

Stable builds include both `latest.yml` and `nightly.yml`; Nightly builds include `nightly.yml`. The Nightly GitHub provider selects the highest Stable or Nightly version, while Stable follows GitHub's latest stable release. A saved development preference of `"beta"` is read as Nightly.

### Publishing a local build

Publishing uses the [GitHub CLI](https://cli.github.com), signed in with `gh auth login`:

```powershell
npm.cmd run release:nightly     # build a nightly and publish it as a pre-release
npm.cmd run release:stable   # build package.json's version and publish it as the latest release
```

Each command builds first, then runs `node scripts/publish-release.mjs`, which uploads `release/last-build.json`'s files as a GitHub release named for its version (`v0.0.2-nightly.20261012.930`). Publishing refuses a version that's already released, and a build without an update repo. To publish a build you've already made and tested, run `node scripts/publish-release.mjs` on its own.

Before a stable release, raise the version: `npm.cmd version patch --no-git-tag-version`.

### Testing updates without GitHub

Build an older and a newer version with any `updateRepo` set (for example `SLOPIFY_UPDATE_REPO=test/test`), so both include update files. Serve the newer build's `release/<version>/` folder over HTTP, then launch the older installed copy with `SLOPIFY_UPDATE_FEED_URL` set to that address. It then reads `nightly.yml` or `latest.yml` from there instead of GitHub. This is a test override; normal builds never need it.

### Automatic Nightly builds

`.github/workflows/release.yml` builds Slopify on GitHub's Windows machines:

- **Every night at 09:00 UTC**, once nightlies are switched on, it builds a nightly of `master` and publishes it. It skips the build when `master` hasn't changed since the last nightly, using the `Source:` commit in each release's notes.
- **On demand**, from Actions → Release → Run workflow, it builds a nightly or stable release from any branch.

The workflow needs the work committed and pushed. Manual runs default to publishing disabled and retain a downloadable `slopify-windows-nightly` or `slopify-windows-stable` artifact for 14 days. GitHub-hosted Actions runners are free for this public repository.

Nightlies are off until you switch them on, so nothing is published on a schedule before you're ready. To switch them on, set the repository variable (**Settings → Secrets and variables → Actions → Variables**, or the command below); to pause them, set it to anything else or delete it:

```powershell
gh variable set SLOPIFY_PUBLISH_NIGHTLIES --repo DrasticDeveloping/Slopify --body true
```

Once on, the schedule can publish the first Nightly without a previous release: an empty release list does not skip the build. Subsequent unchanged nights skip packaging. Releases are tagged at the exact clean source commit recorded in `build.json`, rather than whichever commit happens to be the default branch tip when publishing. Local publishing rejects dirty builds; commit and push the source, then rebuild before publishing.

## Build again after changes

```powershell
# Optional: give this release a new version, without making a Git commit or tag.
npm.cmd version patch --no-git-tag-version
npm.cmd run dist:win
```

For only the portable EXE, use `npm.cmd run dist:win:portable`. For a quick package to test locally, use `npm.cmd run dist:win:unpacked`. `npm.cmd run desktop` rebuilds the UI and runs the desktop app directly from this checkout.

The package versions are pinned in `package-lock.json`. Packaging is restricted to Windows x64 so the bundled FFmpeg matches the target. Each build uses a fresh temporary folder to avoid overwriting running executables. Finished builds go into `release/<version>/`; unpacked test builds remain at the path in `release/unpacked-path.txt`. Generated `release/` and `build/desktop/` folders are ignored by Git. Building never uploads anything; only the `release:*` commands and the workflow publish.

## Where recipient data lives

Both builds keep their library and browser storage in `%APPDATA%\Slopify`, outside the installation or portable extraction folder. Replacing a portable EXE or installing a newer build keeps that data. The installer is configured to retain it on uninstall as well.

The desktop app uses `http://127.0.0.1:5198` internally, separate from the web app's default port 5199. It does not import your existing development library automatically. If another program occupies its port, it shows a startup error rather than opening that program. Startup details are written to `%APPDATA%\Slopify\desktop.log`.

These builds are unsigned, which doesn't stop updates from working. Code signing for releases from a verified publisher is a separate step; no signing certificate is required to create the files.

## Local verification

Test the actual packaged app, not just the development server. A release check should cover startup, saving a playlist, two reloads, closing and reopening, playback, and backend shutdown. Also check that `resources/bin/ffmpeg.exe` exists and the package contains no development data.

For local-file playback checks, allow the detected duration to appear before clicking Play. QA observed an immediate-play timing issue during WAV metadata loading; replay after metadata was ready worked. This is separate from packaging.

For isolated QA, set `SLOPIFY_DESKTOP_DATA_DIR` to an empty temporary folder and `SLOPIFY_DESKTOP_PORT` to an unused port **before launching** the EXE. Keep the same directory and port across reopen tests. These are test overrides; normal recipients do not need to set them. Native Electron tests can use Playwright's `_electron.launch` with the packaged EXE and those environment overrides. T3 helpers inherit `ELECTRON_RUN_AS_NODE`; remove it from the test process's environment so Electron opens its window.
